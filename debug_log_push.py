"""Debug log → GitHub push.

Receives a debug log payload from the phone, commits it to a private
GitHub repo via the Contents API. The debugger agent then `git pull`s
that repo and reads the newest log to diagnose bugs.

Why a separate repo (not inline in the narrative codebase): debug
logs are noise that doesn't belong in commit history, and they may
contain user-visible content (book titles, narrator names, sentence
snippets). Private repo keeps them out of any future public listing.

Why verbatim (no redaction): the repo is private, only the operator
and the agent see it, and the diagnostic value of "the synth crashed
on THIS sentence" is too high to drop on principle.

Env vars (set via `fly secrets set`):
  NARRATIVE_DEBUG_LOGS_TOKEN  fine-grained PAT, Contents:write on the
                              logs repo only. Never logged.
  NARRATIVE_DEBUG_LOGS_REPO   "owner/repo" slug, e.g.
                              "hypeman271-oss/narrative-debug-logs".

When either is unset, the endpoint returns ok=False with a clear
reason but does NOT 500 — the phone-side upload is best-effort and
the local download path is the source of truth.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone


GITHUB_API = "https://api.github.com"
MAX_LOG_BYTES = 2 * 1024 * 1024  # 2 MB cap; logs are plain text, this is huge


class DebugLogPushError(Exception):
    """Raised on any push failure. The endpoint catches and returns
    a structured response so the phone never sees a 500."""


def _config() -> tuple[str, str] | None:
    """Read token + repo from env. Returns None when either is
    missing — the caller treats that as "feature disabled" and
    returns ok=False rather than throwing."""
    token = os.environ.get("NARRATIVE_DEBUG_LOGS_TOKEN", "").strip()
    repo = os.environ.get("NARRATIVE_DEBUG_LOGS_REPO", "").strip()
    if not token or not repo:
        return None
    return token, repo


def is_enabled() -> bool:
    """True when both env vars are set. Useful for the phone-side to
    know whether to even attempt a push (we expose this via a status
    field on the endpoint)."""
    return _config() is not None


# Allowlist for the `reason` field — gets embedded in the filename, so
# we sanitize aggressively. Anything outside this set becomes "_".
_REASON_SAFE = re.compile(r"[^a-z0-9_-]+")


def _sanitize_reason(reason: str) -> str:
    """Lowercase + strip to a small safe charset. Empty → 'unknown'."""
    r = (reason or "").strip().lower()
    r = _REASON_SAFE.sub("_", r)
    r = r.strip("_")[:64] or "unknown"
    return r


def _sanitize_version(version: str) -> str:
    """Version stamps look like 'v225v3.37' — drop everything else."""
    v = (version or "").strip()
    v = re.sub(r"[^a-zA-Z0-9.\-]", "", v)[:32]
    return v or "unknown"


def _make_path(reason: str, version: str, when: datetime) -> str:
    """logs/<UTC-iso>-<reason>-<version>.txt
    Sortable lexicographically by upload time, which is what the
    agent wants when looking for "newest log"."""
    ts = when.strftime("%Y%m%dT%H%M%SZ")
    return f"logs/{ts}-{_sanitize_reason(reason)}-{_sanitize_version(version)}.txt"


def _commit_message(reason: str, version: str) -> str:
    return f"debug log: {_sanitize_reason(reason)} ({_sanitize_version(version)})"


def push_log(
    *,
    log: str,
    reason: str,
    version: str,
    ua: str = "",
    tenant_label: str = "",
) -> dict:
    """PUT a new file to the logs repo via the GitHub Contents API.

    Returns a dict on success:
        {"ok": True, "path": "...", "sha": "...", "html_url": "..."}

    Returns a dict on failure (never raises into the route handler):
        {"ok": False, "reason": "disabled" | "too_large" | "github_<status>" | ...}
    """
    cfg = _config()
    if cfg is None:
        return {"ok": False, "reason": "disabled"}
    token, repo = cfg

    body_bytes = (log or "").encode("utf-8")
    if len(body_bytes) > MAX_LOG_BYTES:
        return {"ok": False, "reason": "too_large", "bytes": len(body_bytes)}

    # Prepend a small server-side header so the agent has provenance
    # without having to cross-reference the filename. Keeps the body
    # human-grep-able.
    header = (
        f"# narrative debug log\n"
        f"# reason: {_sanitize_reason(reason)}\n"
        f"# version: {_sanitize_version(version)}\n"
        f"# ua: {(ua or '')[:200]}\n"
        f"# tenant: {(tenant_label or '')[:64]}\n"
        f"# uploaded: {datetime.now(timezone.utc).isoformat()}\n"
        f"# ---\n"
    )
    full_body = header.encode("utf-8") + body_bytes
    content_b64 = base64.b64encode(full_body).decode("ascii")

    path = _make_path(reason, version, datetime.now(timezone.utc))
    url = f"{GITHUB_API}/repos/{repo}/contents/{path}"

    payload = json.dumps({
        "message": _commit_message(reason, version),
        "content": content_b64,
        # No branch field — uses repo default (main).
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Narrative/0.1",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
            status = resp.status
    except urllib.error.HTTPError as e:
        # 4xx/5xx from GitHub — read the body for the error message but
        # never echo the token. Most likely: token expired (401),
        # token lacks Contents:write (403), or path already exists
        # (422 — shouldn't happen because of the timestamped filename).
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            err_body = ""
        return {
            "ok": False,
            "reason": f"github_{e.code}",
            "detail": err_body,
        }
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {"ok": False, "reason": "network", "detail": str(e)[:200]}

    if status not in (200, 201):
        return {"ok": False, "reason": f"github_{status}"}

    content = data.get("content") or {}
    return {
        "ok": True,
        "path": path,
        "sha": content.get("sha", ""),
        "html_url": content.get("html_url", ""),
    }
