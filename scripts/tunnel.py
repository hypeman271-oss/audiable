"""Spin up an HTTPS tunnel for Narrative via Cloudflare quick tunnel.

Once `python server.py` is running, run this in a second terminal and you
get a public `https://<random>.trycloudflare.com` URL — open it on your
phone (cellular OK). The PWA install prompt fires properly, the service
worker actually registers (so the app shell works offline), and you can
listen to clips you generated at home while you're somewhere else.

Requirements
------------
The `cloudflared` binary needs to be on PATH:
    Windows:  winget install --id Cloudflare.cloudflared
    macOS:    brew install cloudflared
    Linux:    https://pkg.cloudflare.com/install-cloudflared.html

Usage
-----
    python scripts/tunnel.py              # tunnels :8000
    python scripts/tunnel.py --port 8000

Security note
-------------
While the tunnel is up, anyone with the URL can hit your TTS endpoints
(synthesize, voice browser/install, file upload — bounded by the 25 MB
upload cap). The URL is unguessable, but treat it as semi-public — close
the terminal when you're done listening.
"""

from __future__ import annotations

import argparse
import re
import shutil
import socket
import subprocess
import sys

# cloudflared prints the URL inside a banner box. Match anywhere on the line.
_TRYCLOUDFLARE_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# Common install locations on Windows in case winget's PATH update hasn't
# been picked up yet by the current shell.
_WINDOWS_FALLBACKS = [
    r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    r"C:\Program Files\cloudflared\cloudflared.exe",
]


def _find_cloudflared() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    if sys.platform == "win32":
        for candidate in _WINDOWS_FALLBACKS:
            if shutil.which(candidate) or _exists(candidate):
                return candidate
    return None


def _exists(path: str) -> bool:
    try:
        with open(path, "rb"):
            return True
    except OSError:
        return False


def _install_help() -> str:
    return (
        "cloudflared not found on PATH. Install it first:\n"
        "  Windows:  winget install --id Cloudflare.cloudflared\n"
        "  macOS:    brew install cloudflared\n"
        "  Linux:    https://pkg.cloudflare.com/install-cloudflared.html\n"
        "Then open a fresh terminal and retry."
    )


def _server_listening(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _print_banner(public_url: str, port: int) -> None:
    bar = "=" * 60
    lines = [
        "",
        bar,
        "  Narrative HTTPS tunnel is live",
        bar,
        f"  Local:   http://localhost:{port}",
        f"  Public:  {public_url}",
        bar,
        "  Open the public URL on your phone (works over cellular):",
        "    - Service worker registers (real offline shell)",
        "    - PWA install prompt fires on Android",
        "    - iOS: Share -> Add to Home Screen",
        "",
        "  This URL is unguessable but treat it as semi-public.",
        "  Close this terminal to take it down.",
        bar,
        "",
    ]
    print("\n".join(lines), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Cloudflare quick tunnel for Narrative.")
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Local port the Narrative server is listening on (default: 8000).",
    )
    args = parser.parse_args()

    bin_path = _find_cloudflared()
    if not bin_path:
        print(_install_help(), file=sys.stderr)
        return 1

    if not _server_listening(args.port):
        print(
            f"warning: nothing listening on localhost:{args.port} yet.\n"
            f"Start the server in another terminal first:\n"
            f"    python server.py\n",
            file=sys.stderr,
        )

    cmd = [
        bin_path,
        "tunnel",
        "--url",
        f"http://localhost:{args.port}",
        "--no-autoupdate",
    ]
    print(f"[tunnel] launching: {' '.join(cmd)}\n", flush=True)

    # Merge cloudflared's stderr into stdout so we get a single stream to
    # scan for the trycloudflare URL.
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    public_url: str | None = None
    try:
        # Stream cloudflared's output verbatim AND pick out the public URL the
        # first time we see it so we can print our own banner.
        for line in proc.stdout:  # type: ignore[union-attr]
            sys.stdout.write(line)
            sys.stdout.flush()
            if public_url is None:
                match = _TRYCLOUDFLARE_RE.search(line)
                if match:
                    public_url = match.group(0)
                    _print_banner(public_url, args.port)
    except KeyboardInterrupt:
        print("\n[tunnel] Ctrl+C — shutting down…", flush=True)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    return proc.returncode or 0


if __name__ == "__main__":
    sys.exit(main())
