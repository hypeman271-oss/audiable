"""Download the Kokoro-82M ONNX bundle into voices/kokoro/.

One model file + one voices bundle gives access to all 54 voices.
Idempotent: skips files that already exist with non-zero size.

Run from the repo root:

    python scripts/get_kokoro.py

After this completes, restart the server and Kokoro voices will appear
in the voice browser as installed.

Files come from the kokoro-onnx project's GitHub release (Apache 2.0):
    https://github.com/thewh1teagle/kokoro-onnx/releases
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "voices" / "kokoro"

# Pin to a specific release tag so the spike is reproducible. Bump the
# tag if hexgrad publishes a quality-improving model revision and we
# want to pick it up.
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = [
    ("kokoro-v1.0.int8.onnx", f"{BASE}/kokoro-v1.0.int8.onnx"),
    ("voices-v1.0.bin",       f"{BASE}/voices-v1.0.bin"),
]


def _download(url: str, dest: Path) -> None:
    """Stream a URL to dest with a one-line progress indicator."""
    print(f"  fetching {url}")
    req = urllib.request.Request(
        url, headers={"User-Agent": "narrative/0.1 (+local)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            written = 0
            chunk = 1024 * 256  # 256KB chunks — coarse but fewer prints
            with open(dest, "wb") as f:
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    written += len(buf)
                    if total:
                        pct = written * 100 // total
                        sys.stdout.write(
                            f"\r    {pct:3d}%  "
                            f"({written / 1_000_000:.1f} / {total / 1_000_000:.1f} MB)"
                        )
                        sys.stdout.flush()
            sys.stdout.write("\n")
    except urllib.error.HTTPError as exc:
        if dest.exists():
            dest.unlink()
        raise SystemExit(f"  HTTP {exc.code} fetching {url}") from exc
    except Exception as exc:
        if dest.exists():
            dest.unlink()
        raise SystemExit(f"  failed: {exc}") from exc


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    print(f"Kokoro bundle → {DEST}")
    for fname, url in FILES:
        out = DEST / fname
        if out.exists() and out.stat().st_size > 0:
            print(f"  ✓ {fname} (already present, {out.stat().st_size / 1_000_000:.1f} MB)")
            continue
        _download(url, out)
        print(f"  ✓ {fname}")
    print("Done. Restart the server to pick up the new voices.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
