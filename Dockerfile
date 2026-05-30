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
    && rm -rf /var/lib/apt/lists/*

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
COPY server.py extract.py github_oauth.py ./
COPY tts/ ./tts/
COPY static/ ./static/
COPY scripts/ ./scripts/

# Voices. ~120-160 MB for Amy + Alan; tolerable for alpha.
# When you add more voices, just rerun `docker build` after copying them
# into voices/ on disk.
COPY voices/ ./voices/

# Bind to all interfaces so Fly's edge can reach uvicorn. The server.py
# default already binds 0.0.0.0:8000.
EXPOSE 8000

# Fly + Cloudflare in front of us handle TLS — uvicorn just serves HTTP.
CMD ["python", "server.py"]
