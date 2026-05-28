"""Spin up an HTTPS tunnel for Narrative via Cloudflare.

Two modes:

  Quick tunnel (default)
    Random `https://<random>.trycloudflare.com` URL, no account needed.
    URL changes on every restart, so the phone PWA's saved URL gets
    stale every time. Great for one-off listening sessions.

  Named tunnel (--name)
    Persistent URL on a domain you own (free Cloudflare account).
    Your phone PWA stays installed at the same URL forever.
    Requires one-time setup:
        cloudflared tunnel login          # opens browser, picks your domain
        cloudflared tunnel create narrative
        cloudflared tunnel route dns narrative narrative.yourdomain.com
    Then run:
        python scripts/tunnel.py --name narrative

Auth (recommended for either mode):
    The server gates /api/* behind X-Narrative-Key when env var
    NARRATIVE_KEY is set. See the server's startup banner for a
    suggested key + setup line.

Requirements
------------
The `cloudflared` binary needs to be on PATH:
    Windows:  winget install --id Cloudflare.cloudflared
    macOS:    brew install cloudflared
    Linux:    https://pkg.cloudflare.com/install-cloudflared.html

Usage
-----
    python scripts/tunnel.py                       # quick tunnel on :8000
    python scripts/tunnel.py --port 8000
    python scripts/tunnel.py --name narrative      # named tunnel (persistent)
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


def _print_named_banner(tunnel_name: str, port: int) -> None:
    bar = "=" * 60
    lines = [
        "",
        bar,
        f"  Named tunnel '{tunnel_name}' starting",
        bar,
        f"  Local:   http://localhost:{port}",
        f"  Public:  whatever you configured via `cloudflared tunnel route dns`",
        bar,
        "  Open that URL on your phone — it stays the same across restarts,",
        "  so a previously-installed PWA keeps working.",
        bar,
        "",
    ]
    print("\n".join(lines), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Cloudflare tunnel for Narrative.")
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Local port the Narrative server is listening on (default: 8000).",
    )
    parser.add_argument(
        "--name",
        default=None,
        help=(
            "Run a pre-created named tunnel (persistent URL on a domain "
            "you own). See script docstring for one-time setup steps. "
            "Omit to use a random-URL quick tunnel instead."
        ),
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

    if args.name:
        # Named tunnel: cloudflared knows the public URL via the user's
        # `tunnel route dns` config. It doesn't print a public URL of its
        # own, so we just print the banner up front.
        cmd = [
            bin_path,
            "tunnel",
            "run",
            "--url",
            f"http://localhost:{args.port}",
            args.name,
        ]
        _print_named_banner(args.name, args.port)
    else:
        cmd = [
            bin_path,
            "tunnel",
            "--url",
            f"http://localhost:{args.port}",
            "--no-autoupdate",
        ]
    print(f"[tunnel] launching: {' '.join(cmd)}\n", flush=True)

    # Merge cloudflared's stderr into stdout so we get a single stream to
    # scan for the trycloudflare URL (quick tunnel only).
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    public_url: str | None = None
    try:
        for line in proc.stdout:  # type: ignore[union-attr]
            sys.stdout.write(line)
            sys.stdout.flush()
            # Quick-tunnel only: pick the trycloudflare URL out of the log
            # the first time we see it and print our own banner.
            if not args.name and public_url is None:
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
