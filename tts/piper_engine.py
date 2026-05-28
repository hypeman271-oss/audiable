"""Neural TTS via piper-tts. Voices are .onnx models under voices/.

Voice IDs are "piper:<locale>-<name>-<quality>", e.g.
"piper:en_US-amy-medium". The trailing portion matches the on-disk
filename so the loader can find the model + config pair.

Models are loaded lazily on first use and cached in-process. Each model
is ~30-100MB so we don't preload everything at startup; the first
synthesis for a given voice will take an extra second.
"""

from __future__ import annotations

import io
import json
import threading
import wave
from pathlib import Path

from piper import PiperVoice
from piper.config import SynthesisConfig

VOICES_DIR = Path(__file__).resolve().parent.parent / "voices"
_PREFIX = "piper:"

# Piper voice objects are not thread-safe — onnxruntime sessions can race
# on the input feed. Serialize synthesis per-process.
_synth_lock = threading.Lock()
_cache: dict[str, PiperVoice] = {}


def _voice_files() -> list[tuple[str, Path, Path]]:
    if not VOICES_DIR.exists():
        return []
    out: list[tuple[str, Path, Path]] = []
    for onnx in sorted(VOICES_DIR.glob("*.onnx")):
        cfg = onnx.with_suffix(".onnx.json")
        if cfg.exists():
            out.append((onnx.stem, onnx, cfg))
    return out


def _read_meta(cfg_path: Path) -> dict:
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def list_voices():
    from . import Voice

    out = []
    for suffix, _onnx, cfg in _voice_files():
        meta = _read_meta(cfg)
        lang_info = meta.get("language") or {}
        lang_code = lang_info.get("code") or ""
        lang_native = lang_info.get("name_native") or lang_info.get("name_english") or ""
        languages = [x for x in (lang_code, lang_native) if x]
        try:
            locale, name, quality = suffix.split("-")
            pretty = f"{name.title()} ({locale}, {quality})"
        except ValueError:
            pretty = suffix
        out.append(
            Voice(
                id=f"{_PREFIX}{suffix}",
                name=pretty,
                languages=languages,
                gender=None,
                engine="piper",
            )
        )
    return out


def _load(voice_id: str) -> PiperVoice:
    suffix = voice_id[len(_PREFIX):] if voice_id.startswith(_PREFIX) else voice_id
    if suffix in _cache:
        return _cache[suffix]
    onnx = VOICES_DIR / f"{suffix}.onnx"
    cfg = onnx.with_suffix(".onnx.json")
    if not onnx.exists() or not cfg.exists():
        raise FileNotFoundError(
            f"Piper voice {suffix!r} not installed. "
            f"Run: python scripts/get_voice.py {suffix}"
        )
    voice = PiperVoice.load(str(onnx), str(cfg))
    _cache[suffix] = voice
    return voice


def _synth_one(voice: PiperVoice, text: str, syn_cfg: SynthesisConfig) -> tuple[bytes, int, int]:
    """Synthesize one sentence. Returns (wav_bytes, frames, sample_rate)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf, syn_config=syn_cfg)
    data = buf.getvalue()
    with wave.open(io.BytesIO(data), "rb") as r:
        return data, r.getnframes(), r.getframerate()


def synthesize_iter(
    text: str,
    voice_id: str,
    rate: int | None = None,
    volume: float | None = None,
):
    """Generator: yields one sentence event per finished sentence, then a result event.

    Sentence: {"type": "sentence", "index": i, "total": N,
               "offset_ms": int, "wav_b64": str}   # WAV for *just this sentence*
    Result:   {"type": "result", "wav_b64": str,   # full concatenated WAV
               "sentence_offsets_ms": list[int]}

    The frontend streams playback by enqueueing per-sentence WAVs as they
    arrive, then swaps to the combined result WAV once synthesis finishes
    so seek / download / library save work normally.
    """
    import base64
    from . import split_sentences

    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("text is empty")

    voice = _load(voice_id)

    # UI's "rate" is words-per-minute centered on 180 (matching SAPI's scale).
    # Piper's length_scale: 1.0 = normal, <1 faster, >1 slower.
    length_scale = None
    if rate:
        length_scale = max(0.5, min(2.0, 180.0 / rate))

    syn_cfg = SynthesisConfig(
        length_scale=length_scale,
        volume=volume if volume is not None else 1.0,
        normalize_audio=True,
    )

    total = len(sentences)
    wavs: list[bytes] = []
    offsets_ms: list[int] = []
    cumulative_frames = 0
    sample_rate = 0

    for i, sentence in enumerate(sentences):
        # Acquire and release the lock per-sentence so we yield progress
        # between sentences without holding the lock idle.
        with _synth_lock:
            data, frames, sr = _synth_one(voice, sentence, syn_cfg)
        if sample_rate == 0:
            sample_rate = sr
        offset_ms = int(cumulative_frames * 1000 / sr)
        offsets_ms.append(offset_ms)
        cumulative_frames += frames
        wavs.append(data)
        yield {
            "type": "sentence",
            "index": i,
            "total": total,
            "offset_ms": offset_ms,
            "wav_b64": base64.b64encode(data).decode(),
        }

    yield {
        "type": "result",
        "wav_b64": base64.b64encode(_concat_wavs(wavs)).decode(),
        "sentence_offsets_ms": offsets_ms,
    }


def synthesize(
    text: str,
    voice_id: str,
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


def _concat_wavs(wav_blobs: list[bytes]) -> bytes:
    """Concatenate WAV byte blobs that share the same format."""
    if not wav_blobs:
        return b""
    if len(wav_blobs) == 1:
        return wav_blobs[0]

    out_buf = io.BytesIO()
    with wave.open(io.BytesIO(wav_blobs[0]), "rb") as first:
        params = first.getparams()
        with wave.open(out_buf, "wb") as out:
            out.setparams(params)
            out.writeframes(first.readframes(first.getnframes()))
            for blob in wav_blobs[1:]:
                with wave.open(io.BytesIO(blob), "rb") as w:
                    out.writeframes(w.readframes(w.getnframes()))
    return out_buf.getvalue()
