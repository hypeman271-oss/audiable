"""Synthesize the 3 voice samples shown on landing.html.

The landing page's trust strip plays three audio cards — that's the
highest-converting element on the page because it answers "will it
sound bad?" in 5 seconds. This script produces the files those
<audio> tags point at.

Output (relative to repo root):

    static/landing-assets/voice-libritts-7.mp3
    static/landing-assets/voice-2.mp3
    static/landing-assets/voice-3.mp3

All three samples read the same Tom Sawyer passage so a listener can
compare timbres back-to-back. Tom Sawyer is in the public domain and
already the brand's tutorial sample text (#628) — keeps the page
coherent with what users experience first inside the app.

All three voices come from LibriTTS:
  * License: CC BY 4.0
  * Attribution: "LibriTTS (Heiga Zen et al.), CC BY 4.0"
  * One attribution line covers the entire trust strip.

Voice 1 (libritts speaker 7) is the locked narrator pick per
memory/audiable_project.md. Voices 2 and 3 default to contrasting
timbres; swap the speaker IDs at the top of SAMPLES below if you'd
prefer different picks after auditioning.

We call the LIVE Fly /api/synthesize endpoint rather than running
piper locally — your local Python doesn't have piper installed and
Fly already has the engine warmed up. Only deps are `requests` and
`lameenc` (the latter for MP3 encoding the WAV that Fly returns).
If you want to skip MP3 encoding entirely you can keep the WAVs and
update landing.html to point at .wav instead.

Auth: reads NARRATIVE_KEY from your environment. If you don't have it
set, the script will tell you how to retrieve it from Fly.

Usage (from repo root):

    python scripts/synth_landing_voices.py

Expect ~10-30 seconds total wall-time (three HTTP round-trips + MP3
encode).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print(
        "ERROR: requests not installed. Run:\n"
        "    pip install requests lameenc\n",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    import lameenc
except ImportError:
    print(
        "ERROR: lameenc not installed. Run:\n"
        "    pip install lameenc\n"
        "(needed for MP3 encoding — Fly returns WAV)",
        file=sys.stderr,
    )
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "static" / "landing-assets"

# Live Fly endpoint. Same one the desktop Tauri shell + PWA hit. If
# you want to point at a staging deployment, override here.
API_BASE = os.environ.get("NARRATIVE_API_BASE", "https://narrative-alpha.fly.dev")
API_KEY = os.environ.get("NARRATIVE_KEY", "").strip()


# Tom Sawyer, opening of Chapter 1. Public domain. ~25 seconds of
# audio per voice at default rate — short enough to load lazily on the
# landing page without burning the visitor's data plan, long enough to
# audition the voice properly. Picked an action-leaning passage so the
# rhythm has some bounce; pure descriptive prose tends to sound flat.
SAMPLE_TEXT = (
    "Tom appeared on the sidewalk with a bucket of whitewash and a "
    "long-handled brush. He surveyed the fence, and all gladness "
    "left him and a deep melancholy settled down upon his spirit. "
    "Thirty yards of board fence nine feet high. Life to him seemed "
    "hollow, and existence but a burden."
)

# Each entry: output filename, voice_id, speaker_id, human label.
# The output filename matches what landing.html's <source src> expects.
# Speaker IDs are the second column in the LibriTTS speaker dropdown
# inside the app's voice browser — change them here and rerun if you
# want a different pick.
SAMPLES = [
    {
        "filename": "voice-libritts-7.mp3",
        "voice_id": "piper:en_US-libritts-high",
        "speaker_id": 7,
        "label": "LibriTTS speaker 7 (locked narrator pick)",
    },
    {
        "filename": "voice-2.mp3",
        "voice_id": "piper:en_US-libritts-high",
        "speaker_id": 30,
        # en_US-libritts-high has 904 speakers indexed 0..903. Earlier
        # versions of this script picked IDs in the 1000s which Piper
        # silently falls back from (returns a 1-second silent WAV
        # instead of raising), producing 8 KB junk MP3s on disk. Audition
        # inside the app's voice browser (Settings → Voice → Audition)
        # and pick anything in 0..903 here.
        "label": "LibriTTS speaker 30 (contrast voice)",
    },
    {
        "filename": "voice-3.mp3",
        "voice_id": "piper:en_US-libritts-high",
        "speaker_id": 200,
        "label": "LibriTTS speaker 200 (contrast voice)",
    },
]


def fetch_wav(voice_id: str, speaker_id: int, text: str) -> bytes:
    """POST to /api/synthesize and return raw WAV bytes."""
    if not API_KEY:
        raise RuntimeError(
            "NARRATIVE_KEY not set. Retrieve it from Fly with:\n"
            "    fly ssh console -C \"printenv NARRATIVE_KEY\" -a narrative-alpha\n"
            "Then in PowerShell:\n"
            "    $env:NARRATIVE_KEY = \"<pasted-value>\"\n"
            "(or set it persistently via [Environment]::SetEnvironmentVariable)"
        )
    res = requests.post(
        f"{API_BASE}/api/synthesize",
        json={
            "text": text,
            "voice_id": voice_id,
            "speaker_id": speaker_id,
        },
        headers={"X-Narrative-Key": API_KEY},
        timeout=120,
    )
    res.raise_for_status()
    return res.content


def wav_to_mp3(wav_bytes: bytes, bitrate_kbps: int = 64) -> bytes:
    """Encode a WAV (PCM 16-bit mono) to MP3 via lameenc.

    Mirrors tts/encode.py's wav_to_mp3 — duplicating it here so this
    script stays runnable without importing the tts package (whose
    piper dep is what made the original script fail locally).
    """
    import wave
    import io

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        n_channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        sampwidth = wf.getsampwidth()
        pcm = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise RuntimeError(f"Expected 16-bit PCM, got {sampwidth * 8}-bit")

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate_kbps)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(n_channels)
    encoder.set_quality(2)  # 2 = high quality, 7 = fast. 2 is fine for 64kbps.
    mp3 = encoder.encode(pcm)
    mp3 += encoder.flush()
    return mp3


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"API base: {API_BASE}")
    print(f"Output:   {OUTPUT_DIR}")
    print(f"Text:     {SAMPLE_TEXT[:60]}…")
    print()

    for sample in SAMPLES:
        print(f"  · {sample['label']}")
        wav = fetch_wav(
            voice_id=sample["voice_id"],
            speaker_id=sample["speaker_id"],
            text=SAMPLE_TEXT,
        )
        mp3 = wav_to_mp3(wav, bitrate_kbps=64)
        out_path = OUTPUT_DIR / sample["filename"]
        out_path.write_bytes(mp3)
        size_kb = len(mp3) / 1024
        print(f"    → {out_path.name} ({size_kb:.0f} KB)")

    print()
    print("Done. Reload landing.html locally (or deploy) to hear the samples.")
    print()
    print("Attribution line for the page footer / README:")
    print("  LibriTTS (Heiga Zen et al.), CC BY 4.0")


if __name__ == "__main__":
    main()
