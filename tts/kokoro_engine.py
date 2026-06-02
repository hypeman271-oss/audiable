"""Neural TTS via kokoro-onnx — Apache 2.0 model + weights.

Kokoro is structured differently from Piper. Instead of one .onnx file
per voice, ONE 88-MB int8 model + ONE 26-MB voices.bin together hold all
54 voices. Once the bundle lives on disk, every Kokoro voice is
"installed" — no per-voice download.

Voice IDs are "kokoro:<voice_name>" where voice_name follows the upstream
convention:
    [a|b|e|f|h|i|j|p|z][f|m]_<name>
    └─ language family    └─ gender
e.g. "af_heart" = American female "Heart", "bm_george" = British male George.

V1 ships the American + British English subset because that's the writer
audience. Adding more languages later is a one-line addition to
_VOICES below — the bundle already contains them.

The engine is loaded lazily on first synth so import-time cost stays
near zero; subsequent synths reuse the cached `Kokoro` instance.
"""

from __future__ import annotations

import io
import threading
import wave
from pathlib import Path

# Bundle lives under voices/kokoro/ rather than voices/ root so the Piper
# scanner (which globs voices/*.onnx) doesn't pick up the bundle and try
# to load it as a Piper voice.
KOKORO_DIR = Path(__file__).resolve().parent.parent / "voices" / "kokoro"
MODEL_PATH = KOKORO_DIR / "kokoro-v1.0.int8.onnx"
VOICES_PATH = KOKORO_DIR / "voices-v1.0.bin"

_PREFIX = "kokoro:"

# Single shared Kokoro instance + lock. onnxruntime sessions aren't
# safe under concurrent access; serialize like piper_engine does.
_synth_lock = threading.Lock()
_engine = None  # type: ignore[var-annotated]


# V1 voice list — American + British English. Quality grades from the
# upstream model card (https://huggingface.co/hexgrad/Kokoro-82M). Voices
# graded D or lower are omitted from the default surface — they exist in
# the bundle but aren't worth surfacing to writers.
#
# Schema: (voice_name, display_name, gender, language_code, quality_grade)
_VOICES: list[tuple[str, str, str, str, str]] = [
    # American Female
    ("af_heart",   "Heart",   "female", "en-US", "A"),
    ("af_bella",   "Bella",   "female", "en-US", "A-"),
    ("af_nicole",  "Nicole",  "female", "en-US", "B-"),
    ("af_aoede",   "Aoede",   "female", "en-US", "C+"),
    ("af_kore",    "Kore",    "female", "en-US", "C+"),
    ("af_sarah",   "Sarah",   "female", "en-US", "C+"),
    ("af_nova",    "Nova",    "female", "en-US", "C"),
    ("af_sky",     "Sky",     "female", "en-US", "C-"),
    ("af_alloy",   "Alloy",   "female", "en-US", "C"),
    ("af_jessica", "Jessica", "female", "en-US", "C"),
    ("af_river",   "River",   "female", "en-US", "C"),
    # American Male
    ("am_michael", "Michael", "male",   "en-US", "B"),
    ("am_fenrir",  "Fenrir",  "male",   "en-US", "B"),
    ("am_puck",    "Puck",    "male",   "en-US", "B"),
    ("am_echo",    "Echo",    "male",   "en-US", "C"),
    ("am_eric",    "Eric",    "male",   "en-US", "C"),
    ("am_liam",    "Liam",    "male",   "en-US", "C"),
    ("am_onyx",    "Onyx",    "male",   "en-US", "C"),
    ("am_adam",    "Adam",    "male",   "en-US", "D+"),
    # British Female
    ("bf_emma",    "Emma",    "female", "en-GB", "B-"),
    ("bf_isabella","Isabella","female", "en-GB", "C"),
    ("bf_alice",   "Alice",   "female", "en-GB", "C"),
    ("bf_lily",    "Lily",    "female", "en-GB", "C"),
    # British Male
    ("bm_george",  "George",  "male",   "en-GB", "C"),
    ("bm_fable",   "Fable",   "male",   "en-GB", "C"),
    ("bm_daniel",  "Daniel",  "male",   "en-GB", "D+"),
    ("bm_lewis",   "Lewis",   "male",   "en-GB", "D+"),
]


def bundle_present() -> bool:
    """True iff both bundle files exist and are non-empty."""
    return (
        MODEL_PATH.exists()
        and VOICES_PATH.exists()
        and MODEL_PATH.stat().st_size > 0
        and VOICES_PATH.stat().st_size > 0
    )


def list_voices():
    """Return the V1 English subset, or [] if the bundle isn't on disk."""
    from . import Voice

    if not bundle_present():
        return []

    out = []
    for name, display, gender, lang, quality in _VOICES:
        # Pretty name format mirrors Piper's: "Heart (en-US, A)"
        pretty = f"{display} ({lang}, {quality})"
        out.append(
            Voice(
                id=f"{_PREFIX}{name}",
                name=pretty,
                languages=[lang],
                gender=gender,
                engine="kokoro",
                num_speakers=1,  # Each Kokoro voice is single-speaker.
            )
        )
    return out


def _load_engine():
    """Lazy-load the Kokoro ONNX runtime. Heavy (200-300 MB resident);
    keep cached for the lifetime of the process."""
    global _engine
    if _engine is not None:
        return _engine
    if not bundle_present():
        raise FileNotFoundError(
            f"Kokoro bundle missing. Expected:\n"
            f"  {MODEL_PATH}\n  {VOICES_PATH}\n"
            f"Run: python scripts/get_kokoro.py"
        )
    # Imported lazily so missing kokoro-onnx (e.g. local dev without the
    # package) doesn't break the whole tts module at import time.
    from kokoro_onnx import Kokoro

    _engine = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    return _engine


def _voice_lang(voice_name: str) -> str:
    """Map the first letter of the voice name to Kokoro's lang code.
    Defaults to en-us if unknown so a bad lookup doesn't kill synth."""
    if not voice_name:
        return "en-us"
    return {
        "a": "en-us",
        "b": "en-gb",
        "e": "es",
        "f": "fr-fr",
        "h": "hi",
        "i": "it",
        "j": "ja",
        "p": "pt-br",
        "z": "cmn",
    }.get(voice_name[0], "en-us")


def _samples_to_wav_bytes(samples, sample_rate: int) -> tuple[bytes, int, int]:
    """Convert Kokoro's float32 samples to a 16-bit PCM WAV blob.

    Mirrors piper_engine._synth_one's return shape so the upstream
    streaming code stays voice-agnostic.
    """
    import numpy as np

    # Clamp to [-1, 1] before quantizing — Kokoro occasionally overshoots
    # on emphatic phrases, which would otherwise wrap and click.
    samples = np.clip(samples, -1.0, 1.0)
    int16 = (samples * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int16.tobytes())
    data = buf.getvalue()
    return data, len(int16), sample_rate


def synthesize_iter(
    text: str,
    voice_id: str,
    rate: int | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
):
    """Generator: yields one event per sentence, then a result event.

    Signature + event shape match piper_engine.synthesize_iter exactly
    so the dispatcher in __init__ and the SSE layer can call either.
    `speaker_id` is ignored — Kokoro voices are single-speaker.
    """
    import base64

    from . import split_sentences

    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("text is empty")

    suffix = voice_id[len(_PREFIX):] if voice_id.startswith(_PREFIX) else voice_id
    if not any(suffix == v[0] for v in _VOICES):
        raise FileNotFoundError(f"unknown Kokoro voice: {suffix!r}")

    engine = _load_engine()
    lang = _voice_lang(suffix)

    # The UI's rate is words-per-minute centered on 180 (SAPI scale).
    # Kokoro's `speed` is a multiplier: 1.0 = normal, >1 faster.
    speed = 1.0
    if rate:
        speed = max(0.5, min(2.0, rate / 180.0))

    total = len(sentences)
    wavs: list[bytes] = []
    offsets_ms: list[int] = []
    cumulative_frames = 0
    sample_rate = 0

    for i, sentence in enumerate(sentences):
        try:
            with _synth_lock:
                samples, sr = engine.create(
                    sentence, voice=suffix, speed=speed, lang=lang
                )
            data, frames, sr2 = _samples_to_wav_bytes(samples, sr)
        except Exception as exc:
            # Mirror the piper_engine resilience pattern: a single bad
            # sentence shouldn't abort the whole chapter. Log it and
            # emit a zero-frame placeholder so the offsets stay aligned
            # with sentence indexes.
            import sys as _sys
            import traceback as _tb
            print(
                f"[kokoro] sentence {i}/{total} synth failed: {exc!r}",
                file=_sys.stderr, flush=True,
            )
            print(f"  text: {sentence!r}", file=_sys.stderr, flush=True)
            _tb.print_exc()
            data, frames, sr2 = _silent_wav(sample_rate or 24000)

        if sample_rate == 0:
            sample_rate = sr2
        offset_ms = int(cumulative_frames * 1000 / (sr2 or 24000))
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
    """Zero-frame valid mono WAV. Used as a placeholder when one sentence
    synth fails so the rest of the chapter survives."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
    return buf.getvalue(), 0, sample_rate


def _concat_wavs(wav_blobs: list[bytes]) -> bytes:
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
