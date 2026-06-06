# How to duplicate Narrative's debug-log + agent-driven debugging setup

Instructions for another agent (or developer) to stand up the same
self-diagnosing debug pipeline that Narrative uses. The setup is
worth duplicating wherever you have:

- A web frontend that runs on phones (where DevTools is impractical).
- Users reporting "X looks wrong" / "X doesn't work" bugs that need
  data from their real device.
- A backend you control where you can add one endpoint.
- A Claude Code project where the main loop has been burning sessions
  on speculative CSS / state-machine guesses.

The pipeline turns *"X is wrong on my phone"* into *"agent pulls the
log automatically and probes from data."* It exists in Narrative as
of v225v3.38 (#767–#772) and has paid for itself many times since.

---

## What you're building

```
┌───────────── Phone / browser ─────────────┐
│  app.js                                    │
│    _dlog(category, message, data) ────────┼─► in-memory ring buffer (cap N)
│    _autoDownloadDebugLog(reason)          │
│      ├─ writes a .txt blob → user disk    │
│      └─ fire-and-forget POST ─────────────┼─► /api/debug-log
└────────────────────────────────────────────┘                │
                                                              ▼
                                          ┌───────── Your backend ─────────┐
                                          │  /api/debug-log (POST)         │
                                          │    → debug_log_push.push_log() │
                                          │       → GitHub Contents API    │
                                          └────────────────────────────────┘
                                                              │
                                                              ▼
                                          ┌─── Private GitHub logs repo ───┐
                                          │  logs/                         │
                                          │    <UTC-iso>-<reason>-<ver>.txt│
                                          └────────────────────────────────┘
                                                              │
                                                              ▼
                                          ┌─── .claude/agents/debugger ────┐
                                          │  Step 0: git pull logs repo    │
                                          │  Step 1: read DEBUG_PLAYBOOK   │
                                          │  Step 2: probe → fix → verify  │
                                          └────────────────────────────────┘
```

The agent never asks the user to attach a log. It pulls the newest
one matching the bug's surface and starts from data.

---

## Phase 0 — Decide on the names

Pick before you start so the strings are consistent across all
files. In the examples below, replace:

| Token | Example (Narrative) | Yours |
|---|---|---|
| `APPNAME` | `narrative` | |
| `APPNAME_UPPER` | `NARRATIVE` | |
| `LOGS_REPO_SLUG` | `owner/narrative-debug-logs` | |
| `BUILD_VERSION_SELECTOR` | `#settings-version-tag` | |
| `FILENAME_PREFIX` | `narrative-debug` | |

Capacity choices Narrative made:

- In-memory log cap: **1000 entries** (`_DEBUG_LOG_CAP`). Generous —
  even a heavy session rarely hits it.
- Server-side log size cap: **2 MB** (`MAX_LOG_BYTES`). Plain text;
  this is huge.
- Endpoint body cap: **4 MB** (Pydantic field). Belt + suspenders.

---

## Phase 1 — Front end (`app.js`)

### 1.1 The in-memory ring buffer + `_dlog`

Goes at the very top of your main JS file. Order matters: every
other module ends up calling `_dlog`, so it has to be defined first.

```js
const _DEBUG_LOG_CAP = 1000;
const _debugLog = [];
function _dlog(category, message, data) {
  // ISO timestamp is sortable + copy/pasteable into bug reports.
  const entry = {
    t: new Date().toISOString(),
    cat: category || "general",
    msg: String(message || ""),
  };
  // Stamp any per-session context that changes the semantics of a
  // log line. Narrative stamps the UI mode (simple/standard/author)
  // because mode-gated features behave differently. Adapt to whatever
  // matters in your app — auth state, feature flag, viewport class.
  try {
    if (typeof getUIMode === "function") entry.mode = getUIMode();
  } catch {
    entry.mode = "?";
  }
  if (data !== undefined) entry.data = data;
  _debugLog.push(entry);
  // FIFO drop when over cap. Splice from front: the tail (where
  // the failure surfaced) is the part you most want to preserve.
  if (_debugLog.length > _DEBUG_LOG_CAP) {
    _debugLog.splice(0, _debugLog.length - _DEBUG_LOG_CAP);
  }
  // Mirror to console.info so DevTools sessions can correlate.
  try {
    if (data !== undefined) {
      console.info(`[dlog/${entry.cat}] ${entry.msg}`, data);
    } else {
      console.info(`[dlog/${entry.cat}] ${entry.msg}`);
    }
  } catch {}
}
```

**Calling convention:** `_dlog("category", "human message", { ...data })`.

- `category` — free-form short string. Examples Narrative uses:
  `"clip-load"`, `"book-v3"`, `"sync"`, `"annotate"`,
  `"phone-pullup"`. The category is what you grep the log for first.
- `message` — short prose describing what happened.
- `data` — optional object. Stringifies via JSON; keep it small.

**The underscore prefix matters.** Narrative had two recurring bugs
(#600, #718) where someone typed `dlog(...)` without the underscore,
silently dropping log lines. Pre-empt by adding an ESLint rule or
just keeping `_dlog` short to type.

### 1.2 Cross-frame bridge (optional, only if you have iframes)

If your app embeds anything in an iframe (Narrative has a manual
viewer and tutorial walkthroughs), give the iframe its own logger
that posts to the parent:

```js
// Parent side — re-emit iframe log entries through main _dlog.
window.addEventListener("message", (e) => {
  const m = e && e.data;
  if (!m || m.type !== "child-dlog" || !m.entry) return;
  _dlog(m.entry.category || "iframe", m.entry.message || "", m.entry.data);
});

// Also sweep any localStorage breadcrumbs the iframe parked there —
// useful when postMessage was blocked (e.g. parsed-section viewers
// where the script never gets a parent frame).
try {
  const TUT_KEY = "APPNAME.tutorialLog";
  const cur = JSON.parse(localStorage.getItem(TUT_KEY) || "[]");
  for (const entry of cur) {
    _dlog(entry.category || "iframe", entry.message || "", entry.data);
  }
  localStorage.removeItem(TUT_KEY);
} catch {}
```

```js
// Iframe side — postMessage + localStorage breadcrumb fallback.
function wtlog(category, message, data) {
  const entry = { t: new Date().toISOString(), category, message, data: data || null };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "child-dlog", entry }, "*");
    }
  } catch {}
  try {
    const key = "APPNAME.tutorialLog";
    const cur = JSON.parse(localStorage.getItem(key) || "[]");
    cur.push(entry);
    while (cur.length > 50) cur.shift();
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {}
}
```

### 1.3 Format helper for display

You need one function that turns the buffer into the .txt content
that both the local download and the server push use.

```js
function _formatDebugLogForDisplay() {
  // Header so a human opening the file knows what they're reading.
  const header = [
    `# APPNAME debug log`,
    `# version: ${_currentAppVersion()}`,
    `# captured: ${new Date().toISOString()}`,
    `# ua: ${navigator.userAgent}`,
    `# entries: ${_debugLog.length}`,
    `# ---`,
  ].join("\n");
  const body = _debugLog.map((e) => {
    const tail = e.data !== undefined ? "  " + JSON.stringify(e.data) : "";
    const mode = e.mode ? `[${e.mode}] ` : "";
    return `${e.t}  ${mode}[${e.cat}]  ${e.msg}${tail}`;
  }).join("\n");
  return header + "\n" + body + "\n";
}
```

`_currentAppVersion()` should read whatever build stamp you bump
each release (Narrative reads the SW cache name; the version stamp
in the page's HTML is the backup).

### 1.4 Local download

```js
function _autoDownloadDebugLog(reason) {
  let text = "";
  try {
    text = _formatDebugLogForDisplay();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:.]/g, "-");
    const ver = _currentAppVersion().replace(/[^a-zA-Z0-9]/g, "");
    const safeReason = (reason || "auto").replace(/[^a-zA-Z0-9-]/g, "-");
    a.href = url;
    a.download = `FILENAME_PREFIX-${ver}-${safeReason}-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.warn("[debug-log] auto-download failed:", e);
  }
  // Fire-and-forget server push. Never await it — the local
  // download is the source of truth. Endpoint returns 200 with
  // ok=false on the normal failure modes, so a network error is
  // the only thing that throws.
  if (text) {
    _pushDebugLogToServer(reason, text).catch((e) => {
      console.warn("[debug-log] server push failed:", e);
    });
  }
}
```

### 1.5 Background server push

```js
async function _pushDebugLogToServer(reason, text) {
  const ver = _currentAppVersion();
  const payload = {
    log: text,
    reason: reason || "auto",
    version: ver,
    ua: navigator.userAgent || "",
  };
  const res = await fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn("[debug-log] server returned", res.status, "for /api/debug-log push");
    return { ok: false, reason: `http_${res.status}` };
  }
  return await res.json().catch(() => ({ ok: false, reason: "bad_json" }));
}
```

### 1.6 Surfacing the buttons

Three UI hooks:

1. **Settings → Send feedback** — manual export. Calls
   `_autoDownloadDebugLog("send-feedback")`. Always present.
2. **Settings → Push debug log to debugger** — on-demand push to
   server. Only show when `/api/debug-log/status` returns
   `enabled: true`.
3. **Auto-export on trap surfaces** — when a bug can trap the user
   (full-screen overlay, lockup, broken navigation), call
   `_autoDownloadDebugLog("phone-manual-open")` at the moment of
   entry. The reason string becomes the bug's name in the filename.

The auto-export pattern is the one that pays off most. Narrative's
phone-manual-contrast bug was diagnosed in one round because the
phone exported a log automatically every time the manual opened.

---

## Phase 2 — Backend

You need two endpoints + one helper module. Examples are FastAPI;
the shape ports directly to Flask, Express, etc.

### 2.1 `debug_log_push.py` — the GitHub commit helper

Save next to your other backend modules. This file is
self-contained — no app-specific imports.

```python
"""Debug log → GitHub push.

Receives a debug log payload, commits it to a private GitHub repo
via the Contents API. The debugger agent later `git pull`s and reads.

Env vars (set via your secrets manager — fly secrets / heroku / etc.):
  APPNAME_UPPER_DEBUG_LOGS_TOKEN  fine-grained PAT, Contents:write on
                                   the logs repo only.
  APPNAME_UPPER_DEBUG_LOGS_REPO   "owner/repo" slug.

When either is unset, push_log returns ok=False with reason="disabled"
but does NOT raise — phone uploads are best-effort.
"""
from __future__ import annotations

import base64, json, os, re, urllib.error, urllib.request
from datetime import datetime, timezone

GITHUB_API = "https://api.github.com"
MAX_LOG_BYTES = 2 * 1024 * 1024


def _config():
    token = os.environ.get("APPNAME_UPPER_DEBUG_LOGS_TOKEN", "").strip()
    repo = os.environ.get("APPNAME_UPPER_DEBUG_LOGS_REPO", "").strip()
    if not token or not repo:
        return None
    return token, repo


def is_enabled() -> bool:
    return _config() is not None


_REASON_SAFE = re.compile(r"[^a-z0-9_-]+")


def _sanitize_reason(reason: str) -> str:
    r = (reason or "").strip().lower()
    r = _REASON_SAFE.sub("_", r).strip("_")[:64]
    return r or "unknown"


def _sanitize_version(version: str) -> str:
    v = re.sub(r"[^a-zA-Z0-9.\-]", "", (version or "").strip())[:32]
    return v or "unknown"


def _make_path(reason: str, version: str, when: datetime) -> str:
    ts = when.strftime("%Y%m%dT%H%M%SZ")
    return f"logs/{ts}-{_sanitize_reason(reason)}-{_sanitize_version(version)}.txt"


def push_log(*, log: str, reason: str, version: str, ua: str = "",
             tenant_label: str = "") -> dict:
    cfg = _config()
    if cfg is None:
        return {"ok": False, "reason": "disabled"}
    token, repo = cfg

    body_bytes = (log or "").encode("utf-8")
    if len(body_bytes) > MAX_LOG_BYTES:
        return {"ok": False, "reason": "too_large", "bytes": len(body_bytes)}

    header = (
        f"# APPNAME debug log\n"
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
        "message": f"debug log: {_sanitize_reason(reason)} ({_sanitize_version(version)})",
        "content": content_b64,
    }).encode("utf-8")

    req = urllib.request.Request(
        url, data=payload, method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "APPNAME/0.1",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
            status = resp.status
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            err_body = ""
        return {"ok": False, "reason": f"github_{e.code}", "detail": err_body}
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
```

### 2.2 Wire the FastAPI endpoints

In your main app file:

```python
import debug_log_push
from pydantic import BaseModel, Field
from fastapi import Request


class DebugLogPushRequest(BaseModel):
    log: str = Field(..., min_length=1, max_length=4_000_000)
    reason: str = Field(default="unknown", max_length=64)
    version: str = Field(default="unknown", max_length=32)
    ua: str = Field(default="", max_length=300)


@app.post("/api/debug-log")
async def debug_log_endpoint(req: DebugLogPushRequest, request: Request):
    """Push to the logs repo. Returns 200 with ok=true|false; never 5xx."""
    import asyncio, functools
    tenant_label = getattr(request.state, "tenant_label", "") or ""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        functools.partial(
            debug_log_push.push_log,
            log=req.log, reason=req.reason, version=req.version,
            ua=req.ua, tenant_label=tenant_label,
        ),
    )
    return result


@app.get("/api/debug-log/status")
async def debug_log_status_endpoint():
    return {"enabled": debug_log_push.is_enabled()}
```

**Critical invariant:** the POST handler never throws into the
client. All failures collapse to `{ok: false, reason: "..."}` with
HTTP 200. Reason: phone-side push is fire-and-forget; a 5xx would
log to console for no benefit. The client can't act on a server
push failure anyway — it already has the local file.

---

## Phase 3 — GitHub side

### 3.1 Create the private logs repo

- New repo, **private**, no template, no README needed.
- Name: `APPNAME-debug-logs` (e.g. `narrative-debug-logs`).
- Default branch `main`.
- Add a single `.gitkeep` to `logs/` so the directory exists before
  the first commit.

### 3.2 Mint the fine-grained PAT

GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token.

- Resource owner: yourself (or the org that owns the repo).
- Repository access: **Only select repositories** → pick the logs repo.
- Permissions → Repository permissions → **Contents: Read and write**.
- Everything else stays at "No access."
- Expiration: 1 year is fine; set a calendar reminder to rotate.

Copy the token immediately — GitHub only shows it once.

### 3.3 Set the secrets on your deploy target

Fly:
```bash
fly secrets set APPNAME_UPPER_DEBUG_LOGS_TOKEN=ghp_xxxxx
fly secrets set APPNAME_UPPER_DEBUG_LOGS_REPO=owner/APPNAME-debug-logs
```

Heroku / Render / Railway / etc.: same idea, two env vars.

For local dev: drop them into your `.env` (and confirm `.env` is in
`.gitignore`).

Verify the wire-up by curling the status endpoint from a shell with
the same auth your app uses:
```bash
curl https://your-app.example.com/api/debug-log/status
# → {"enabled": true}
```

If `enabled: false`, the env vars aren't reaching the process. Don't
chase silent failures — fix this first.

---

## Phase 4 — The agent

### 4.1 Drop in `.claude/agents/debugger.md`

Copy Narrative's debugger agent definition wholesale and edit a few
strings. The full file is at `E:\audiable\.claude\agents\debugger.md`
(~300 lines). The essential edits:

1. **Step 0 — logs repo clone command.** Update the repo URL to
   yours. Narrative's:
   ```bash
   if [ ! -d ../APPNAME-debug-logs ]; then
     git clone https://github.com/owner/APPNAME-debug-logs ../APPNAME-debug-logs
   fi
   git -C ../APPNAME-debug-logs pull --quiet
   ls -t ../APPNAME-debug-logs/logs/ | head -5
   ```
2. **The agent's `description`** — set the trigger conditions for
   your app. Narrative's says "Use this agent when a user reports
   'X looks wrong / behaves wrong / doesn't work' and the root
   cause isn't obvious." Add "ALSO use it for UI/visual/rendering
   issues" — those are the ones most likely to burn sessions on
   speculative CSS guesses.
3. **Shipping discipline section** — update the SW cache string
   and version stamp selector for your project.
4. **The Three-Speculative-Fixes backstop** — leave intact. This
   is the most load-bearing part of the playbook.

### 4.2 Write `DEBUG_PLAYBOOK.md` at the repo root

The agent reads this on every diagnosis. It needs to exist before
the agent is useful. Sections it should have:

- **The Cardinal Rules.** Two: (1) get a log before shipping any
  fix, (2) wait for user-confirmed verification before declaring
  bug closed.
- **The diagnostic ladder.** Four rungs: read the bug report
  literally → capture a log → probe the rendering/behavior → inject
  a control element.
- **Named Methods.** Method 1 (computed-style probe + ancestor
  walk), Method 2 (control element injection), Method 3 (token
  resolution check), Method 4 (auto-download log on trigger),
  Method 5 (hardware-back escape), Method 6 (live log fetch from
  GH). Each with a code template.
- **Anti-patterns.** "Add `!important` until something sticks,"
  "redefine a token to a different value," "brute-force every
  selector," "trust the screenshot tells you the cause," "declare
  the bug closed before the user has tested."
- **The Three-Speculative-Fixes backstop.** After three guesses
  that didn't land, revert all three at once and capture a log.
  Hard rule.
- **Case studies.** Append a row every bug. Symptom / wrong theories
  / data that closed it / lessons. This is the only part that grows
  over time, and the value is cumulative.

Narrative's playbook is ~600 lines. Most of that is case studies
(the phone-manual-contrast burndown alone is 6 versions). Yours
starts much shorter; let it grow.

### 4.3 Conventions the agent expects

When you ship a candidate fix, name the method in your commit /
response:

> Running Method 1 probe in v3.42 to identify the overlay the
> ancestor walk can't see. Pending log capture after deploy.

Three things this gets you:

- The user can verify the agent is following the discipline.
- The next bug hunter reads the commit log and learns the methods
  passively.
- The case study writes itself when the bug closes — the method,
  the probe data, and the fix are all already named in the trail.

---

## Phase 5 — Verifying the pipeline end-to-end

After all five pieces are wired (frontend `_dlog`, endpoint, helper,
secrets, repo, agent):

1. **On the phone**, trigger anything that logs (open a dialog,
   tap a button).
2. **Settings → Push debug log to debugger.** A toast / quiet
   indicator should appear. The local download should also fire.
3. **On your dev machine**, run:
   ```bash
   git -C ../APPNAME-debug-logs pull
   ls -t ../APPNAME-debug-logs/logs/ | head -1
   ```
   You should see a fresh `<timestamp>-manual-push-<version>.txt`.
4. **Open the file.** Confirm:
   - Server-prepended header (reason, version, ua, tenant, uploaded).
   - Then your client-side header.
   - Then the entries you logged.
5. **From the agent**, run a diagnosis. Confirm it pulls the repo
   on Step 0 and reads the newest log.

If any step fails, fix the wiring before relying on the pipeline.
Don't paper over a broken push with manual log-pasting.

---

## What this is NOT

- **Not an APM tool.** Datadog / Sentry / LogRocket do continuous
  ingestion. This pipeline is on-demand: the user pushes when
  something is broken, the agent pulls. The token cost is bounded.
- **Not a replacement for unit tests.** Tests catch regressions;
  this catches "it works for me but not for the user." Different jobs.
- **Not safe to leave PII unredacted in a public repo.** The repo
  is private for a reason. If you ever make it public, you need a
  redaction layer in `push_log()` before the body gets committed.
- **Not free of effort.** The first time you set it up takes a few
  hours. The payoff is in session-time saved on every bug after.

---

## Maintenance

- **Token rotation.** Fine-grained PATs expire. Add a calendar
  reminder 2 weeks before expiry. Mint a new one, set the new
  secret, revoke the old one.
- **Logs repo grows.** Narrative's hits ~1 MB/month at low traffic.
  At ~50 MB/year. No action needed for years; eventually delete
  `logs/` files older than 90 days if the pull starts feeling slow.
- **Playbook drift.** After every bug hunt, the agent should append
  a case study. If a month passes without playbook updates, either
  no bugs happened (good) or the discipline slipped (check).
- **`_dlog` rot.** When you add a new feature, instrument it with
  `_dlog` from the start. The category names form a vocabulary;
  keep them consistent (`"clip-load"` not `"loading-clip"` not
  `"loadclip"`).

---

## Why this specific shape, and not the obvious alternatives

- **Why a private repo instead of an S3 bucket?**
  GitHub repos give you `git pull` for free. The agent doesn't need
  any AWS credentials, presigned URLs, or S3 client libraries — just
  `git`, which it already has. The downside (commit history is
  noisy) doesn't matter because the repo is private and serves
  exactly one purpose.

- **Why fire-and-forget instead of awaiting the push?**
  The local download is the source of truth. The server push is a
  convenience for the agent. If the network is bad, the local file
  is still on disk, and the user can email it. Awaiting would
  surface failures to the user that they can't act on.

- **Why a separate `debug_log_push.py` instead of inlining into the
  endpoint?**
  Testability + reuse. The helper is pure-function (input → GitHub
  API → result); the endpoint is FastAPI/Pydantic glue. You can
  unit-test `push_log()` in isolation, and another endpoint (e.g.
  a CLI debug-collect tool) can call it directly.

- **Why ISO-timestamped filenames instead of UUIDs?**
  `ls -t` works because newest is lexicographically last. The
  agent's "show me the newest 5" command is a one-liner. UUIDs would
  need `git log --diff-filter=A --name-only -1 -- logs/` to find the
  newest, which is uglier.

- **Why does the agent read the playbook on every run?**
  Because the cardinal rules are not internalized by the model
  reliably. The playbook is the discipline. Re-reading it costs one
  Read tool call and saves the team from another speculative-fix
  cascade.

---

## Appendix — files to look at in Narrative

If you're copying from this repo, these are the canonical sources:

| File | What's in it |
|---|---|
| `static/app.js:15–56` | `_dlog` definition + ring buffer |
| `static/app.js:5761–5821` | `_autoDownloadDebugLog` + `_pushDebugLogToServer` |
| `debug_log_push.py` | GitHub commit helper (full module) |
| `server.py:1647–1683` | The two endpoints |
| `.claude/agents/debugger.md` | Agent definition |
| `DEBUG_PLAYBOOK.md` | Methodology + case studies |
| `ARCHITECTURE.md:417–440` | Section "Debug-log push pipeline" — the user-facing summary |

Read those in order if you're hand-porting. The numbers will drift
as the file grows; use the named anchors (function names, doc
section titles).
