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
        # num_speakers lives at the top of the config for newer voices and
        # nested under audio/inference for older ones — try both, fall back to 1.
        num_speakers = (
            meta.get("num_speakers")
            or (meta.get("inference") or {}).get("num_speakers")
            or 1
        )
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
                num_speakers=int(num_speakers),
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
    """Synthesize one sentence. Returns (wav_bytes, frames, sample_rate).

    Defensive against Piper's `synthesize_wav` occasionally returning
    without calling `setnchannels` on the wave handle (happens on inputs
    where the text-frontend produces no phonemes — e.g. a sentence that
    after Piper's own cleaning is just punctuation). Without pre-set
    params, the `with wave.open` exit would raise
    `wave.Error: # channels not specified` and abort the whole chapter.
    We pre-initialize sane defaults (mono, 16-bit, voice's sample rate)
    so even a no-audio result yields a valid empty WAV.
    """
    # Piper's voice config exposes sample_rate; fall back to 22050 (the
    # default for all the en_US/en_GB Piper models we ship).
    voice_sr = getattr(getattr(voice, "config", None), "sample_rate", 22050)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(voice_sr)
        voice.synthesize_wav(text, wf, syn_config=syn_cfg)
    data = buf.getvalue()
    with wave.open(io.BytesIO(data), "rb") as r:
        return data, r.getnframes(), r.getframerate()


def synthesize_iter(
    text: str,
    voice_id: str,
    rate: int | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
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
        speaker_id=speaker_id,
    )

    total = len(sentences)
    wavs: list[bytes] = []
    offsets_ms: list[int] = []
    cumulative_frames = 0
    sample_rate = 0

    for i, sentence in enumerate(sentences):
        # Acquire and release the lock per-sentence so we yield progress
        # between sentences without holding the lock idle.
        try:
            with _synth_lock:
                data, frames, sr = _synth_one(voice, sentence, syn_cfg)
        except Exception as exc:
            # One bad sentence shouldn't abort the whole chapter — log it
            # for diagnosis and fall back to a zero-frame placeholder so
            # the rest of the synthesis continues and the offsets array
            # stays aligned with sentence indexes. The user gets silence
            # where that sentence would have been but the audio doesn't
            # die mid-listen.
            import sys as _sys
            import traceback as _tb
            print(
                f"[piper] sentence {i}/{total} synth failed: {exc!r}",
                file=_sys.stderr, flush=True,
            )
            print(f"  text: {sentence!r}", file=_sys.stderr, flush=True)
            _tb.print_exc()
            data, frames, sr = _silent_wav(sample_rate or 22050)
        if sample_rate == 0:
            sample_rate = sr
        # v225fz9 (#675): pad each sentence WAV with trailing silence
        # so periods get an audible pause. Padding the per-sentence WAV
        # (not the concat) means BOTH the streamed-to-client copy AND
        # the combined-WAV result include the gap, with no client-side
        # changes. We add the silence frames to `cumulative_frames`
        # before recording the offset so sentence N+1's start time
        # accounts for the pause that follows sentence N. Last sentence
        # also gets padded — harmless trailing silence at end of clip.
        data, silence_frames = _pad_wav_trailing_silence(data, SENTENCE_PAUSE_MS)
        offset_ms = int(cumulative_frames * 1000 / sr)
        offsets_ms.append(offset_ms)
        cumulative_frames += frames + silence_frames
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
    speaker_id: int | None = None,
):
    import base64
    from . import SynthesisResult

    for event in synthesize_iter(
        text, voice_id, rate=rate, volume=volume, speaker_id=speaker_id
    ):
        if event["type"] == "result":
            return SynthesisResult(
                wav=base64.b64decode(event["wav_b64"]),
                sentence_offsets_ms=event["sentence_offsets_ms"],
            )
    raise RuntimeError("synthesize_iter produced no result")


def _silent_wav(sample_rate: int) -> tuple[bytes, int, int]:
    """Return a zero-frame valid mono WAV at the given sample rate.

    Used as a placeholder when a single sentence synth fails so the rest
    of the chapter can continue. Frame count is 0 (lengthless silence) so
    seek math, cumulative offsets, and downstream MP3 encoding all behave.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        # No writeframes — header-only WAV. lameenc / browsers handle
        # zero-length PCM as silence.
    return buf.getvalue(), 0, sample_rate


# v225fz9 (#675): default trailing silence appended to each per-sentence
# WAV. Both Piper and Kokoro produce minimal end-of-utterance decay, and
# the concat path stitches frame-to-frame with no gap, so without this
# pad the listener hears "world.This" instead of "world. This." 250 ms
# is a natural sentence-break length — long enough to register as a
# pause, short enough not to feel like the reader stalled. Future
# refinement (#483): per-period vs per-paragraph length, voice-aware
# tuning. For now: one constant, applied uniformly.
SENTENCE_PAUSE_MS = 250


def _pad_wav_trailing_silence(wav_bytes: bytes, silence_ms: int) -> tuple[bytes, int]:
    """Append `silence_ms` of mono silence to a WAV blob.

    Returns the new WAV bytes plus the number of silence frames added
    (caller must include those in cumulative_frames so sentence offsets
    stay in sync with the audible content). Round-trips through the wave
    module so the output is a valid WAV with a coherent header rather
    than raw PCM tacked on.
    """
    if silence_ms <= 0:
        # Defensive — count silence frames as 0 even if a caller passes
        # something nonsensical.
        return wav_bytes, 0
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as src:
            params = src.getparams()
            frames = src.readframes(src.getnframes())
            sample_rate = src.getframerate()
            sample_width = src.getsampwidth()
            n_channels = src.getnchannels()
    except wave.Error:
        # Malformed input (e.g. the zero-frame placeholder from
        # _silent_wav). Return unchanged — adding silence to silence
        # would just bloat the placeholder for no listener benefit.
        return wav_bytes, 0
    n_silence_frames = int(sample_rate * silence_ms / 1000)
    silence = b"\x00" * (n_silence_frames * sample_width * n_channels)
    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setparams(params)
        dst.writeframes(frames + silence)
    return out.getvalue(), n_silence_frames


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
