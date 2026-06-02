"""Server-side Whisper transcription for voice notes.

v223.tn10 (#475): Browser SpeechRecognition collides with MediaRecorder
on Android Chrome — SR's audiostart fires but no samples reach it
because MediaRecorder owns the mic exclusively. The fallback is to
ship the recorded audio to the server and transcribe it here.

faster-whisper is a CTranslate2-quantized port of OpenAI's Whisper.
The `base` model at int8 quantization is ~74MB on disk, ~250MB
resident, and decodes a 30-second memo in ~1-3s on a single CPU.
That's plenty for the alpha — short memos, latency hidden behind
the existing save-then-update-annotation flow.

The model is downloaded at image build time (see Dockerfile) and
lazy-loaded on first request, then held in memory for the process
lifetime. Audio bytes come in via base64 in the POST body and get
decoded by faster-whisper's internal ffmpeg invocation, so any
container the browser produces (webm/opus on Chromium, mp4/aac on
Safari) just works.
"""
from __future__ import annotations

import io
import os
import threading
import time
from typing import Optional


# Lazy singleton — first call loads the model, subsequent calls reuse.
_model = None
_model_lock = threading.Lock()
_model_size = os.environ.get("WHISPER_MODEL", "base")
_load_error: Optional[str] = None


def get_model():
    """Return the WhisperModel singleton, loading it on first call.

    Subsequent callers block on the same lock if loading is in flight,
    so we never spin up two parallel loads racing for the same CTranslate2
    weights. After a successful load the function returns ~immediately.
    """
    global _model, _load_error
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        if _load_error is not None:
            # We've already tried and failed once — don't keep retrying.
            return None
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            _load_error = f"faster-whisper import failed: {e}"
            print(f"[transcribe] {_load_error}", flush=True)
            return None
        compute_type = "int8"
        device = "cpu"
        print(
            f"[transcribe] loading whisper '{_model_size}' "
            f"({compute_type}, {device})",
            flush=True,
        )
        t0 = time.time()
        try:
            _model = WhisperModel(
                _model_size,
                device=device,
                compute_type=compute_type,
            )
            print(
                f"[transcribe] ready in {time.time() - t0:.1f}s",
                flush=True,
            )
        except Exception as e:
            _load_error = f"WhisperModel ctor failed: {e}"
            print(f"[transcribe] {_load_error}", flush=True)
            _model = None
        return _model


def transcribe_bytes(audio_bytes: bytes) -> dict:
    """Transcribe an audio blob and return its text.

    Returns a dict shaped like {transcript, lang, durationSec}. On
    any failure (missing model, decode error) returns an empty
    transcript so callers can fall back to "audio only" gracefully.
    Accepts any container faster-whisper can route through ffmpeg —
    webm/opus, mp4/aac, mp3, wav — so the caller doesn't need to
    pre-decode.
    """
    if not audio_bytes:
        return {"transcript": "", "lang": "", "durationSec": 0.0}
    model = get_model()
    if model is None:
        return {
            "transcript": "",
            "lang": "",
            "durationSec": 0.0,
            "error": _load_error or "model unavailable",
        }
    try:
        bio = io.BytesIO(audio_bytes)
        # beam_size=1 + greedy decode is fine for short memos; quality
        # vs latency tradeoff matters more for long-form. VAD trims
        # silence so we don't waste cycles on the mic-on-but-no-speech
        # tail at the end of every recording.
        segments, info = model.transcribe(
            bio,
            beam_size=1,
            language=None,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        parts = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                parts.append(text)
        transcript = " ".join(parts).strip()
        return {
            "transcript": transcript,
            "lang": info.language or "",
            "durationSec": float(info.duration or 0.0),
        }
    except Exception as e:
        print(f"[transcribe] failed: {e}", flush=True)
        return {
            "transcript": "",
            "lang": "",
            "durationSec": 0.0,
            "error": str(e),
        }
