"""Download Piper voice models from the official Hugging Face repo.

Usage:
    python scripts/get_voice.py                          # downloads default starters
    python scripts/get_voice.py en_US-amy-medium
    python scripts/get_voice.py en_US-amy-medium en_GB-alan-medium

Voice ids follow Piper's convention: <locale>-<name>-<quality>
    locale:  e.g. en_US, en_GB, de_DE, fr_FR, es_ES
    quality: low (~30MB, faster), medium (~63MB, better), high (~108MB, best)

Browse all available voices at:
    https://huggingface.co/rhasspy/piper-voices
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES_DIR = Path(__file__).resolve().parent.parent / "voices"

DEFAULT_VOICES = [
    "en_US-amy-medium",      # American English, female (~63MB)
    "en_GB-alan-medium",     # British English, male (~63MB)
    "en_US-ljspeech-high",   # American English, female, public domain (~108MB)
]


def parse(voice_id: str) -> tuple[str, str, str, str]:
    parts = voice_id.split("-")
    if len(parts) != 3:
        raise ValueError(
            f"voice id must be <locale>-<name>-<quality>, got {voice_id!r}"
        )
    locale, name, quality = parts
    lang = locale.split("_")[0]
    return lang, locale, name, quality


def download_one(voice_id: str) -> None:
    lang, locale, name, quality = parse(voice_id)
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("onnx", "onnx.json"):
        fname = f"{voice_id}.{ext}"
        out = VOICES_DIR / fname
        if out.exists() and out.stat().st_size > 0:
            print(f"  [skip] {fname} already present ({out.stat().st_size / 1e6:.1f} MB)")
            continue
        url = f"{BASE}/{lang}/{locale}/{name}/{quality}/{fname}"
        print(f"  [get ] {fname}")
        try:
            urllib.request.urlretrieve(url, out)
        except urllib.error.HTTPError as e:
            # Don't leave a partial/zero-byte file behind on failure
            if out.exists():
                out.unlink()
            raise SystemExit(f"failed to fetch {url}: {e}")
        print(f"         -> {out.stat().st_size / 1e6:.1f} MB")


def main() -> None:
    voices = sys.argv[1:] or DEFAULT_VOICES
    print(f"target dir: {VOICES_DIR}")
    for v in voices:
        print(f"\nvoice: {v}")
        download_one(v)
    print("\nDone. Restart the server to pick up new voices.")


if __name__ == "__main__":
    main()
