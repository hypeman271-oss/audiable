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
import os
import sys
import threading
import time
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
    keep cached for the lifetime of the process.

    v582 (#446): pin ONNX intra/inter-op threads to 1. On Fly's
    shared-cpu-1x we have ~half a physical core; the default
    "use all detected cores" causes ONNX Runtime to create worker
    threads that fight over the single CPU we actually have,
    adding scheduling overhead with no parallelism gain. Pinning
    to 1 removes that contention. Pairs with the OMP/OpenBLAS/MKL
    env vars set in the Dockerfile (those affect numpy + the
    espeak-ng phonemizer path, which kokoro_onnx calls before
    ONNX inference for every sentence).
    """
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
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    n_threads = max(1, int(os.environ.get("NARRATIVE_ONNX_THREADS", "1")))

    # kokoro-onnx 0.4.9 doesn't expose a session_options kwarg, so the
    # only way to constrain ONNX Runtime's thread pools is to patch the
    # InferenceSession constructor before kokoro_onnx instantiates it.
    # The patch is temporary — we restore the original immediately
    # after Kokoro() so we don't affect any other engine that loads an
    # ONNX session later (e.g. faster-whisper). OMP_NUM_THREADS=1
    # (set in the Dockerfile) already constrains intra-op parallelism
    # because ORT's CPU EP uses OpenMP under the hood, but the
    # inter-op thread pool ignores that env var.
    _orig_session = ort.InferenceSession

    def _patched_session(*args, **kwargs):
        if "sess_options" not in kwargs and "session_options" not in kwargs:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = n_threads
            opts.inter_op_num_threads = 1
            kwargs["sess_options"] = opts
        return _orig_session(*args, **kwargs)

    ort.InferenceSession = _patched_session
    try:
        _engine = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    finally:
        ort.InferenceSession = _orig_session

    print(
        f"[kokoro] engine loaded: intra_op_threads={n_threads}, "
        f"inter_op_threads=1 (via InferenceSession patch)",
        file=sys.stderr, flush=True,
    )
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
    # v582 (#446): per-chapter timing so we can compare before/after
    # the ONNX thread pin + future hardware bumps. RTF = real-time
    # factor; <1.0 means synth is slower than playback (problematic
    # for any chapter the user wants to start listening to mid-synth).
    chapter_start_ts = time.monotonic()
    synth_only_seconds = 0.0

    for i, sentence in enumerate(sentences):
        try:
            sentence_start_ts = time.monotonic()
            with _synth_lock:
                samples, sr = engine.create(
                    sentence, voice=suffix, speed=speed, lang=lang
                )
            sentence_synth_seconds = time.monotonic() - sentence_start_ts
            synth_only_seconds += sentence_synth_seconds
            data, frames, sr2 = _samples_to_wav_bytes(samples, sr)
            # Per-sentence: synth time + produced audio seconds + RTF.
            # Audio duration here is the OUTPUT not the input — that's
            # what matters for whether playback can keep up with synth.
            audio_seconds = frames / (sr2 or 24000)
            sent_rtf = (
                audio_seconds / sentence_synth_seconds
                if sentence_synth_seconds > 0 else 0.0
            )
            print(
                f"[kokoro] sentence {i+1}/{total}: "
                f"synth={sentence_synth_seconds*1000:.0f}ms, "
                f"audio={audio_seconds*1000:.0f}ms, "
                f"rtf={sent_rtf:.2f}x",
                file=sys.stderr, flush=True,
            )
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
        # v225fz9 (#675): pad sentence WAV with trailing silence so
        # periods get an audible pause. Mirrors the piper_engine change.
        # Silence frames are added to cumulative_frames before this
        # sentence's offset is recorded — wait, no: this sentence's
        # offset is recorded based on cumulative BEFORE this sentence,
        # so we add silence frames AFTER appending the offset, alongside
        # this sentence's own frames. That way sentence N+1's offset
        # accounts for the pause that follows N. _pad_wav_trailing_silence
        # is defined in piper_engine.py so we import lazily to avoid a
        # circular-import surprise.
        from .piper_engine import _pad_wav_trailing_silence, SENTENCE_PAUSE_MS
        data, silence_frames = _pad_wav_trailing_silence(data, SENTENCE_PAUSE_MS)
        offset_ms = int(cumulative_frames * 1000 / (sr2 or 24000))
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

    # v582 (#446): chapter summary so we can see RTF over a whole synth
    # job at a glance. Wall = total time including the SSE-yield gap +
    # base64 + numpy work; synth-only is just engine.create wall time.
    chapter_wall_seconds = time.monotonic() - chapter_start_ts
    audio_total_seconds = cumulative_frames / (sample_rate or 24000)
    wall_rtf = (
        audio_total_seconds / chapter_wall_seconds
        if chapter_wall_seconds > 0 else 0.0
    )
    synth_rtf = (
        audio_total_seconds / synth_only_seconds
        if synth_only_seconds > 0 else 0.0
    )
    print(
        f"[kokoro] CHAPTER DONE: sentences={total}, "
        f"audio={audio_total_seconds:.1f}s, "
        f"wall={chapter_wall_seconds:.1f}s (rtf={wall_rtf:.2f}x), "
        f"synth-only={synth_only_seconds:.1f}s (rtf={synth_rtf:.2f}x)",
        file=sys.stderr, flush=True,
    )

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
