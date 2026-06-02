# Narrative — production container for alpha hosting.
#
# Builds a self-contained image: Python + all app deps + the voices/ directory
# baked in. Voices are shipped IN the image (not on a volume) for alpha
# simplicity. To add a new voice, install it locally, commit voices/, and
# rebuild + redeploy. Switch to a volume when the alpha grows up.

FROM python:3.12-slim AS base

# espeak-ng is the Linux backend for pyttsx3 (the SAPI alternative). Without
# it, pyttsx3.init() raises on Linux and the SAPI half of the voice list
# fails. Piper-only requests would still work, but installing it costs ~3 MB
# and avoids a foot-gun.
#
# build-essential + libsndfile1 + libgomp1 cover potential native build /
# runtime needs for piper-tts and friends.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        espeak-ng \
        libespeak-ng1 \
        libsndfile1 \
        libgomp1 \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# ffmpeg: faster-whisper decodes incoming audio (webm/opus, mp4, etc)
# via the ffmpeg binary. Without it the /api/library/transcribe
# endpoint would fail on every non-WAV input — and phones send webm.

# v220ay: point Kokoro's phonemizer at the apt-installed espeak-ng instead
# of the bundled espeakng-loader. The bundled .so was compiled on GitHub
# Actions with a hardcoded data-path baked in
# (/home/runner/work/espeakng-loader/...), and when espeak can't find its
# phontab it aborts the process from C code — uncatchable by Python.
#
# By setting ESPEAK_DATA_PATH + PHONEMIZER_ESPEAK_LIBRARY before any
# Python process boots, the (bundled or system) espeak code finds the
# apt-installed data dir at /usr/lib/x86_64-linux-gnu/espeak-ng-data
# and phonemizer-fork uses the system libespeak-ng.so.1 — both are
# stable system paths that exist in every container layer.
ENV ESPEAK_DATA_PATH=/usr/lib/x86_64-linux-gnu/espeak-ng-data
ENV PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1
ENV PHONEMIZER_ESPEAK_PATH=/usr/bin/espeak-ng

WORKDIR /app

# Install Python deps first so the layer caches when only app code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# App code + static assets.
# v197: github_oauth.py was added in v180 but the Dockerfile was never
# updated to copy it — local dev hid the bug because every .py at the
# project root is importable, but in the container only the explicit
# COPY list lands. Without it, `import github_oauth` at server.py:24
# raised ModuleNotFoundError and the machine boot-looped.
COPY server.py extract.py github_oauth.py library_db.py library_api.py admin_api.py transcribe.py ./
COPY tts/ ./tts/
COPY static/ ./static/
COPY scripts/ ./scripts/

# Voices. ~120-160 MB for Amy + Alan; tolerable for alpha.
# When you add more voices, just rerun `docker build` after copying them
# into voices/ on disk.
COPY voices/ ./voices/

# v220ar: Kokoro-82M ONNX bundle (Apache 2.0). One model + one voices
# bundle = all 54 voices in ~115 MB. Downloaded at build time so cloud
# deploys don't depend on the developer's machine having the bundle
# locally. Idempotent in the engine (it skips loading if files are
# already present), so if you bake the bundle into voices/kokoro/
# locally, this RUN step finds the same target paths and the
# subsequent COPY voices/ above wins (no double-fetch).
#
# v220at: stage the script under /app/ (NOT /tmp/) so its
# Path(__file__).parent.parent resolves to /app and the bundle lands
# at /app/voices/kokoro/ — the exact path the engine expects. Running
# from /tmp/ landed it at /voices/kokoro/ and the engine quietly
# reported zero voices, with the catalog endpoint returning the
# Piper-only list (the user saw "English (37)" instead of ~64).
COPY scripts/get_kokoro.py ./scripts/get_kokoro.py
RUN python scripts/get_kokoro.py

# v223.tn10 (#475): pre-download faster-whisper base model so the
# first /api/library/transcribe request doesn't pay a ~75MB download
# stall on top of model load. Cached in the image's HF cache dir.
# Base (int8) is ~74MB on disk, ~250MB resident — fits comfortably in
# the 2GB Fly machine.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

# Bind to all interfaces so Fly's edge can reach uvicorn. The server.py
# default already binds 0.0.0.0:8000.
EXPOSE 8000

# Fly + Cloudflare in front of us handle TLS — uvicorn just serves HTTP.
CMD ["python", "server.py"]
