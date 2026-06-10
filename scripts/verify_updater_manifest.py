"""Post-deploy smoke test for the Tauri updater manifest endpoint (#884).

Hits the live /api/updates/latest/{target}/{prev} endpoint and asserts:
  1. HTTP 200 (server thinks an update is available from {prev}).
  2. manifest version == LATEST_DESKTOP_VERSION expected.
  3. platforms[{plat_key}].url HEADs 200 (asset exists in GH release).
  4. platforms[{plat_key}].signature byte-for-byte == base64(.sig from GH).

Catches the bug classes we've actually shipped:
  - #867: wrong DESKTOP_SIGNATURES key (per-arch vs OS-only)
  - #868: GH release left as draft → /releases/download/ 404
  - v0.1.8: forgot to paste new .sig — manifest still points at old timestamp

Stdlib-only so it runs anywhere Python 3.10+ is installed.

Usage:
    python scripts/verify_updater_manifest.py
    python scripts/verify_updater_manifest.py --version 0.1.8 --prev 0.1.0
    python scripts/verify_updater_manifest.py --targets windows,linux
    python scripts/verify_updater_manifest.py --host narrative-alpha.fly.dev

Exit codes:
    0 — all targets passed
    1 — at least one assertion failed
    2 — couldn't read LATEST_DESKTOP_VERSION from server.py
"""

import argparse
import base64
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_PY = REPO_ROOT / "server.py"

DEFAULT_HOST = "narrative-alpha.fly.dev"
DEFAULT_PREV = "0.0.0"

# Map the OS-only target the Tauri plugin sends (#867) to the per-arch
# key the plugin reads inside manifest.platforms.
TARGET_TO_PLATFORM_KEY = {
    "windows": "windows-x86_64",
    "darwin":  "darwin-x86_64",
    "linux":   "linux-x86_64",
}


def read_latest_version() -> str:
    text = SERVER_PY.read_text(encoding="utf-8")
    m = re.search(r'^LATEST_DESKTOP_VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not m:
        print("ERROR: LATEST_DESKTOP_VERSION not found in server.py", file=sys.stderr)
        sys.exit(2)
    return m.group(1)


def fetch(url: str, method: str = "GET", timeout: float = 20.0):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read(), dict(resp.headers)


def head_ok(url: str) -> tuple[bool, int]:
    try:
        status, _, _ = fetch(url, method="HEAD")
        return 200 <= status < 400, status
    except urllib.error.HTTPError as e:
        return False, e.code
    except urllib.error.URLError:
        return False, 0


def check_target(host: str, target: str, expected_version: str, prev: str) -> list[str]:
    failures: list[str] = []
    label = f"[{target}]"
    print(f"--- {target} ---")

    url = f"https://{host}/api/updates/latest/{target}/{prev}"
    try:
        status, body, _ = fetch(url)
    except urllib.error.HTTPError as e:
        msg = f"{label} endpoint HTTP {e.code} (expected 200)"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures
    except urllib.error.URLError as e:
        msg = f"{label} endpoint unreachable: {e.reason}"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures

    if status != 200:
        msg = f"{label} HTTP {status} (prev={prev} likely >= expected={expected_version})"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures
    print("  HTTP 200")

    try:
        manifest = json.loads(body)
    except json.JSONDecodeError as e:
        msg = f"{label} manifest is not valid JSON: {e}"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures

    got = manifest.get("version", "")
    if got != expected_version:
        msg = f"{label} version={got!r} (expected {expected_version!r})"
        failures.append(msg); print(f"  FAIL {msg}")
    else:
        print(f"  version: {got}")

    plat_key = TARGET_TO_PLATFORM_KEY.get(target, f"{target}-x86_64")
    plat = (manifest.get("platforms") or {}).get(plat_key)
    if not plat:
        keys = list((manifest.get("platforms") or {}).keys())
        msg = f"{label} platforms[{plat_key}] missing (have {keys})"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures

    bundle_url = plat.get("url", "")
    sig_in_manifest = plat.get("signature", "")
    print(f"  bundle: {bundle_url}")

    ok, code = head_ok(bundle_url)
    if not ok:
        msg = f"{label} bundle URL HTTP {code}: {bundle_url}"
        failures.append(msg); print(f"  FAIL {msg}")
    else:
        print("  bundle HEAD: 200")

    sig_url = bundle_url + ".sig"
    try:
        _, sig_body, _ = fetch(sig_url)
    except urllib.error.HTTPError as e:
        msg = f"{label} .sig HTTP {e.code}: {sig_url}"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures
    except urllib.error.URLError as e:
        msg = f"{label} .sig unreachable: {e.reason}"
        failures.append(msg); print(f"  FAIL {msg}")
        return failures

    # The .sig file uploaded to GitHub is ALREADY base64-encoded by
    # cargo tauri signer — its raw body is the same base64 string that
    # gets pasted into DESKTOP_SIGNATURES verbatim. So compare the two
    # base64 strings directly (after normalizing any trailing whitespace
    # an editor might have added on either side).
    sig_from_gh = sig_body.decode("ascii", errors="replace").strip()
    sig_manifest_norm = sig_in_manifest.strip()

    if sig_manifest_norm == sig_from_gh:
        print("  signature: matches GH .sig byte-for-byte")
    else:
        # Decode each, surface the `trusted comment` line — that line
        # carries the timestamp + bundle filename and is the smoking
        # gun for "you pasted the OLD sig" regressions.
        def trusted_line(b64: str) -> str:
            try:
                txt = base64.b64decode(b64).decode("utf-8", errors="replace")
                for ln in txt.splitlines():
                    if ln.startswith("trusted comment:"):
                        return ln
            except Exception:
                pass
            return "<unparseable>"
        msg = (f"{label} signature mismatch.\n"
               f"      manifest: {trusted_line(sig_manifest_norm)}\n"
               f"      gh .sig:  {trusted_line(sig_from_gh)}")
        failures.append(msg); print(f"  FAIL {msg}")

    print()
    return failures


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--version",
                   help="Expected manifest version. Default: read from server.py.")
    p.add_argument("--prev", default=DEFAULT_PREV,
                   help='Probe "from" version. Must be < expected. Default 0.0.0.')
    p.add_argument("--targets", default="windows",
                   help="Comma-sep OS-only target list. Default: windows "
                        "(darwin/linux blocked on #859/#860).")
    args = p.parse_args()

    expected = args.version or read_latest_version()
    targets = [t.strip() for t in args.targets.split(",") if t.strip()]

    print(f"verify_updater_manifest: host={args.host}")
    print(f"verify_updater_manifest: expected={expected}  prev={args.prev}")
    print(f"verify_updater_manifest: targets={targets}\n")

    all_failures: list[str] = []
    for t in targets:
        all_failures.extend(check_target(args.host, t, expected, args.prev))

    if all_failures:
        print(f"FAIL — {len(all_failures)} check(s) failed.", file=sys.stderr)
        return 1
    print(f"OK — every target verified clean against expected={expected}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
