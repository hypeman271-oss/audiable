"""OS-native TTS via pyttsx3 (Windows SAPI / macOS NSSpeech / espeak)."""

from __future__ import annotations

import io
import tempfile
import threading
import wave
from pathlib import Path

import pyttsx3

# pyttsx3 keeps internal state that doesn't survive concurrent calls well,
# so every synthesis happens behind this lock with a freshly built engine.
_engine_lock = threading.Lock()


def _build_engine(voice_id: str | None, rate: int | None, volume: float | None):
    engine = pyttsx3.init()
    if voice_id:
        engine.setProperty("voice", voice_id)
    if rate is not None:
        engine.setProperty("rate", rate)
    if volume is not None:
        engine.setProperty("volume", max(0.0, min(1.0, volume)))
    return engine


def list_voices():
    from . import Voice

    with _engine_lock:
        engine = pyttsx3.init()
        out: list[Voice] = []
        for v in engine.getProperty("voices"):
            langs: list[str] = []
            for lang in getattr(v, "languages", []) or []:
                if isinstance(lang, bytes):
                    try:
                        langs.append(lang.decode("utf-8", errors="ignore").strip("\x00 "))
                    except Exception:
                        pass
                elif isinstance(lang, str):
                    langs.append(lang)
            out.append(
                Voice(
                    id=v.id,
                    name=getattr(v, "name", v.id),
                    languages=[l for l in langs if l],
                    gender=getattr(v, "gender", None),
                    engine="sapi",
                )
            )
        engine.stop()
        return out


def _wav_duration_frames(path: Path) -> tuple[int, int]:
    with wave.open(str(path), "rb") as w:
        return w.getnframes(), w.getframerate()


def _concat_wavs(paths: list[Path]) -> bytes:
    if not paths:
        return b""
    if len(paths) == 1:
        return paths[0].read_bytes()

    buffer = io.BytesIO()
    with wave.open(str(paths[0]), "rb") as first:
        params = first.getparams()
        with wave.open(buffer, "wb") as out:
            out.setparams(params)
            out.writeframes(first.readframes(first.getnframes()))
            for p in paths[1:]:
                with wave.open(str(p), "rb") as w:
                    out.writeframes(w.readframes(w.getnframes()))
    return buffer.getvalue()


def synthesize_iter(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
):
    """Generator: yields one sentence event per finished sentence, then a result event.

    Sentence: {"type": "sentence", "index": i, "total": N,
               "offset_ms": int, "wav_b64": str}   # WAV for *just this sentence*
    Result:   {"type": "result", "wav_b64": str,   # full concatenated WAV
               "sentence_offsets_ms": list[int]}

    For empty SAPI chunks (silent / failed), wav_b64 is "" so the frontend
    can skip without breaking sentence-index alignment.
    """
    import base64
    from . import split_sentences

    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("text is empty")

    total = len(sentences)

    # The temporary directory must outlive the final yield (it's where the WAV
    # chunks live until we concatenate them). Yield the result inside the
    # context manager so the files are still available at concat time.
    with tempfile.TemporaryDirectory(prefix="audiable_") as tmp:
        tmp_path = Path(tmp)
        wav_paths: list[Path] = []
        # Track offsets in frames so we don't need to know sample_rate until
        # we've seen at least one successful chunk.
        offsets_frames: list[int] = []
        cumulative_frames = 0
        sample_rate = 0

        for i, sentence in enumerate(sentences):
            wav_path = tmp_path / f"chunk_{i:04d}.wav"
            # Acquire and release the lock per-sentence so we can yield
            # events between sentences.
            with _engine_lock:
                engine = _build_engine(voice_id, rate, volume)
                engine.save_to_file(sentence, str(wav_path))
                engine.runAndWait()
                engine.stop()
            offsets_frames.append(cumulative_frames)
            sentence_b64 = ""
            if wav_path.exists() and wav_path.stat().st_size > 0:
                frames, sr = _wav_duration_frames(wav_path)
                if sample_rate == 0:
                    sample_rate = sr
                sentence_b64 = base64.b64encode(wav_path.read_bytes()).decode()
                # Compute offset BEFORE adding this sentence's frames.
                offset_ms = int(cumulative_frames * 1000 / sample_rate)
                cumulative_frames += frames
                wav_paths.append(wav_path)
            else:
                # Empty sentence — offset is whatever it would have been; if we
                # don't know sample_rate yet, fall back to 0.
                offset_ms = int(cumulative_frames * 1000 / sample_rate) if sample_rate else 0
            yield {
                "type": "sentence",
                "index": i,
                "total": total,
                "offset_ms": offset_ms,
                "wav_b64": sentence_b64,
            }

        offsets_ms = (
            [int(f * 1000 / sample_rate) for f in offsets_frames]
            if sample_rate
            else [0] * len(offsets_frames)
        )
        yield {
            "type": "result",
            "wav_b64": base64.b64encode(_concat_wavs(wav_paths)).decode(),
            "sentence_offsets_ms": offsets_ms,
        }


def synthesize(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
):
    import base64
    from . import SynthesisResult

    for event in synthesize_iter(text, voice_id, rate=rate, volume=volume):
        if event["type"] == "result":
            return SynthesisResult(
                wav=base64.b64decode(event["wav_b64"]),
                sentence_offsets_ms=event["sentence_offsets_ms"],
            )
    raise RuntimeError("synthesize_iter produced no result")
