"""Narrative — local text-to-speech web prototype.

Run:
    pip install -r requirements.txt
    python server.py
    # open http://localhost:8000
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import mimetypes
import os
import socket
import sys
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import debug_log_push
import extract
import gdrive_oauth
import github_oauth
import library_db
import synth_jobs
import totp
import tts

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB cap on uploads

STATIC_DIR = Path(__file__).parent / "static"


# v204: SSE keepalive wrapper. A long Piper synth (4-8 minutes for a
# book chapter on shared CPU) yields events sparsely — sometimes zero
# response bytes between the last per-sentence WAV and the final MP3
# result. Intermediaries that judge "machine idleness" by recent
# response traffic (Fly's autostopper, nginx with proxy_read_timeout,
# Cloudflare's connection scrubbing) decide the connection is dead and
# kill it. v203 worked around the Fly case by disabling autostop; v204
# fixes the root cause so we can safely re-enable autostop later AND so
# the change is portable to other deployment targets.
#
# SSE comment lines (start with ':') are part of the protocol — the
# EventSource spec says clients MUST ignore them. The bytes-on-the-wire
# are real, though, which is exactly what intermediaries need to see.
async def _sse_with_keepalive(agen, interval: float = 15.0):
    """Wrap an async SSE generator. Emits ': keepalive\\n\\n' every
    `interval` seconds of inactivity from the wrapped generator. The
    wrapped generator runs concurrently via an asyncio.Task so a
    timeout-on-the-queue check can race against actual events.
    """
    import asyncio

    queue: asyncio.Queue = asyncio.Queue()
    _SENTINEL = object()

    async def _producer():
        try:
            async for item in agen:
                await queue.put(item)
        finally:
            await queue.put(_SENTINEL)

    producer_task = asyncio.create_task(_producer())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                # No event in the last `interval` seconds. Emit a
                # comment line so the proxy/client see live bytes.
                yield ": keepalive\n\n"
                continue
            if item is _SENTINEL:
                break
            yield item
    finally:
        # Producer is either finished or we're being torn down. Cancel
        # in case the client disconnected mid-stream — without this the
        # producer would hang holding the underlying synth iterator.
        producer_task.cancel()
        try:
            await producer_task
        except (asyncio.CancelledError, Exception):
            pass

# Make sure the manifest is served as JSON, not octet-stream.
mimetypes.add_type("application/manifest+json", ".webmanifest")

app = FastAPI(title="Narrative", version="0.1.0")

# v225v4.30: CORS middleware is registered AFTER require_api_key
# below (see explanation there). Don't add it here.

# v221.sync-3: server-side library CRUD endpoints. Lives in a separate
# module so server.py doesn't bloat further; behind /api/library/*.
# Gracefully degrades to 503 on every endpoint when library_db isn't
# available (e.g., volume not mounted yet, or local dev without /data).
import library_api  # noqa: E402
import admin_api  # noqa: E402

app.include_router(library_api.router)
app.include_router(admin_api.router)


@app.on_event("startup")
async def _init_library_db():
    """v221.sync-2: open the SQLite library DB, run migrations.

    Synchronous + fast (<100ms — schema is small). Runs BEFORE Kokoro
    warmup so the library API is available immediately on boot. If
    /data isn't writable (local dev without a volume, or a fresh
    deploy where the volume hasn't been attached yet), the module
    logs and disables itself — sync endpoints will 503 but the rest
    of the app keeps working.
    """
    import library_db

    library_db.init_db()


# v220ax: Kokoro warmup state. Pre-loading the ONNX session out of the
# request path is necessary (cold load takes 15-30s; Fly's edge proxy
# resets idle connections inside that window), but doing it
# synchronously inside the FastAPI startup event blocks the app from
# listening on 0.0.0.0:8000, which makes healthchecks fail and the
# proxy returns 502 for the first ~15s after every deploy.
#
# So we fire warmup off as a background task and let startup complete
# immediately. A shared asyncio.Event is set when the warmup finishes;
# the preview endpoint awaits it (with a generous timeout) before
# attempting the synth so the first user request after a cold deploy
# waits ~15s instead of hard-failing.
_kokoro_warmup_done: "asyncio.Event | None" = None


@app.on_event("startup")
async def _schedule_kokoro_warmup():
    """Schedule Kokoro warmup as a background task — does NOT block
    startup. See _kokoro_warmup_done docstring above for why."""
    import asyncio
    import sys as _sys

    from tts import kokoro_engine

    global _kokoro_warmup_done
    _kokoro_warmup_done = asyncio.Event()

    if not kokoro_engine.bundle_present():
        print(
            "[startup] Kokoro bundle missing — voices will not be available. "
            "Run: python scripts/get_kokoro.py",
            file=_sys.stderr, flush=True,
        )
        # Mark as "done" anyway so the preview endpoint doesn't await
        # an event that never fires — the engine will raise its own
        # FileNotFoundError, which the endpoint turns into a 404.
        _kokoro_warmup_done.set()
        return

    async def _warm_in_background():
        import traceback as _tb

        def _do_warm():
            kokoro_engine._load_engine()
            kokoro_engine.synthesize(text="Ready.", voice_id="kokoro:af_heart")

        print("[warmup] starting Kokoro warmup…", file=_sys.stderr, flush=True)
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _do_warm)
            print("[warmup] Kokoro engine ready.", file=_sys.stderr, flush=True)
        except Exception as e:
            print(
                f"[warmup] Kokoro warmup failed: {type(e).__name__}: {e}",
                file=_sys.stderr, flush=True,
            )
            _tb.print_exc()
        finally:
            # Mark done EVEN ON FAILURE so the preview endpoint can
            # surface a proper error instead of waiting forever.
            _kokoro_warmup_done.set()

    asyncio.create_task(_warm_in_background())


async def _await_kokoro_warmup(timeout_sec: float = 25.0):
    """Block briefly so the first user preview after a cold boot waits
    for the warmup instead of racing it. Subsequent calls fall through
    instantly because the event is already set."""
    import asyncio

    if _kokoro_warmup_done is None or _kokoro_warmup_done.is_set():
        return
    try:
        await asyncio.wait_for(_kokoro_warmup_done.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        # 25s is plenty for cold load on Fly's CPU. If we hit this the
        # engine is genuinely broken — proceed and let the synth call
        # raise the real error.
        pass


# ──────────────────────────────────────────────────────────────────────
# v4.58 (#823): server-side wedge instrumentation.
#
# Failure mode we lived through on 2026-06-07: Fly machine showed
# "started" with the VM process alive, but uvicorn was no longer bound
# to :8000. Every request 503'd ("could not find a good candidate") and
# we had no visibility from outside the box — no app stdout, no proper
# health endpoint, no metric we could grep.
#
# This block adds four cheap pieces of telemetry:
#
#   1. /healthz — rich JSON status (uptime, DB ok, WAL size, active
#      synth jobs, active SSE conns, RSS). Unauthenticated so external
#      monitoring + curl-from-shell both work without bearer juggling.
#   2. Heartbeat log — every 30s a single line "[heartbeat] uptime=… …"
#      hits stdout. When the line stops appearing in Fly logs we know
#      EXACTLY when the wedge started. Replaces "we have no idea when
#      the process died".
#   3. WAL checkpoint — every 5 min PRAGMA wal_checkpoint(TRUNCATE).
#      SQLite in WAL mode grows the -wal file forever without an
#      explicit checkpoint when no writer is active. On a 1 GB volume
#      a runaway WAL is a real crash vector.
#   4. SSE accounting — global counter incremented when an SSE
#      generator starts and decremented in its finally block. Catches
#      "client disconnected but the generator never exited" leaks.
#
# Deferred to a follow-up so we don't change Fly's restart triggers in
# the same change:
#   - Updating fly.toml [[services.http_checks]] to hit /healthz with a
#     stricter timeout so Fly restarts the machine when /healthz takes
#     >5s (catches wedges within minutes instead of "I noticed because
#     something else broke")
#   - A watchdog thread that kills the process if the heartbeat thread
#     hasn't fired in 2 minutes
# ──────────────────────────────────────────────────────────────────────

import time as _wedge_time

_WEDGE_PROCESS_STARTED_AT = _wedge_time.time()
_WEDGE_HEARTBEAT_COUNT = 0
# v4.84 (#845): wall-clock timestamp of the last heartbeat tick. Used by
# /healthz to detect event-loop wedges — if this hasn't advanced in
# WEDGE_HEARTBEAT_STALE_SEC the asyncio loop is dead and we return 503
# so Fly's HTTP check restarts the machine. Seeded to boot time so a
# cold-started process doesn't false-flag during the grace period before
# the first 30s tick.
_WEDGE_LAST_HEARTBEAT_AT = _WEDGE_PROCESS_STARTED_AT
WEDGE_HEARTBEAT_STALE_SEC = 120
WEDGE_HEARTBEAT_GRACE_SEC = 120
_WEDGE_SSE_ACTIVE = 0
_WEDGE_LAST_WAL_CHECKPOINT_AT = 0.0
_WEDGE_LAST_WAL_SIZE_BYTES = 0


def _wedge_sse_begin():
    """Call when an SSE generator starts (before the first yield)."""
    global _WEDGE_SSE_ACTIVE
    _WEDGE_SSE_ACTIVE += 1


def _wedge_sse_end():
    """Call when an SSE generator exits (in a finally block)."""
    global _WEDGE_SSE_ACTIVE
    if _WEDGE_SSE_ACTIVE > 0:
        _WEDGE_SSE_ACTIVE -= 1


def _wedge_get_rss_bytes() -> int:
    """Resident set size of the current process in bytes, or 0 if
    psutil/resource isn't available. Linux-friendly fallback."""
    try:
        import resource as _res
        # ru_maxrss is in KB on Linux, bytes on macOS — Fly runs Linux.
        return int(_res.getrusage(_res.RUSAGE_SELF).ru_maxrss) * 1024
    except Exception:
        return 0


def _wedge_get_wal_size_bytes() -> int:
    """Size of the SQLite -wal file in bytes, or 0 if missing."""
    try:
        import library_db
        wal = str(library_db.DATA_DIR / "library.db-wal")
        import os
        if os.path.exists(wal):
            return os.path.getsize(wal)
    except Exception:
        pass
    return 0


def _wedge_db_ok() -> bool:
    """Single-shot DB round-trip. Returns False if anything in the
    chain (library_db disabled, connection refused, query fails) is
    sideways."""
    try:
        import library_db
        if not library_db.is_enabled():
            return False
        library_db.conn().execute("SELECT 1").fetchone()
        return True
    except Exception:
        return False


@app.on_event("startup")
async def _schedule_wedge_heartbeat():
    """Background heartbeat: one stdout line every 30 seconds. Gives
    us grep-able evidence the process was alive at time T."""
    import asyncio
    import sys as _sys

    async def _loop():
        global _WEDGE_HEARTBEAT_COUNT, _WEDGE_LAST_HEARTBEAT_AT
        while True:
            try:
                await asyncio.sleep(30)
                _WEDGE_HEARTBEAT_COUNT += 1
                # v4.84 (#845): stamp wall-clock so /healthz can detect
                # event-loop wedges. Stamped BEFORE the rest of the tick
                # body so even an exception in the log line doesn't
                # silently leave us stale.
                _WEDGE_LAST_HEARTBEAT_AT = _wedge_time.time()
                uptime = int(_wedge_time.time() - _WEDGE_PROCESS_STARTED_AT)
                rss_mb = _wedge_get_rss_bytes() // (1024 * 1024)
                # synth_jobs may not have imported on cold boot; guard.
                try:
                    import synth_jobs as _sj
                    active_jobs = len(_sj.list_active_jobs())
                except Exception:
                    active_jobs = -1
                print(
                    f"[heartbeat] tick={_WEDGE_HEARTBEAT_COUNT} "
                    f"uptime={uptime}s jobs={active_jobs} "
                    f"sse={_WEDGE_SSE_ACTIVE} rss={rss_mb}MB",
                    file=_sys.stderr, flush=True,
                )
            except Exception as e:
                # Heartbeat itself must not crash the task — log and
                # continue. If it crashes anyway, the watchdog (future
                # work) catches the gap.
                print(
                    f"[heartbeat] error: {type(e).__name__}: {e}",
                    file=_sys.stderr, flush=True,
                )

    asyncio.create_task(_loop())


@app.on_event("startup")
async def _start_wedge_heartbeat_watchdog():
    """In-process backstop watchdog (#883, completing the #845 Option B).

    The heartbeat coroutine stamps _WEDGE_LAST_HEARTBEAT_AT every 30s and
    /healthz returns 503 when that timestamp is older than 120s — that's
    the *primary* recovery path: Fly's HTTP check sees 503 and recycles
    the machine. This watchdog is the *secondary* path: a native Python
    thread that runs OFF the asyncio loop so it still fires when the
    loop itself is wedged (the exact failure mode #823 was built for).
    If the heartbeat hasn't ticked in WEDGE_WATCHDOG_KILL_SEC AND we're
    past the boot grace, log loudly and call os._exit so Fly's machine-
    death watchdog restarts us.

    Kill threshold is intentionally higher than /healthz's stale
    threshold so the HTTP-check path gets first dibs — this only fires
    when external recovery has failed (e.g. Fly's check isn't reaching
    /healthz, or isn't configured to restart on 503). os._exit is the
    nuclear option: sys.exit raises SystemExit which uvicorn catches.
    """
    import os as _os
    import sys as _sys
    import threading as _threading

    # Higher than WEDGE_HEARTBEAT_STALE_SEC (120s) — give /healthz +
    # Fly's HTTP check a chance to trigger the restart cleanly before
    # we go nuclear.
    WEDGE_WATCHDOG_KILL_SEC = 180
    # Poll cadence. Fast enough to bound time-to-kill to ~15s after
    # the threshold; slow enough that the thread itself is invisible
    # in normal operation.
    WEDGE_WATCHDOG_POLL_SEC = 15

    def _watchdog_loop():
        while True:
            try:
                _wedge_time.sleep(WEDGE_WATCHDOG_POLL_SEC)
                now = _wedge_time.time()
                uptime = now - _WEDGE_PROCESS_STARTED_AT
                if uptime <= WEDGE_HEARTBEAT_GRACE_SEC:
                    continue
                age = now - _WEDGE_LAST_HEARTBEAT_AT
                if age <= WEDGE_WATCHDOG_KILL_SEC:
                    continue
                # Past grace + past kill threshold → the asyncio loop
                # is wedged and external recovery hasn't fired. Log
                # the diagnosis before going down so Fly logs preserve
                # WHY the process died.
                print(
                    f"[watchdog] FATAL: heartbeat stale "
                    f"age={age:.1f}s threshold={WEDGE_WATCHDOG_KILL_SEC}s "
                    f"uptime={uptime:.0f}s — killing process",
                    file=_sys.stderr, flush=True,
                )
                _os._exit(1)
            except Exception as e:
                # The watchdog itself must not crash silently. If we
                # can't even log, there's nothing more to do — the
                # heartbeat thread will eventually trip the same path.
                try:
                    print(
                        f"[watchdog] error: {type(e).__name__}: {e}",
                        file=_sys.stderr, flush=True,
                    )
                except Exception:
                    pass

    t = _threading.Thread(
        target=_watchdog_loop,
        name="wedge-watchdog",
        daemon=True,
    )
    t.start()
    print(
        f"[watchdog] started (kill_threshold={WEDGE_WATCHDOG_KILL_SEC}s, "
        f"poll={WEDGE_WATCHDOG_POLL_SEC}s, "
        f"grace={WEDGE_HEARTBEAT_GRACE_SEC}s)",
        file=_sys.stderr, flush=True,
    )


@app.on_event("startup")
async def _schedule_wedge_wal_checkpoint():
    """Background SQLite WAL checkpoint every 5 minutes. Without this,
    a busy server in WAL mode grows library.db-wal until the disk
    fills up. The (TRUNCATE) variant zeroes the WAL file when no
    reader is holding it open."""
    import asyncio
    import sys as _sys

    async def _loop():
        global _WEDGE_LAST_WAL_CHECKPOINT_AT, _WEDGE_LAST_WAL_SIZE_BYTES
        while True:
            try:
                await asyncio.sleep(300)
                import library_db
                if not library_db.is_enabled():
                    continue
                wal_before = _wedge_get_wal_size_bytes()
                # PRAGMA wal_checkpoint returns 3 ints: busy, log frames,
                # checkpointed frames. We don't use them — just need
                # the truncate side-effect.
                library_db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                _WEDGE_LAST_WAL_CHECKPOINT_AT = _wedge_time.time()
                _WEDGE_LAST_WAL_SIZE_BYTES = _wedge_get_wal_size_bytes()
                # Only log if the WAL was big enough to be interesting
                # (>1 MB) — keeps logs quiet on a healthy server.
                if wal_before > 1024 * 1024:
                    print(
                        f"[wal-checkpoint] truncated "
                        f"before={wal_before // 1024}KB "
                        f"after={_WEDGE_LAST_WAL_SIZE_BYTES // 1024}KB",
                        file=_sys.stderr, flush=True,
                    )
                # Loud warning if WAL is unexpectedly large after
                # truncation (means a long-running reader is holding
                # the snapshot open and blocking the truncate).
                if _WEDGE_LAST_WAL_SIZE_BYTES > 64 * 1024 * 1024:
                    print(
                        f"[wal-checkpoint] WARN: WAL still "
                        f"{_WEDGE_LAST_WAL_SIZE_BYTES // (1024*1024)}MB "
                        f"after TRUNCATE — long-running reader?",
                        file=_sys.stderr, flush=True,
                    )
            except Exception as e:
                print(
                    f"[wal-checkpoint] error: {type(e).__name__}: {e}",
                    file=_sys.stderr, flush=True,
                )

    asyncio.create_task(_loop())


@app.get("/healthz")
def healthz():
    """Rich health endpoint for external monitoring + wedge debugging.

    Unauthenticated by design — checks that DON'T require the key tell
    us the box is alive even when the auth path is wedged. The data
    inside is operational telemetry, not user data.

    v4.84 (#845): returns HTTP 503 when the box is genuinely unhealthy
    so Fly's [[http_service.checks]] can trigger a machine restart. Two
    states qualify as 503:

      1. db.ok is False — the sqlite round-trip threw or library_db
         isn't enabled. Either the volume is gone or the connection
         pool is wedged. Restarting clears both.
      2. Heartbeat is stale — wall-clock minus _WEDGE_LAST_HEARTBEAT_AT
         exceeds WEDGE_HEARTBEAT_STALE_SEC. The heartbeat coroutine
         ticks every 30s; if we haven't ticked in 2 minutes, the
         asyncio event loop is dead. Process is technically alive (so
         a port-binding check would pass) but isn't processing
         requests. Hard restart is the only recovery.

    Grace period of WEDGE_HEARTBEAT_GRACE_SEC after boot so we don't
    falsely 503 during the first 30s tick window. RSS + WAL + SSE
    accounting are advisory — they ride along in the body for
    diagnostics but don't gate the status code.
    """
    import os as _os
    now = _wedge_time.time()
    uptime = int(now - _WEDGE_PROCESS_STARTED_AT)

    # Active synth jobs guarded — synth_jobs module may not be
    # importable in some boot states.
    try:
        import synth_jobs as _sj
        active_jobs = len(_sj.list_active_jobs())
    except Exception:
        active_jobs = -1

    db_ok = _wedge_db_ok()
    heartbeat_age_sec = now - _WEDGE_LAST_HEARTBEAT_AT
    heartbeat_stale = (
        uptime > WEDGE_HEARTBEAT_GRACE_SEC
        and heartbeat_age_sec > WEDGE_HEARTBEAT_STALE_SEC
    )
    healthy = db_ok and not heartbeat_stale

    body = {
        "ok": healthy,
        "uptime_sec": uptime,
        "heartbeat_count": _WEDGE_HEARTBEAT_COUNT,
        "heartbeat_age_sec": round(heartbeat_age_sec, 1),
        "heartbeat_stale": heartbeat_stale,
        "process": {
            "rss_bytes": _wedge_get_rss_bytes(),
        },
        "db": {
            "ok": db_ok,
            "wal_size_bytes": _wedge_get_wal_size_bytes(),
            "last_checkpoint_at": _WEDGE_LAST_WAL_CHECKPOINT_AT,
        },
        "synth": {
            "active_jobs": active_jobs,
        },
        "sse": {
            "active_connections": _WEDGE_SSE_ACTIVE,
        },
        "fly": {
            "machine_id": _os.environ.get("FLY_MACHINE_ID", ""),
            "region": _os.environ.get("FLY_REGION", ""),
            "app_name": _os.environ.get("FLY_APP_NAME", ""),
        },
    }
    return JSONResponse(status_code=200 if healthy else 503, content=body)


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    """Shared-secret auth on /api/* + multi-tenant bearer resolution.

    Two layers in one pass:

    1. **Auth.** Gated by env var `NARRATIVE_KEY`. When unset (default for
       purely-local use), all requests pass through unauthenticated and are
       treated as the admin tenant — convenient for `python server.py` on
       your laptop. When set, `/api/*` requires `X-Narrative-Key` to match
       either NARRATIVE_KEY itself (admin) OR any tester bearer recorded
       in `/data/tenants.json` (v221.tenants-2).

    2. **Tenant.** On every authed request we stash `request.state.tenant_key`
       (sha256 of the bearer) and `request.state.is_admin` (True iff the
       bearer was NARRATIVE_KEY). Library API endpoints use these to scope
       every query, and admin-only endpoints check is_admin. The bearer
       itself is never written to a DB column — only its sha256.

    Carve-outs (no auth, no tenant):
      - Static files (anything not under /api/) — the frontend has to boot
        before it can prompt for the key.
      - /api/voices/sample/* — sample previews use <audio src=...> which
        can't carry a header. Samples are already public on HuggingFace.
      - /api/github/oauth/* — the OAuth round-trip is hit via redirect,
        not fetch, so the header isn't available. (v180 carve-out.)
      - /api/gdrive/oauth/callback — same redirect-with-no-header reason,
        but ONLY the callback (Drive stores tokens per tenant, so start /
        status / fetch must stay authed). (#896)
    """
    # v225v4.27 (#704): CORS preflight short-circuit. The browser fires
    # OPTIONS before any cross-origin /api/* call to ask "are these
    # headers allowed?" The preflight spec FORBIDS auth headers on the
    # preflight itself, so X-Narrative-Key won't be there even when the
    # follow-up GET/POST will carry it. If we return 401 here, the
    # browser never sends the real request. Let OPTIONS fall through to
    # CORSMiddleware which has the allow_headers / allow_origins config
    # and will respond with the right 200 + Access-Control-* headers.
    if request.method == "OPTIONS":
        return await call_next(request)

    required_key = os.environ.get("NARRATIVE_KEY", "").strip()

    # Local-dev fallthrough. Everything looks like the admin tenant so
    # the library API and admin endpoints work without setup.
    if not required_key:
        request.state.tenant_key = library_db.compute_tenant_key("")
        request.state.is_admin = True
        request.state.tenant_label = "local-admin"
        return await call_next(request)

    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    if path.startswith("/api/voices/sample/"):
        return await call_next(request)
    if path.startswith("/api/github/oauth/"):
        return await call_next(request)
    # Only the Drive OAuth *callback* is carved out — it's hit via
    # Google's top-level redirect with no X-Narrative-Key header. Every
    # other /api/gdrive/* route (start, status, picker-token, fetch,
    # disconnect) stays authed so request.state.tenant_key is known and
    # tokens land on the right tenant. (#896)
    if path == "/api/gdrive/oauth/callback":
        return await call_next(request)
    # v225v4.29 (#707): Tauri updater plugin polls this endpoint
    # without an auth header — it has no concept of NARRATIVE_KEY
    # and returns only public release metadata anyway.
    if path.startswith("/api/updates/"):
        return await call_next(request)

    provided = request.headers.get("X-Narrative-Key", "")
    if not provided:
        return JSONResponse(
            status_code=401,
            content={"detail": "missing X-Narrative-Key"},
        )

    # Admin check first — constant-time compare against env var.
    if hmac.compare_digest(
        provided.encode("utf-8"), required_key.encode("utf-8")
    ):
        request.state.tenant_key = library_db.compute_tenant_key(required_key)
        request.state.is_admin = True
        request.state.tenant_label = "admin"
        # Fire-and-forget last-seen update (no await needed; the helper
        # is sync + cheap + minute-bucketed).
        library_db.touch_tenant_seen(request.state.tenant_key)
        blocked = _enforce_2fa(request, request.state.tenant_key, path)
        if blocked is not None:
            return blocked
        return await call_next(request)

    # Tester check — sha256(bearer) lookup in /data/tenants.json. The
    # helper does its own hashing so a leaky log line doesn't expose
    # the bearer.
    record = library_db.find_bearer(provided)
    if record is not None:
        request.state.tenant_key = record["tenant_key"]
        request.state.is_admin = False
        request.state.tenant_label = record.get("label", "")
        library_db.touch_tenant_seen(record["tenant_key"])
        blocked = _enforce_2fa(request, request.state.tenant_key, path)
        if blocked is not None:
            return blocked
        return await call_next(request)

    return JSONResponse(
        status_code=401,
        content={"detail": "invalid X-Narrative-Key"},
    )


# v225v4.30: CORS for the Tauri desktop shell. The Tauri app loads
# index.html from the bundled assets (tauri://localhost on
# macOS/Linux, https://tauri.localhost on Windows) and hits this
# server's /api/* cross-origin.
#
# ⚠ Order matters. `add_middleware` LAST = OUTERMOST. We need CORS
# to wrap require_api_key so the 401 it returns gets CORS headers
# stamped on it on the way out — otherwise the browser blocks the
# response and the user sees "Failed to fetch" with no diagnostic.
# (v4.27 had this registration ABOVE the auth decorator, so auth
# was the outer layer and 401s went out bare. Confirmed via curl:
# the 401 came back without access-control-allow-origin.)
#
# Auth is still required (X-Narrative-Key on every /api/* call), so
# permissive allow_origins doesn't lower the bar — an unauth'd call
# gets 401 regardless of origin. allow_credentials is False because
# we use a custom header rather than cookies; that lets us list
# specific origins instead of "*" while keeping the app working.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # Tauri production webview origins (differ per platform AND
        # per Tauri version). Tauri v2 on Windows uses the HTTP variant
        # `http://tauri.localhost` — confirmed via DevTools on a real
        # v4.53 install: every /api/* fetch sent
        #   Origin: http://tauri.localhost
        # and got blocked by CORS because we only listed the HTTPS
        # variant. The HTTPS one (Tauri v1 on Windows) and the bare
        # tauri:// scheme (macOS/Linux) stay for backward compat. Cost
        # of listing all three: zero — the bearer key check still gates
        # every endpoint, so allow-origin breadth doesn't lower the bar.
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        # Local dev — running `tauri dev` against a local Narrative
        # server (server.py on :8000) or the prod Fly URL.
        "http://localhost:8000",
        "http://localhost:1430",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:1430",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        # Headers the existing splice + sentence-offset paths rely on
        # being readable from cross-origin responses.
        "X-Narrative-Sentences",
        "X-Narrative-Audio-Sha256",
        "X-Audiable-Sentences",
    ],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500_000)
    voice_id: str | None = None
    rate: int | None = Field(default=None, ge=50, le=400)
    volume: float | None = Field(default=None, ge=0.0, le=1.0)
    # 0..num_speakers-1. Ignored for single-speaker voices and for SAPI.
    # Upper bound is enforced by Piper's model at synth time, not here, since
    # the request can target any voice and we don't want to special-case.
    speaker_id: int | None = Field(default=None, ge=0, le=10000)


class SynthJobCreateRequest(SynthesizeRequest):
    """SynthesizeRequest + Phase B per-sentence cache targets (#811 B.2b).

    When both fields are set, the worker writes each sentence's WAV to
    the sentence_audio cache as it's yielded by the engine. Audio
    quality matches the combined MP3 (same `synthesize_iter()` call,
    shared warmup) — which is the whole reason this path exists vs the
    spike's per-sentence /api/synthesize approach.

    Both-or-neither: the JobParams loader rejects partial sets so we
    don't need a Pydantic validator here.
    """
    target_clip_id: int | None = Field(default=None, ge=1)
    target_line_ids: list[str] | None = Field(default=None, max_length=10000)
    # Display label, carried so a client that reattaches on boot can
    # label the pill + save the clip without the original chapter.
    title: str | None = Field(default=None, max_length=300)
    # v4.111: the library clip to overwrite (re-narrate target). Distinct
    # from target_clip_id (Phase B cache opt-in) — carried so a reattach
    # rebinds to the original card instead of creating a duplicate.
    clip_id: int | None = Field(default=None, ge=1)


class SynthesisSegment(BaseModel):
    text: str = Field(..., min_length=1, max_length=500_000)
    voice_id: str | None = None
    speaker_id: int | None = Field(default=None, ge=0, le=10000)


class SynthesizeSegmentsRequest(BaseModel):
    segments: list[SynthesisSegment] = Field(..., min_length=1, max_length=2000)
    rate: int | None = Field(default=None, ge=50, le=400)
    volume: float | None = Field(default=None, ge=0.0, le=1.0)


# ──────────────────────────────────────────────────────────────────────
# v221.sync-2: server-side library health.
# Real CRUD endpoints land in sync-3. This is just the "is the DB up?"
# probe so the deploy + volume mount can be verified independently of
# the rest of the sync work.
# ──────────────────────────────────────────────────────────────────────
@app.get("/api/library/health")
def library_health():
    import library_db

    if not library_db.is_enabled():
        raise HTTPException(
            status_code=503,
            detail=f"library DB disabled: {library_db.disabled_reason()}",
        )
    # Round-trip a trivial query to confirm the connection actually works.
    try:
        row = library_db.conn().execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        schema_version = int(row["version"]) if row else 0
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB read failed: {e}")
    return {
        "ok": True,
        "schema_version": schema_version,
        "data_dir": str(library_db.DATA_DIR),
    }


@app.get("/api/voices")
def voices():
    return {
        "voices": [
            {
                "id": v.id,
                "name": v.name,
                "languages": v.languages,
                "gender": v.gender,
                "engine": v.engine,
                "num_speakers": v.num_speakers,
            }
            for v in tts.list_voices()
        ]
    }


@app.get("/api/voices/catalog")
def voices_catalog():
    """Full Piper voice catalog with an `installed` flag per entry."""
    from tts import catalog

    try:
        return {"voices": catalog.list_for_ui()}
    except Exception as e:
        raise HTTPException(
            status_code=503, detail=f"could not load voice catalog: {e}"
        )


class InstallVoiceRequest(BaseModel):
    voice_id: str = Field(..., min_length=3, max_length=128)


@app.post("/api/voices/install")
async def voices_install(req: InstallVoiceRequest):
    """Download a Piper voice into voices/. Idempotent if already present."""
    import asyncio

    from tts import catalog

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, catalog.download_voice, req.voice_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "voice_id": req.voice_id}


@app.post("/api/synthesize/segments/stream")
async def synthesize_segments_stream(req: SynthesizeSegmentsRequest):
    """SSE endpoint: multi-segment synthesis with per-segment voice/speaker.

    Used by character-voice mode. The frontend splits the manuscript into
    segments (attributed dialogue + narration), each with its own voice,
    and posts them here. We synthesize each segment in turn, threading
    through the existing per-sentence streaming flow so the UI still gets
    granular progress and per-sentence playback. Final result is the
    concatenated audio, MP3-encoded like /api/synthesize/stream does.
    """
    import asyncio
    import base64
    import json as _json

    from tts.encode import wav_to_mp3

    _DONE = object()

    async def _agen():
        loop = asyncio.get_running_loop()
        try:
            it = tts.synthesize_segments_iter(
                segments=[s.model_dump() for s in req.segments],
                rate=req.rate,
                volume=req.volume,
            )
        except ValueError as exc:
            yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return

        def _next_event():
            try:
                return next(it)
            except StopIteration:
                return _DONE

        def _encode_result(ev: dict) -> dict:
            wav_bytes = base64.b64decode(ev["wav_b64"])
            mp3_bytes = wav_to_mp3(wav_bytes, bitrate_kbps=64)
            # v221.sync-4: persist the MP3 server-side so other devices
            # syncing this clip get a ready-to-stream blob instead of
            # needing to re-synthesize. Content-addressed by sha256 so
            # re-narrating with the same voice+text dedups. Guarded:
            # a volume hiccup mustn't break the in-flight synth — the
            # client still gets mp3_b64 in this event regardless.
            audio_sha = None
            try:
                import library_db
                if library_db.is_enabled():
                    audio_sha = library_db.store_audio(mp3_bytes)
            except Exception as e:
                print(
                    f"[synthesize/stream] audio persist failed: {e}",
                    file=sys.stderr, flush=True,
                )
            out = {
                "type": "result",
                "mp3_b64": base64.b64encode(mp3_bytes).decode(),
                "sentence_offsets_ms": ev["sentence_offsets_ms"],
            }
            if audio_sha:
                out["audio_sha256"] = audio_sha
            return out

        while True:
            try:
                event = await loop.run_in_executor(None, _next_event)
            except Exception as exc:
                # Full traceback to the server log so we can diagnose
                # without waiting for the user to paste a stderr scroll.
                # The frontend only sees the short message; the log gets
                # the file/line where it actually died.
                import traceback as _tb
                print(
                    "[synthesize/stream] synth iter raised:",
                    file=sys.stderr, flush=True,
                )
                _tb.print_exc()
                yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
                break
            if event is _DONE:
                break
            if event.get("type") == "result":
                try:
                    event = await loop.run_in_executor(None, _encode_result, event)
                except Exception as exc:
                    import traceback as _tb
                    print(
                        f"[synthesize/stream] mp3 encode failed: {exc}",
                        file=sys.stderr, flush=True,
                    )
                    _tb.print_exc()
                    yield f"data: {_json.dumps({'type': 'error', 'message': f'mp3 encode failed: {exc}'})}\n\n"
                    break
            yield f"data: {_json.dumps(event)}\n\n"

    return StreamingResponse(
        _sse_with_keepalive(_agen()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.delete("/api/voices/{voice_id}")
def voices_remove(voice_id: str):
    """Uninstall a Piper voice — deletes its .onnx + .onnx.json from voices/."""
    from tts import catalog

    try:
        catalog.remove_voice(voice_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"voice not installed: {voice_id}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"could not remove voice: {e}")
    return {"ok": True, "voice_id": voice_id}


@app.post("/api/voices/install/stream")
async def voices_install_stream(req: InstallVoiceRequest):
    """SSE endpoint: streams byte-level download progress while installing.

    Events:
      {"type":"start","voice_id":"...","total_bytes":N}
      {"type":"progress","downloaded":N,"total":M}
      {"type":"done","voice_id":"..."}
      {"type":"error","message":"..."}
    """
    import asyncio
    import json as _json

    from tts import catalog

    _DONE = object()

    async def _agen():
        loop = asyncio.get_running_loop()
        try:
            it = catalog.download_voice_iter(req.voice_id)
        except ValueError as exc:
            yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return

        def _next_event():
            try:
                return next(it)
            except StopIteration:
                return _DONE

        while True:
            try:
                event = await loop.run_in_executor(None, _next_event)
            except RuntimeError as exc:
                # Network failure mid-download — surface as an error event so
                # the frontend can flip the button to "Failed" cleanly.
                yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
                break
            except Exception as exc:
                yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
                break
            if event is _DONE:
                break
            yield f"data: {_json.dumps(event)}\n\n"

    return StreamingResponse(
        _agen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ─── v225v4.29 (#707) — Tauri auto-updater manifest endpoint ──────────
#
# The Tauri updater plugin polls this URL on launch + when the user
# clicks Help → Check for updates…. It substitutes {{target}} and
# {{current_version}} into the endpoint template from tauri.conf.json.
#
# Protocol (see https://v2.tauri.app/plugin/updater/):
#   - 204 No Content  → no update available, plugin stays quiet
#   - 200 + JSON      → manifest with version + per-target signature
#
# To ship a new desktop release:
#   1. bump LATEST_DESKTOP_VERSION below (and src-tauri/Cargo.toml +
#      src-tauri/tauri.conf.json to match)
#   2. cargo tauri build         → produces .msi.zip / .dmg / .AppImage
#   3. cargo tauri signer sign … → emits .sig file alongside each bundle
#   4. upload signed bundles to a CDN or our /downloads/ static dir
#   5. paste base64 signatures into DESKTOP_SIGNATURES below
#   6. deploy
#
# See UPDATES.md at repo root for the full release runbook.

LATEST_DESKTOP_VERSION = "0.1.8"

# target → base64 Ed25519 signature (output of `cargo tauri signer sign`).
# Empty dict means "no signed bundles yet" — endpoint returns 204 for
# every target until someone ships an actual release.
#
# v4.65 (#858): first real signature paste lands here. The Windows
# value is the base64 contents of Narrative_0.1.2_x64-setup.exe.sig
# from the v0.1.2 GitHub Release, generated by tauri-action with
# TAURI_SIGNING_PRIVATE_KEY (Ed25519). The Tauri updater plugin
# embeds the matching pubkey at build time (tauri.conf.json) and
# rejects any bundle whose download bytes don't verify against this
# signature — so we paste the signature server-side, the plugin
# downloads and verifies, the user clicks install. The string is one
# very long base64 blob with embedded \n characters preserved exactly
# as `cargo tauri signer` emitted; do NOT reflow or strip whitespace.
#
# v4.98 (#859): refactored to per-platform-KEY rather than per-target
# so macOS's two architectures can carry distinct bundle URLs +
# signatures. The Tauri 2 updater plugin sends an OS-only `target` in
# the URL ("windows" / "darwin" / "linux") but probes the manifest's
# `platforms` object using OS-arch-installer keys ("darwin-aarch64",
# "windows-x86_64-nsis", etc). Windows entries duplicate the same
# .exe + sig under both windows keys because Tauri only emits one
# x64 NSIS installer regardless. macOS gets per-arch files now that
# release.yml renames Narrative.app.tar.gz to Narrative_aarch64 /
# Narrative_x64 variants before artifact upload (#859).
#
# v4.66 (#867) DIAGNOSED FROM FLY LOGS 2026-06-08: the {{target}}
# substitution is OS-only, not per-arch. Server keys match what the
# plugin actually sends. v4.98 (#859) preserves that — the {{target}}
# path is still OS-only; the per-arch SPLIT only happens inside the
# returned manifest's `platforms` object, which is exactly how the
# Tauri 2 plugin documents its lookup.
#
# Adding a new signature:
#   - Windows: paste the .sig from Narrative_{ver}_x64-setup.exe.sig
#     into BOTH windows keys (same file, same sig).
#   - macOS: paste each arch's .sig under its own key
#     (Narrative_aarch64.app.tar.gz.sig → darwin-aarch64, etc).
#   - Linux: paste the AppImage .sig under linux-x86_64.
DESKTOP_SIGNATURES_BY_KEY: dict[str, str] = {
    "windows-x86_64-nsis": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTN2pHQUZTR0s1akUvZVptVnZKaHJ5SitpWGxaUHJFQVdHalN5UEZmTGl4QVJDUGthczhtZWtHL3VURWZlbDlWMHltRkpZN1ZMcm5yL0FjZ2NubnFKLzVDTiswQXdBN2c0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgxMDYwMTU1CWZpbGU6TmFycmF0aXZlXzAuMS44X3g2NC1zZXR1cC5leGUKbmtPWFBFVzdTdjBnWklPSDhTeEVJZUxsTVd2bjZlTWtUS0tUZGMva2FmV202UjJhVnlIRlF2TEVPelloVTFIY1lFL3pJbnRNakNseHAvOGV2cnZXREE9PQo=",
    "windows-x86_64":      "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTN2pHQUZTR0s1akUvZVptVnZKaHJ5SitpWGxaUHJFQVdHalN5UEZmTGl4QVJDUGthczhtZWtHL3VURWZlbDlWMHltRkpZN1ZMcm5yL0FjZ2NubnFKLzVDTiswQXdBN2c0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgxMDYwMTU1CWZpbGU6TmFycmF0aXZlXzAuMS44X3g2NC1zZXR1cC5leGUKbmtPWFBFVzdTdjBnWklPSDhTeEVJZUxsTVd2bjZlTWtUS0tUZGMva2FmV202UjJhVnlIRlF2TEVPelloVTFIY1lFL3pJbnRNakNseHAvOGV2cnZXREE9PQo=",
    # macOS sigs blocked until v0.1.9 ships with the new per-arch
    # filenames (release.yml rename step is in this commit, but the
    # CURRENT v0.1.8 release still has the old Narrative.app.tar.gz).
    # Once v0.1.9 is tagged + the workflow lands, paste:
    #   "darwin-aarch64": <Narrative_aarch64.app.tar.gz.sig contents>,
    #   "darwin-x86_64":  <Narrative_x64.app.tar.gz.sig contents>,
    # "linux-x86_64": "...",  # add after smoke-test on a Linux install
}

# v4.65 (#858): switched from Fly /downloads to GitHub Releases. Pros:
# free hosting, version-immutable, no Fly bandwidth quota. The full URL
# the Tauri updater plugin fetches is built per-platform-key below.
DESKTOP_DOWNLOAD_BASE = "https://github.com/hypeman271-oss/audiable/releases/download"

# v4.98 (#859): per-platform-KEY bundle filename templates. {ver} is
# replaced with LATEST_DESKTOP_VERSION. macOS keys point at the
# arch-suffixed files produced by the release.yml rename step (also
# in this commit). The signature dict above gates whether each key
# actually appears in the served manifest — keys here without sigs
# are silently dropped, which is how we keep the next-version rollout
# safe while macOS sigs are still TBD.
DESKTOP_BUNDLE_NAMES_BY_KEY: dict[str, str] = {
    # NSIS .exe installer (preferred over MSI for in-place updates
    # because Tauri's updater plugin can drive NSIS silent-install
    # cleanly; MSI swap mid-process is fussier).
    "windows-x86_64-nsis": "Narrative_{ver}_x64-setup.exe",
    "windows-x86_64":      "Narrative_{ver}_x64-setup.exe",
    # Per-arch macOS — renamed by release.yml step "Rename macOS
    # bundles for per-arch release (#859)".
    "darwin-aarch64":      "Narrative_aarch64.app.tar.gz",
    "darwin-x86_64":       "Narrative_x64.app.tar.gz",
    "linux-x86_64":        "Narrative_{ver}_amd64.AppImage",
}


def _parse_semver(v: str) -> tuple[int, int, int]:
    """Naive SemVer parse — handles "0.1.0", "v0.1.0", "0.1.0-beta.1"."""
    try:
        head = v.lstrip("v").split("-", 1)[0].split("+", 1)[0]
        parts = (head.split(".") + ["0", "0", "0"])[:3]
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, AttributeError):
        return (0, 0, 0)


# v4.67 (#867 follow-up) + v4.98 (#859): the Tauri 2 updater plugin
# probes the manifest's `platforms` object for per-arch + installer-
# type keys, NOT the OS-only target it sent in the URL. Documented
# error message (caught 2026-06-08): "None of the fallback platforms
# ['windows-x86_64-nsis', 'windows-x86_64'] were found in the response
# `platforms` object" — that IS the documented fallback chain. Each
# OS-target maps to the list of platform keys the plugin will probe.
_PLATFORM_KEYS_BY_TARGET = {
    "windows": ["windows-x86_64-nsis", "windows-x86_64"],
    "darwin":  ["darwin-aarch64", "darwin-x86_64"],
    "linux":   ["linux-x86_64"],
}


@app.get("/api/updates/latest/{target}/{current_version}")
def check_for_update(target: str, current_version: str):
    """Tauri updater manifest endpoint. See LATEST_DESKTOP_VERSION above."""
    if _parse_semver(current_version) >= _parse_semver(LATEST_DESKTOP_VERSION):
        return Response(status_code=204)

    # v4.98 (#859): build the platforms object per-KEY rather than
    # collapsing to one URL per target. macOS aarch64 + x86_64 now
    # point at different files; Windows keeps both keys pointing at
    # the same .exe because Tauri emits a single x64 installer.
    keys = _PLATFORM_KEYS_BY_TARGET.get(target, [target])
    platforms: dict[str, dict[str, str]] = {}
    for key in keys:
        sig = DESKTOP_SIGNATURES_BY_KEY.get(key)
        filename_template = DESKTOP_BUNDLE_NAMES_BY_KEY.get(key)
        if not sig or not filename_template:
            # Key without a paste-ready sig (e.g. macOS pre-v0.1.9) or
            # without a bundle template silently drops out of the
            # manifest. The plugin gracefully treats a key it asked
            # for but didn't receive as "no update for this platform"
            # — same UX as a 204.
            continue
        bundle_name = filename_template.format(ver=LATEST_DESKTOP_VERSION)
        bundle_url = (
            f"{DESKTOP_DOWNLOAD_BASE}/"
            f"v{LATEST_DESKTOP_VERSION}/{bundle_name}"
        )
        platforms[key] = {"signature": sig, "url": bundle_url}

    if not platforms:
        # No signed bundles for any platform key under this target.
        return Response(status_code=204)

    return JSONResponse({
        "version": LATEST_DESKTOP_VERSION,
        "notes": "See https://narrative-alpha.fly.dev/whats-new.html",
        "pub_date": "2026-06-07T00:00:00Z",
        "platforms": platforms,
    })


@app.get("/api/voices/sample/{voice_id}")
async def voice_sample(voice_id: str, speaker: int = 0):
    """Return a preview MP3/WAV for a (voice, speaker) pair.

    Routing:
      - kokoro:* voices are synth'd on-the-fly from a short fixed
        sentence (no upstream sample server publishes them).
      - everything else proxies the official Piper sample MP3 from
        rhasspy/piper-voices on HuggingFace.
    `?speaker=N` picks a speaker for multi-speaker Piper models; Kokoro
    voices are single-speaker and ignore it. The browser cache header
    keeps repeated taps off the network.
    """
    import asyncio

    if speaker < 0 or speaker > 10000:
        raise HTTPException(status_code=400, detail="speaker out of range")

    loop = asyncio.get_running_loop()

    # v220au: Kokoro preview path. The Piper catalog publishes
    # sample MP3s alongside each voice; Kokoro doesn't, so we
    # synth one here. Same fixed sentence for every voice so the
    # user can A/B them on the same content — and it's the
    # canonical pangram, brief enough to render in ~1s on CPU.
    if voice_id.startswith("kokoro:"):
        import sys as _sys
        import traceback as _tb

        from tts import kokoro_engine

        # v220ax: if Kokoro is still warming up from a cold boot, wait
        # for it instead of racing it. Past the first ~15s of uptime
        # this is a no-op (event already set).
        await _await_kokoro_warmup()

        SAMPLE_TEXT = (
            "The quick brown fox jumps over the lazy dog. "
            "Hear me read a sentence in this voice."
        )
        try:
            result = await loop.run_in_executor(
                None,
                lambda: kokoro_engine.synthesize(
                    text=SAMPLE_TEXT,
                    voice_id=voice_id,
                ),
            )
        except FileNotFoundError as e:
            print(
                f"[kokoro-preview] FileNotFoundError for {voice_id!r}: {e!r}",
                file=_sys.stderr, flush=True,
            )
            raise HTTPException(
                status_code=404,
                detail=f"Kokoro voice unavailable: {e}",
            )
        except ValueError as e:
            print(
                f"[kokoro-preview] ValueError for {voice_id!r}: {e!r}",
                file=_sys.stderr, flush=True,
            )
            _tb.print_exc()
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            print(
                f"[kokoro-preview] {type(e).__name__} for {voice_id!r}: {e!r}",
                file=_sys.stderr, flush=True,
            )
            _tb.print_exc()
            raise HTTPException(
                status_code=502,
                detail=f"Kokoro preview failed ({type(e).__name__}): {e}",
            )
        return Response(
            content=result.wav,
            media_type="audio/wav",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    from tts import catalog

    try:
        data = await loop.run_in_executor(
            None, catalog.fetch_sample, voice_id, speaker
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="no preview available")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"sample fetch failed: {e}")
    return Response(
        content=data,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/api/synthesize")
def synthesize(req: SynthesizeRequest):
    try:
        result = tts.synthesize(
            text=req.text,
            voice_id=req.voice_id,
            rate=req.rate,
            volume=req.volume,
            speaker_id=req.speaker_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result.wav:
        raise HTTPException(status_code=500, detail="synthesis produced no audio")

    # Sentence offsets travel in a custom header so the frontend gets both
    # audio bytes and per-sentence start times in one round trip. Compact
    # JSON keeps the header well under the typical 8KB server limit even for
    # very long inputs.
    import json as _json
    offsets_json = _json.dumps(result.sentence_offsets_ms, separators=(",", ":"))

    return Response(
        content=result.wav,
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'attachment; filename="narrative.wav"',
            "X-Narrative-Sentences": offsets_json,
            "Access-Control-Expose-Headers": "X-Narrative-Sentences",
        },
    )


# v592 / #584: inline single-sentence splice. Re-synthesize one sentence
# in the same voice as the rest of the clip, then PCM-decode-splice it
# into the existing MP3. Stateless: caller uploads the existing audio
# + the offsets table + the new text. Returns a new MP3 + a shifted
# offsets table. See tts/splice.py for the rationale.
#
# Multipart form (no JSON body — FastAPI doesn't mix UploadFile with a
# pydantic JSON body cleanly). Fields:
#   audio:           file (MP3 bytes of the existing clip)
#   params:          JSON string with all the rest
# `params` schema (validated below):
#   {
#     "voice_id": "kokoro:..." | "piper:..." | "...",
#     "speaker_id": int | null,
#     "rate": int | null,
#     "index": int,                # which sentence to replace
#     "text": str,                 # new sentence text
#     "sentence_offsets_ms": [int] # current offset table (len == sentence count)
#   }
@app.post("/api/synthesize/splice")
async def synthesize_splice(
    audio: UploadFile = File(...),
    params: str = Form(...),
):
    import json as _json
    from tts import splice as _splice

    if not audio.filename:
        raise HTTPException(status_code=400, detail="no audio file")
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty audio file")
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"audio too large ({len(audio_bytes)} bytes, max {MAX_UPLOAD_BYTES})",
        )

    try:
        p = _json.loads(params)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"params not valid JSON: {e}")
    if not isinstance(p, dict):
        raise HTTPException(status_code=400, detail="params must be a JSON object")

    text = (p.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > 50_000:
        raise HTTPException(status_code=400, detail="text too long for a single sentence")
    voice_id = p.get("voice_id")
    speaker_id = p.get("speaker_id")
    rate = p.get("rate")

    index = p.get("index")
    if not isinstance(index, int):
        raise HTTPException(status_code=400, detail="index must be an integer")
    offsets = p.get("sentence_offsets_ms")
    if (not isinstance(offsets, list)
            or not offsets
            or not all(isinstance(o, int) for o in offsets)):
        raise HTTPException(
            status_code=400,
            detail="sentence_offsets_ms must be a non-empty list of ints",
        )
    if index < 0 or index >= len(offsets):
        raise HTTPException(
            status_code=400,
            detail=f"index {index} out of range [0, {len(offsets)})",
        )

    # Synthesize the replacement sentence as WAV. Same voice/speaker/rate
    # as the original keeps the seam as close to imperceptible as possible
    # — Kokoro / Piper are deterministic given the same inputs, so two
    # neighbouring sentences sound consistent.
    try:
        result = tts.synthesize(
            text=text,
            voice_id=voice_id,
            rate=rate,
            volume=None,
            speaker_id=speaker_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result.wav:
        raise HTTPException(
            status_code=500,
            detail="replacement-sentence synthesis produced no audio",
        )

    # Splice — CPU-bound (ffmpeg subprocess); offload to thread pool so
    # the event loop stays responsive while a long MP3 re-encodes.
    import asyncio
    loop = asyncio.get_running_loop()
    try:
        new_mp3, new_offsets = await loop.run_in_executor(
            None,
            _splice.splice_sentence,
            audio_bytes,
            offsets,
            index,
            result.wav,
        )
    except _splice.SpliceError as e:
        raise HTTPException(status_code=422, detail=f"splice failed: {e}")
    except Exception as e:
        # Surface ffmpeg/missing-binary failures with a useful message
        # instead of a bare 500.
        import traceback as _tb
        print("[synthesize/splice] unexpected failure:", file=sys.stderr, flush=True)
        _tb.print_exc()
        raise HTTPException(status_code=500, detail=f"splice failed: {e}")

    # Optionally persist via the library-db audio cache. Same hook the
    # full-synth endpoints use — if the user has synced this clip, the
    # spliced MP3 is the new authoritative audio, so caching here means
    # /api/library/audio/{sha} can serve it immediately.
    audio_sha = None
    try:
        if library_db.is_enabled():
            audio_sha = library_db.store_audio(new_mp3)
    except Exception as e:
        print(
            f"[synthesize/splice] audio persist failed: {e}",
            file=sys.stderr, flush=True,
        )

    offsets_json = _json.dumps(new_offsets, separators=(",", ":"))
    headers = {
        "Content-Disposition": 'attachment; filename="narrative-spliced.mp3"',
        "X-Narrative-Sentences": offsets_json,
        "Access-Control-Expose-Headers":
            "X-Narrative-Sentences,X-Narrative-Audio-Sha256",
    }
    if audio_sha:
        headers["X-Narrative-Audio-Sha256"] = audio_sha
    return Response(content=new_mp3, media_type="audio/mpeg", headers=headers)


@app.post("/api/synthesize/stream")
async def synthesize_stream(req: SynthesizeRequest):
    """SSE endpoint: streams one sentence event per sentence, then a result event.

    Events are newline-delimited `data: <json>\\n\\n` (standard SSE).
    Sentence: {"type":"sentence","index":i,"total":N,"offset_ms":int,"wav_b64":"..."}
    Result:   {"type":"result","mp3_b64":"...","sentence_offsets_ms":[...]}
    Error:    {"type":"error","message":"..."}

    Per-sentence audio is shipped as WAV (small individually, plays with
    zero decoding latency); the final combined audio is transcoded to MP3
    (~5x smaller) so the download and IndexedDB row don't bloat.
    """
    import asyncio
    import base64
    import json as _json

    from tts.encode import wav_to_mp3

    _DONE = object()

    async def _agen():
        loop = asyncio.get_running_loop()
        try:
            it = tts.synthesize_iter(
                text=req.text,
                voice_id=req.voice_id,
                rate=req.rate,
                volume=req.volume,
                speaker_id=req.speaker_id,
            )
        except ValueError as exc:
            yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return

        def _next_event():
            # Wrap next() so StopIteration doesn't leak into the coroutine
            # (Python converts it to RuntimeError inside async context).
            try:
                return next(it)
            except StopIteration:
                return _DONE

        def _encode_result(ev: dict) -> dict:
            """Transcode the combined WAV to MP3 for the final result event."""
            wav_bytes = base64.b64decode(ev["wav_b64"])
            mp3_bytes = wav_to_mp3(wav_bytes, bitrate_kbps=64)
            # v221.sync-4: same server-side persist hook as the
            # single-voice path. See /api/synthesize/stream for the
            # rationale; segments synths (multi-character chapters)
            # are even MORE valuable to cache because they're slower
            # to produce — phone fetching one shouldn't ever need to
            # re-run a 90s segment synth.
            audio_sha = None
            try:
                import library_db
                if library_db.is_enabled():
                    audio_sha = library_db.store_audio(mp3_bytes)
            except Exception as e:
                print(
                    f"[synthesize/segments/stream] audio persist failed: {e}",
                    file=sys.stderr, flush=True,
                )
            out = {
                "type": "result",
                "mp3_b64": base64.b64encode(mp3_bytes).decode(),
                "sentence_offsets_ms": ev["sentence_offsets_ms"],
            }
            if audio_sha:
                out["audio_sha256"] = audio_sha
            return out

        while True:
            try:
                event = await loop.run_in_executor(None, _next_event)
            except Exception as exc:
                import traceback as _tb
                print(
                    "[synthesize/segments/stream] synth iter raised:",
                    file=sys.stderr, flush=True,
                )
                _tb.print_exc()
                yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
                break
            if event is _DONE:
                break
            if event.get("type") == "result":
                # Encoding is CPU-bound; run it in the thread pool so the
                # event loop stays free for other connections.
                try:
                    event = await loop.run_in_executor(None, _encode_result, event)
                except Exception as exc:
                    import traceback as _tb
                    print(
                        f"[synthesize/segments/stream] mp3 encode failed: {exc}",
                        file=sys.stderr, flush=True,
                    )
                    _tb.print_exc()
                    yield f"data: {_json.dumps({'type': 'error', 'message': f'mp3 encode failed: {exc}'})}\n\n"
                    break
            yield f"data: {_json.dumps(event)}\n\n"

    return StreamingResponse(
        _sse_with_keepalive(_agen()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # tell nginx not to buffer SSE
        },
    )


# v226 / #512: server-side resumable synthesis. See synth_jobs.py for
# the worker / state model. Endpoints expose: create a job → subscribe
# to its stream → reconnect mid-stream with ?from=N → check status →
# cancel. Synthesis lives in a detached asyncio task that survives the
# originating HTTP request, so a client disconnect (mobile lock, Fly
# load balancer drop, deploy roll) no longer kills the synth.


@app.post("/api/synth/jobs")
async def synth_jobs_create(req: SynthJobCreateRequest, request: Request):
    """Create a synth job, kick off its background worker, return id.

    Returns immediately with {job_id, sentences_total: 0}. The caller
    follows with GET /api/synth/jobs/{id}/stream to receive events.
    If the stream drops, GET again with ?from=N to resume.

    Optional Phase B cache targets (#811 B.2b): when
    `target_clip_id` + `target_line_ids` are both provided, the worker
    writes each sentence's WAV to the per-sentence cache as it's
    yielded. The clip must exist in this tenant's library, must have
    `lines_json` set (Phase A opt-in), and `target_line_ids` must
    match the engine's sentence count exactly — otherwise the job
    fails fast to avoid corrupting the cache.
    """
    tenant_key = getattr(request.state, "tenant_key", None)
    # Phase B opt-in validation: if cache targets are set, the clip
    # must actually exist for this tenant. We surface this as a 400
    # rather than letting the worker silently fail the job — the
    # client deserves an immediate "no, that clip isn't yours" rather
    # than burning a synth pass to find out.
    if req.target_clip_id is not None or req.target_line_ids is not None:
        if not library_db.is_enabled():
            raise HTTPException(
                status_code=400,
                detail="per-sentence cache targets require library_db; "
                "the server is running without it",
            )
        if req.target_clip_id is None or not req.target_line_ids:
            raise HTTPException(
                status_code=400,
                detail="target_clip_id and target_line_ids must be "
                "provided together",
            )
        row = library_db.conn().execute(
            """
            SELECT lines_json
            FROM clips
            WHERE tenant_key = ? AND id = ? AND deleted = 0
            """,
            (tenant_key, req.target_clip_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=404,
                detail=f"target_clip_id={req.target_clip_id} not found "
                "for this tenant",
            )
        lines = library_db.jsload(row["lines_json"]) or []
        if not lines:
            raise HTTPException(
                status_code=409,
                detail=f"target_clip_id={req.target_clip_id} has no "
                "lines_json — enable Phase A per-sentence storage on "
                "this clip before requesting per-sentence cache",
            )
        # Validate every line_id the caller passed actually exists in
        # the clip's lines_json. Mismatch here means client and server
        # disagree about the sentence set — better to refuse than to
        # let the worker write to ids that won't survive the next
        # lines_json read.
        clip_line_ids = {
            l.get("id") for l in lines
            if isinstance(l, dict) and l.get("id")
        }
        for lid in req.target_line_ids:
            if lid not in clip_line_ids:
                raise HTTPException(
                    status_code=404,
                    detail=f"line_id {lid!r} not present in clip's lines",
                )
    params = synth_jobs.JobParams.from_dict({
        "text": req.text,
        "voice_id": req.voice_id,
        "rate": req.rate,
        "volume": req.volume,
        "speaker_id": req.speaker_id,
        "target_clip_id": req.target_clip_id,
        "target_line_ids": req.target_line_ids,
        "title": req.title,
        "clip_id": req.clip_id,
    })
    try:
        job = await synth_jobs.create_job(params, tenant_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"job_id": job.id, "sentences_total": job.sentences_total}


@app.get("/api/synth/jobs/{job_id}")
async def synth_jobs_status(job_id: str, request: Request, detail: int = 0):
    """Snapshot of the job's state. Cheap; safe to poll.

    `?detail=1` returns the heavier reattach payload (full text + synth
    params) the boot-time reattach flow needs to reconstruct + save the
    clip. The reconnect-loop status check uses the light default."""
    job = synth_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="unknown job")
    tenant_key = getattr(request.state, "tenant_key", None)
    if job.tenant_key != tenant_key:
        raise HTTPException(status_code=404, detail="unknown job")
    return job.reattach_detail() if detail else job.snapshot()


@app.get("/api/synth/jobs/{job_id}/stream")
async def synth_jobs_stream(
    job_id: str,
    request: Request,
    from_sentence: int = Query(0, alias="from"),
):
    """SSE stream of the job's events starting from sentence index
    `from`. Replays already-buffered sentences immediately, then
    live-streams. Safe to call repeatedly with increasing from= so
    the client never re-receives sentences it already has.

    `from_sentence` is the actual query-param name `from` (Python
    keyword), exposed via Query(alias=...).
    """
    import json as _json

    job = synth_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="unknown job")
    tenant_key = getattr(request.state, "tenant_key", None)
    if job.tenant_key != tenant_key:
        raise HTTPException(status_code=404, detail="unknown job")

    async def _agen():
        async for event in synth_jobs.subscribe(job_id, from_sentence):
            yield f"data: {_json.dumps(event)}\n\n"

    return StreamingResponse(
        _sse_with_keepalive(_agen()),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.delete("/api/synth/jobs/{job_id}")
async def synth_jobs_cancel(job_id: str, request: Request):
    """Cancel an in-flight synth. Idempotent."""
    job = synth_jobs.get_job(job_id)
    if not job:
        # Already evicted or never existed — treat as success.
        return {"cancelled": True}
    tenant_key = getattr(request.state, "tenant_key", None)
    if job.tenant_key != tenant_key:
        raise HTTPException(status_code=404, detail="unknown job")
    await synth_jobs.cancel_job(job_id)
    return {"cancelled": True}


@app.get("/api/synth/jobs")
async def synth_jobs_list(request: Request, active: int = 0):
    """List this tenant's jobs. With ?active=1, only those in flight.
    Client uses this on app boot to reattach to any in-flight work."""
    tenant_key = getattr(request.state, "tenant_key", None)
    return {
        "jobs": synth_jobs.list_jobs_for_tenant(
            tenant_key, active_only=bool(active)
        )
    }


class GithubTreeRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    branch: str | None = Field(default=None, max_length=200)
    # v225.tn50: bumped from 200 to 300 to cover fine-grained PATs
    # (~93 chars) with headroom; the 200 cap didn't accidentally
    # bounce real tokens but it sat unnervingly close to the boundary
    # for any future token format change.
    github_token: str | None = Field(default=None, max_length=300)


@app.post("/api/github/tree")
async def github_tree_endpoint(req: GithubTreeRequest):
    """List the text-format files in a GitHub repo for the file browser."""
    import asyncio
    import functools

    owner, repo = extract._parse_github_repo_url(req.url)
    if not owner or not repo:
        raise HTTPException(
            status_code=400,
            detail="not a GitHub repo URL — expected github.com/owner/repo",
        )

    host = extract._parse_github_repo_url_host(req.url)
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(
                extract.fetch_github_tree,
                owner,
                repo,
                branch=req.branch,
                github_token=req.github_token,
                host=host,
            ),
        )
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


# v225.tn50 (#527): Test-token endpoint. The picker's HTTP 401 looks
# the same whether the token wasn't sent, was empty after trim, was
# expired, or doesn't have access to a specific repo. This endpoint
# calls GitHub /user with the saved token and surfaces login + scopes
# so the user can confirm in one tap whether their token is good or
# rejected (and if rejected, exactly which HTTP code came back).
class GithubUserRequest(BaseModel):
    # 300 covers fine-grained PATs (~93 chars) with headroom for any
    # future format change without bouncing the request at validation.
    github_token: str = Field(..., min_length=1, max_length=300)
    host: str | None = Field(default=None, max_length=200)


@app.post("/api/github/user")
async def github_user_endpoint(req: GithubUserRequest):
    """Probe a GitHub token by calling /user and report the result."""
    import asyncio
    import functools
    import json
    import urllib.error
    import urllib.request

    def _check():
        api_base = extract._github_api_base(req.host)
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Narrative/0.1",
            "Authorization": f"Bearer {req.github_token}",
        }
        url = f"{api_base}/user"
        try:
            r = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(r, timeout=15) as resp:
                data = json.load(resp)
                # X-OAuth-Scopes — present on classic PATs + OAuth.
                # Fine-grained PATs don't return this header (scopes
                # are repo-pinned not account-wide), so an empty
                # string here doesn't mean "no scopes."
                scopes = resp.headers.get("X-OAuth-Scopes") or ""
                token_type = resp.headers.get("X-GitHub-Authentication-Token-Expiration") or ""
                return {
                    "ok": True,
                    "login": data.get("login"),
                    "name": data.get("name") or None,
                    "scopes": scopes.strip(),
                    "expires": token_type.strip(),
                }
        except urllib.error.HTTPError as e:
            return {
                "ok": False,
                "status": e.code,
                "reason": e.reason or "unauthorized",
            }
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return {"ok": False, "status": 0, "reason": str(e)}

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _check)


class GithubBranchesRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    github_token: str | None = Field(default=None, max_length=300)


class GistMetaRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    github_token: str | None = Field(default=None, max_length=300)


@app.post("/api/gist/meta")
async def gist_meta_endpoint(req: GistMetaRequest):
    """Pull a Gist's file list + metadata so the frontend can route
    multi-file gists to the picker and single-file ones straight to
    the textarea.

    Public gists don't need a token; private ones do. Same error
    surface as the other GitHub endpoints (422 on extraction failure).
    """
    import asyncio
    import functools

    gist_id = extract._parse_gist_id(req.url)
    if not gist_id:
        raise HTTPException(
            status_code=400,
            detail="not a Gist URL — expected gist.github.com/[user/]<id>",
        )

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(
                extract.fetch_gist_meta,
                gist_id,
                github_token=req.github_token,
            ),
        )
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.post("/api/github/branches")
async def github_branches_endpoint(req: GithubBranchesRequest):
    """List a repo's branches + its default branch.

    Backs the v179 branch dropdown in the document picker so writers
    using feature branches (drafts/, wip/, etc.) can flip between
    them without re-typing the URL.
    """
    import asyncio
    import functools

    owner, repo = extract._parse_github_repo_url(req.url)
    if not owner or not repo:
        raise HTTPException(
            status_code=400,
            detail="not a GitHub repo URL — expected github.com/owner/repo",
        )

    host = extract._parse_github_repo_url_host(req.url)
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(
                extract.fetch_github_branches,
                owner,
                repo,
                github_token=req.github_token,
                host=host,
            ),
        )
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


# v4.60 (#538 Phase 1A): GitHub push-back of revised clip text. Closes
# the revise-as-you-listen loop — the writer's edits in Narrative land
# back in the source file as a real commit, without leaving the app.
#
# Phase 1A scope: GitHub only, text only, conflict-aware (refuses if
# the remote SHA has moved since the clip was imported, prompting a
# Pull-first workflow). The endpoint takes the user's PAT/OAuth token,
# encodes the text as base64, and calls GitHub's Contents API
# (PUT /repos/{owner}/{repo}/contents/{path}). Returns the new commit
# SHA + new blob SHA on success so the client can stash gitRef.sha.
#
# Phase 1B (deferred): preserve YAML frontmatter on push. Right now if
# the source had `---\nauthor: kmythers\n---` at the top and the user
# imported it (frontmatter was stripped per v220as), pushing back will
# replace the file body with just the clip text — frontmatter is lost.
# Tracked as a follow-up; pragmatically rare for the bulk of writers
# who don't use frontmatter.
class GithubPushFileRequest(BaseModel):
    # GitHub Bearer token — PAT (classic or fine-grained) or OAuth.
    # Same 300-char cap as other endpoints (fine-grained PATs ~93 chars).
    github_token: str = Field(..., min_length=1, max_length=300)
    # The repo's URL as the user typed it — same shape as gitRef.repoUrl
    # we extract from on import. We parse owner/repo out of it.
    repo_url: str = Field(..., min_length=8, max_length=2048)
    # Branch to push to. Required (no inference) so the call is
    # explicit — pushing to main when the user thought they were on
    # feature/draft is exactly the kind of accident this layer should
    # not facilitate.
    branch: str = Field(..., min_length=1, max_length=200)
    # File path within the repo, e.g. "chapters/01-opening.md".
    path: str = Field(..., min_length=1, max_length=2048)
    # The full new file content as a UTF-8 string. Server base64-encodes
    # before sending to GitHub. Capped at 5 MB to match GitHub's own
    # blob-size limits with headroom for unicode expansion.
    content: str = Field(..., min_length=0, max_length=5_000_000)
    # Commit message. Default constructed client-side from the clip
    # title; the user sees + can edit it in the confirm dialog.
    message: str = Field(..., min_length=1, max_length=500)
    # The SHA of the blob we expect to be overwriting. GitHub uses this
    # for the optimistic-concurrency check — if the file has moved
    # since this SHA, the PUT fails with 409 and we surface that to
    # the user as "Pull first."
    #
    # v4.76 (#878): now optional. Empty string triggers auto-resolve:
    # the server issues a GET first to discover the current SHA, then
    # PUTs with it (or PUTs without `sha` if the file is a 404 → file
    # creation). Used by the notes-push path, which doesn't have a SHA
    # cached for the sibling .notes.md the first time it pushes. The
    # prose-push path keeps supplying a non-empty SHA so its existing
    # 409-on-stale semantics are unchanged.
    expected_sha: str = Field(default="", max_length=64)
    # Optional Enterprise host override — same as other GitHub endpoints.
    host: str | None = Field(default=None, max_length=200)


@app.post("/api/github/push-file")
async def github_push_file_endpoint(req: GithubPushFileRequest):
    """PUT a single file back to a GitHub repo with the revised content."""
    import asyncio
    import base64
    import functools
    import json
    import urllib.error
    import urllib.request

    owner, repo = extract._parse_github_repo_url(req.repo_url)
    if not owner or not repo:
        raise HTTPException(
            status_code=400,
            detail="not a GitHub repo URL — expected github.com/owner/repo",
        )

    def _push():
        api_base = extract._github_api_base(req.host)
        # Path needs URL-quoting per segment (slashes preserved) so a
        # file like "chapters/01 — opening.md" doesn't break the URL.
        # GitHub's Contents API accepts the raw path with %20 etc.
        import urllib.parse
        quoted_path = urllib.parse.quote(req.path, safe="/")
        url = f"{api_base}/repos/{owner}/{repo}/contents/{quoted_path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Narrative/0.1",
            "Authorization": f"Bearer {req.github_token}",
            "Content-Type": "application/json",
        }

        # v4.76 (#878): auto-resolve SHA when the client didn't supply
        # one. Used by the notes-push path — first push has no cached
        # SHA, subsequent pushes do. GET the path on the target branch:
        # if it exists, use its SHA for the PUT; if 404, the file is
        # new and we PUT without `sha` (GitHub creates it).
        resolved_sha = req.expected_sha
        if not resolved_sha:
            get_url = f"{url}?ref={urllib.parse.quote(req.branch)}"
            get_req = urllib.request.Request(
                get_url,
                method="GET",
                headers={
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "Narrative/0.1",
                    "Authorization": f"Bearer {req.github_token}",
                },
            )
            try:
                with urllib.request.urlopen(get_req, timeout=15) as gresp:
                    gdata = json.load(gresp)
                    resolved_sha = (gdata.get("sha") or "")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    resolved_sha = ""  # file doesn't exist → create
                else:
                    try:
                        err_body = json.load(e)
                        err_msg = err_body.get("message") or str(e)
                    except Exception:
                        err_msg = str(e)
                    reason = (
                        "auth" if e.code in (401, 403)
                        else "auto_resolve_failed"
                    )
                    return {
                        "ok": False,
                        "status": e.code,
                        "reason": reason,
                        "message": f"SHA auto-resolve failed: {err_msg}",
                    }
            except urllib.error.URLError as e:
                return {
                    "ok": False,
                    "status": 0,
                    "reason": "network",
                    "message": str(e.reason if hasattr(e, "reason") else e),
                }

        body = {
            "message": req.message,
            "content": base64.b64encode(req.content.encode("utf-8")).decode("ascii"),
            "branch": req.branch,
        }
        # Only include `sha` when we have one. GitHub's contract:
        # PUT with sha → update existing; PUT without sha → create new.
        # Sending an empty string is rejected with 422.
        if resolved_sha:
            body["sha"] = resolved_sha
        r = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="PUT",
        )
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                data = json.load(resp)
                # GitHub returns { content: {sha, ...}, commit: {sha, ...} }
                new_blob_sha = (data.get("content") or {}).get("sha") or ""
                new_commit_sha = (data.get("commit") or {}).get("sha") or ""
                return {
                    "ok": True,
                    "blob_sha": new_blob_sha,
                    "commit_sha": new_commit_sha,
                }
        except urllib.error.HTTPError as e:
            # 409 = SHA mismatch ("file out of date"); surface as a
            # structured response so the client can suggest Pull-first
            # rather than dumping a raw HTTP error on the user.
            # 404 = path doesn't exist on this branch (probably wrong
            # branch in the gitRef).
            # 401/403 = auth issue.
            try:
                err_body = json.load(e)
                err_msg = err_body.get("message") or str(e)
            except Exception:
                err_msg = str(e)
            reason = (
                "stale_sha" if e.code == 409
                else "not_found" if e.code == 404
                else "auth" if e.code in (401, 403)
                else "http_error"
            )
            return {
                "ok": False,
                "status": e.code,
                "reason": reason,
                "message": err_msg,
            }
        except urllib.error.URLError as e:
            return {
                "ok": False,
                "status": 0,
                "reason": "network",
                "message": str(e.reason if hasattr(e, "reason") else e),
            }

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _push)


# ---- GitHub OAuth ------------------------------------------------------
# v180: optional Sign-in-with-GitHub flow. Only enabled when the
# operator registers a GitHub OAuth App and exports its client ID +
# secret via env vars. When unconfigured these endpoints return a
# helpful "configure these env vars" message instead of silently
# failing, so the frontend can show an actionable button state.
#
# Env vars (read at request time, not import — so a restart isn't
# required after `export` + change):
#   GITHUB_CLIENT_ID            (required)
#   GITHUB_CLIENT_SECRET        (required)
#   GITHUB_OAUTH_REDIRECT_URI   (required — must match the OAuth App's
#                                registered callback URL exactly)
#   GITHUB_OAUTH_SCOPES         (default "repo" — operator can override
#                                to "public_repo" or "" for public-only)

_GH_OAUTH_STATE_COOKIE = "narrative_gh_oauth_state"


def _github_oauth_config() -> dict:
    """Snapshot of OAuth-relevant env vars at request time."""
    return {
        "client_id": os.environ.get("GITHUB_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("GITHUB_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.environ.get(
            "GITHUB_OAUTH_REDIRECT_URI",
            "http://localhost:8000/api/github/oauth/callback",
        ).strip(),
        "scopes": os.environ.get("GITHUB_OAUTH_SCOPES", "repo").strip(),
    }


def _urlquote(s: str) -> str:
    import urllib.parse
    return urllib.parse.quote(s, safe="")


@app.get("/api/github/oauth/status")
async def github_oauth_status_endpoint():
    """Tell the frontend whether OAuth is configured.

    Returns just the booleans — never leaks client_id or secret. The
    frontend uses this to decide whether to show the "Sign in with
    GitHub" button enabled (configured) or disabled with a "set
    GITHUB_CLIENT_ID on the server" tooltip (not configured).
    """
    cfg = _github_oauth_config()
    return {
        "configured": bool(cfg["client_id"] and cfg["client_secret"]),
        # redirect_uri shown so the operator can sanity-check it
        # matches what they registered on GitHub. No secrets here.
        "redirect_uri": cfg["redirect_uri"],
        "scopes": cfg["scopes"],
    }


@app.get("/api/github/oauth/start")
async def github_oauth_start_endpoint(request: Request):
    """Begin the OAuth dance: redirect the user to GitHub authorize.

    Generates a fresh CSRF state token, stashes it in an HttpOnly
    cookie, builds the GitHub authorize URL, 302s the user there.
    """
    from fastapi.responses import RedirectResponse

    cfg = _github_oauth_config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        # Return JSON not HTML so a misconfigured deploy gives the
        # frontend something it can render — rather than silently
        # 302ing to a half-formed GitHub URL.
        raise HTTPException(
            status_code=503,
            detail=(
                "GitHub OAuth is not configured — set GITHUB_CLIENT_ID + "
                "GITHUB_CLIENT_SECRET env vars on the server. See "
                "OAUTH_SETUP.md."
            ),
        )

    state = github_oauth.generate_state()
    try:
        url = github_oauth.build_authorize_url(
            cfg["client_id"], cfg["redirect_uri"], state, cfg["scopes"]
        )
    except github_oauth.OAuthError as e:
        raise HTTPException(status_code=500, detail=str(e))

    resp = RedirectResponse(url, status_code=302)
    # HttpOnly so JS can't lift it; SameSite=lax so GitHub's redirect
    # back to us carries the cookie (lax allows top-level navigation
    # cookies, which is exactly the round-trip we're in). secure flag
    # is derived from the redirect URI scheme — http://localhost keeps
    # the cookie usable in dev; https deploys get the hardened flag.
    secure = cfg["redirect_uri"].startswith("https://")
    resp.set_cookie(
        _GH_OAUTH_STATE_COOKIE,
        state,
        max_age=600,  # 10 minutes is plenty; matches GitHub's code TTL
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/api/github/oauth/",
    )
    return resp


@app.get("/api/github/oauth/callback")
async def github_oauth_callback_endpoint(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
):
    """GitHub redirects the user back here after they authorize.

    Validates the state cookie matches the query param (CSRF defense),
    exchanges the code for an access token, then 302s the user back
    to / with the token in the URL fragment so it doesn't end up in
    server logs. Frontend boot parses the fragment + stores it.
    """
    from fastapi.responses import RedirectResponse

    # GitHub propagates user-side errors (e.g. user clicked Deny) via
    # ?error. Surface them in the redirect query so the frontend can
    # show a useful message.
    if error:
        detail = error_description or error
        target = f"/?gh_oauth_error={_urlquote(detail)}"
        return RedirectResponse(target, status_code=302)

    if not code or not state:
        raise HTTPException(
            status_code=400,
            detail="missing code or state in OAuth callback",
        )

    cookie_state = request.cookies.get(_GH_OAUTH_STATE_COOKIE) or ""
    if not hmac.compare_digest(
        state.encode("utf-8"), cookie_state.encode("utf-8")
    ):
        raise HTTPException(
            status_code=400,
            detail="OAuth state mismatch — possible CSRF or expired session",
        )

    cfg = _github_oauth_config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(
            status_code=503,
            detail="GitHub OAuth is not configured",
        )

    # The token exchange blocks on urllib — push it off-thread.
    import asyncio
    import functools

    loop = asyncio.get_running_loop()
    try:
        token = await loop.run_in_executor(
            None,
            functools.partial(
                github_oauth.exchange_code,
                cfg["client_id"],
                cfg["client_secret"],
                code,
                cfg["redirect_uri"],
            ),
        )
    except github_oauth.OAuthError as e:
        # Don't leak the exception type/stack — but DO surface the
        # message so users see "code expired, try again" instead of
        # a black-box 500.
        target = f"/?gh_oauth_error={_urlquote(str(e))}"
        resp = RedirectResponse(target, status_code=302)
        resp.delete_cookie(_GH_OAUTH_STATE_COOKIE, path="/api/github/oauth/")
        return resp

    # Token in the fragment so it never appears in Referer headers or
    # access logs. Browsers don't send fragments to the server on
    # subsequent navigations. Frontend boot reads the fragment, stores
    # the token via setGithubToken, and replaces history so the bare
    # URL is left behind.
    target = f"/?gh_oauth=success#gh_token={_urlquote(token)}"
    resp = RedirectResponse(target, status_code=302)
    # State served its purpose — burn it so a replay can't reuse it.
    resp.delete_cookie(_GH_OAUTH_STATE_COOKIE, path="/api/github/oauth/")
    return resp


# ──────────────────────────────────────────────────────────────────────
# Google Drive OAuth (#896) — Phase 2 of Drive import.
#
# Mirrors the GitHub OAuth block above, with one architectural change:
# tokens are stored SERVER-SIDE per tenant (gdrive_tokens table) rather
# than handed to the browser. The long-lived refresh token never leaves
# the server; the access token is exposed only briefly via /picker-token
# so Google's client-side Picker can authorize file reads.
#
# Env vars (read at request time):
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   (required for sign-in)
#   GOOGLE_OAUTH_REDIRECT_URI                 (must match the console)
#   GOOGLE_OAUTH_SCOPES                       (default drive.file + email)
#   GOOGLE_API_KEY / GOOGLE_APP_ID            (public Picker config)
# See GDRIVE_OAUTH_SETUP.md.

_GD_OAUTH_STATE_COOKIE = "narrative_gd_oauth_state"
_GD_OAUTH_TENANT_COOKIE = "narrative_gd_oauth_tenant"
_GD_OAUTH_VERIFIER_COOKIE = "narrative_gd_oauth_verifier"
# Refresh the access token when it's within this many seconds of expiry,
# so a token we hand to the Picker / a download doesn't die mid-use.
_GD_TOKEN_REFRESH_MARGIN = 120


def _gdrive_oauth_config() -> dict:
    """Snapshot of Drive OAuth env vars at request time."""
    return {
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.environ.get(
            "GOOGLE_OAUTH_REDIRECT_URI",
            "http://localhost:8000/api/gdrive/oauth/callback",
        ).strip(),
        "scopes": os.environ.get(
            "GOOGLE_OAUTH_SCOPES", gdrive_oauth.DEFAULT_SCOPES
        ).strip(),
        # Public Picker config — safe to expose to the frontend. The API
        # key is referrer-restricted; app_id is the GCP project number.
        "api_key": os.environ.get("GOOGLE_API_KEY", "").strip(),
        "app_id": os.environ.get("GOOGLE_APP_ID", "").strip(),
    }


def _fetch_google_email(access_token: str) -> str | None:
    """Best-effort read of the connected account's email for display.
    Returns None on any failure — the grant is still valid without it."""
    import json
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "Narrative/0.1",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
        email = data.get("email") if isinstance(data, dict) else None
        return email if isinstance(email, str) else None
    except Exception:
        return None


def get_valid_gdrive_access_token(tenant_key: str) -> str:
    """Return a non-expired Drive access token for the tenant, refreshing
    via the stored refresh token if needed. Synchronous (blocks on
    urllib) — call through run_in_executor from async endpoints.

    Raises HTTPException(401) if the tenant has no grant or the refresh
    token has been revoked (the user must reconnect). On revocation the
    stale grant is cleared so /status correctly reports "not connected".
    """
    import time

    row = library_db.get_gdrive_tokens(tenant_key)
    if not row:
        raise HTTPException(
            status_code=401,
            detail="Google Drive not connected — sign in in Settings",
        )

    if row["expires_at"] - time.time() > _GD_TOKEN_REFRESH_MARGIN:
        return row["access_token"]

    cfg = _gdrive_oauth_config()
    try:
        payload = gdrive_oauth.refresh_access_token(
            cfg["client_id"], cfg["client_secret"], row["refresh_token"]
        )
    except gdrive_oauth.OAuthError as e:
        # A revoked / expired refresh token can't be salvaged — clear it
        # so the UI prompts a fresh sign-in instead of looping on refresh.
        library_db.delete_gdrive_tokens(tenant_key)
        raise HTTPException(
            status_code=401,
            detail=f"Google Drive access expired — reconnect in Settings ({e})",
        )

    access = payload["access_token"]
    expires_at = time.time() + int(payload.get("expires_in", 3600))
    library_db.update_gdrive_access_token(
        tenant_key, access_token=access, expires_at=expires_at
    )
    return access


@app.get("/api/gdrive/oauth/status")
async def gdrive_oauth_status_endpoint(request: Request):
    """Whether Drive OAuth is configured + whether THIS tenant is connected.

    Drives the Settings → Account → Google Drive section and the Import
    menu's signed-in/signed-out branch. Returns the public Picker config
    (api_key, app_id) so the frontend can build a Picker without another
    round-trip. Never leaks the client secret.
    """
    cfg = _gdrive_oauth_config()
    tenant_key = getattr(request.state, "tenant_key", "")
    row = library_db.get_gdrive_tokens(tenant_key) if tenant_key else None
    return {
        "configured": bool(cfg["client_id"] and cfg["client_secret"]),
        "connected": bool(row),
        "account_email": (row or {}).get("account_email"),
        "redirect_uri": cfg["redirect_uri"],
        "api_key": cfg["api_key"],
        "app_id": cfg["app_id"],
    }


@app.get("/api/gdrive/oauth/start")
async def gdrive_oauth_start_endpoint(request: Request):
    """Begin the Drive OAuth dance.

    Unlike GitHub (where the browser navigates straight to /start), this
    is hit via authed fetch so we can resolve request.state.tenant_key
    and stash it in an HttpOnly cookie alongside the CSRF state. The
    callback — which has no auth header — recovers the tenant from that
    cookie. Returns the authorize URL as JSON; the client then does
    window.location.href = url.
    """
    cfg = _gdrive_oauth_config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google Drive OAuth is not configured — set GOOGLE_CLIENT_ID "
                "+ GOOGLE_CLIENT_SECRET env vars on the server. See "
                "GDRIVE_OAUTH_SETUP.md."
            ),
        )

    tenant_key = getattr(request.state, "tenant_key", "")
    if not tenant_key:
        raise HTTPException(status_code=401, detail="missing tenant")

    state = gdrive_oauth.generate_state()
    verifier, challenge = gdrive_oauth.generate_pkce()
    try:
        url = gdrive_oauth.build_authorize_url(
            cfg["client_id"], cfg["redirect_uri"], state, cfg["scopes"],
            code_challenge=challenge,
        )
    except gdrive_oauth.OAuthError as e:
        raise HTTPException(status_code=500, detail=str(e))

    resp = JSONResponse({"authorize_url": url})
    secure = cfg["redirect_uri"].startswith("https://")
    cookie_kw = dict(
        max_age=600,  # 10 min — matches Google's auth-code TTL
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/api/gdrive/oauth/",
    )
    resp.set_cookie(_GD_OAUTH_STATE_COOKIE, state, **cookie_kw)
    # The tenant_key is already a sha256 hash (never the raw bearer), so
    # parking it in a cookie doesn't expose the secret. It only needs to
    # survive the ~seconds round-trip to Google and back.
    resp.set_cookie(_GD_OAUTH_TENANT_COOKIE, tenant_key, **cookie_kw)
    # PKCE verifier — HttpOnly so JS can't read it; presented at the token
    # exchange in the callback to prove we started this flow.
    resp.set_cookie(_GD_OAUTH_VERIFIER_COOKIE, verifier, **cookie_kw)
    return resp


@app.get("/api/gdrive/oauth/callback")
async def gdrive_oauth_callback_endpoint(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
):
    """Google redirects the user back here after they authorize.

    Validates state (CSRF), recovers the tenant from its cookie,
    exchanges the code for an access + refresh token, reads the account
    email, and persists the grant SERVER-SIDE. Redirects back to / with
    just a success flag — no token in the URL (tokens never touch the
    browser in the Drive flow).
    """
    from fastapi.responses import RedirectResponse

    def _clear_oauth_cookies(resp):
        for c in (
            _GD_OAUTH_STATE_COOKIE,
            _GD_OAUTH_TENANT_COOKIE,
            _GD_OAUTH_VERIFIER_COOKIE,
        ):
            resp.delete_cookie(c, path="/api/gdrive/oauth/")
        return resp

    def _fail(detail: str):
        return _clear_oauth_cookies(RedirectResponse(
            f"/?gdrive_oauth_error={_urlquote(detail)}", status_code=302
        ))

    if error:
        return _fail(error_description or error)
    if not code or not state:
        return _fail("missing code or state in OAuth callback")

    cookie_state = request.cookies.get(_GD_OAUTH_STATE_COOKIE) or ""
    if not hmac.compare_digest(
        state.encode("utf-8"), cookie_state.encode("utf-8")
    ):
        return _fail("OAuth state mismatch — possible CSRF or expired session")

    tenant_key = request.cookies.get(_GD_OAUTH_TENANT_COOKIE) or ""
    if not tenant_key:
        return _fail("lost session — please start the sign-in again")

    verifier = request.cookies.get(_GD_OAUTH_VERIFIER_COOKIE) or ""
    if not verifier:
        return _fail("lost session — please start the sign-in again")

    cfg = _gdrive_oauth_config()
    if not cfg["client_id"] or not cfg["client_secret"]:
        return _fail("Google Drive OAuth is not configured")

    import asyncio
    import functools
    import time

    loop = asyncio.get_running_loop()
    try:
        payload = await loop.run_in_executor(
            None,
            functools.partial(
                gdrive_oauth.exchange_code,
                cfg["client_id"],
                cfg["client_secret"],
                code,
                cfg["redirect_uri"],
                verifier,
            ),
        )
    except gdrive_oauth.OAuthError as e:
        return _fail(str(e))

    refresh_token = payload.get("refresh_token")
    if not refresh_token:
        # Google only omits the refresh token when the user previously
        # granted without revoking. prompt=consent should prevent this,
        # but guard anyway so we never persist a half grant.
        return _fail(
            "Google didn't return a refresh token — revoke Narrative's "
            "access in your Google account and try again"
        )

    access = payload["access_token"]
    expires_at = time.time() + int(payload.get("expires_in", 3600))
    email = await loop.run_in_executor(None, _fetch_google_email, access)

    try:
        library_db.save_gdrive_tokens(
            tenant_key,
            access_token=access,
            refresh_token=refresh_token,
            expires_at=expires_at,
            scope=payload.get("scope"),
            account_email=email,
        )
    except Exception as e:  # DB disabled / write failure
        return _fail(f"could not save Drive connection: {e}")

    return _clear_oauth_cookies(
        RedirectResponse("/?gdrive_oauth=success", status_code=302)
    )


@app.get("/api/gdrive/picker-token")
async def gdrive_picker_token_endpoint(request: Request):
    """Mint a short-lived access token for the client-side Google Picker.

    The Picker needs an OAuth token via setOAuthToken(). We expose only
    the ephemeral access token (refreshed if stale) — never the refresh
    token. Returns {access_token, expires_in}.
    """
    import asyncio
    import time

    tenant_key = getattr(request.state, "tenant_key", "")
    loop = asyncio.get_running_loop()
    access = await loop.run_in_executor(
        None, get_valid_gdrive_access_token, tenant_key
    )
    row = library_db.get_gdrive_tokens(tenant_key) or {}
    expires_in = max(0, int((row.get("expires_at", 0)) - time.time()))
    return {"access_token": access, "expires_in": expires_in}


class GdriveFetchRequest(BaseModel):
    """A file the user picked in the Google Picker. file_id + mime_type +
    name come from the Picker's doc object; the access token is resolved
    server-side from the tenant's stored grant."""
    file_id: str = Field(..., min_length=1, max_length=256)
    mime_type: str | None = Field(default=None, max_length=256)
    name: str | None = Field(default=None, max_length=512)


@app.post("/api/gdrive/fetch")
async def gdrive_fetch_endpoint(req: GdriveFetchRequest, request: Request):
    """Download + extract a Picker-selected Drive file (authenticated).

    Returns the same shape as /api/extract/gdrive: {filename, chars,
    text, images}. The access token is minted + used entirely server-side.
    """
    import asyncio
    import functools

    tenant_key = getattr(request.state, "tenant_key", "")
    loop = asyncio.get_running_loop()
    access = await loop.run_in_executor(
        None, get_valid_gdrive_access_token, tenant_key
    )
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(
                extract.fetch_and_extract_gdrive_authed,
                req.file_id,
                access,
                req.mime_type,
                req.name,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.post("/api/gdrive/oauth/disconnect")
async def gdrive_oauth_disconnect_endpoint(request: Request):
    """Drop the tenant's stored Drive grant (Settings → Disconnect).

    Revokes the grant at Google first (best-effort) so disconnecting
    actually kills Narrative's access, not just our local copy — then
    deletes the row regardless of whether revoke succeeded.
    """
    import asyncio

    tenant_key = getattr(request.state, "tenant_key", "")
    if not tenant_key:
        return {"ok": True, "deleted": False, "revoked": False}

    row = library_db.get_gdrive_tokens(tenant_key)
    revoked = False
    if row and row.get("refresh_token"):
        loop = asyncio.get_running_loop()
        revoked = await loop.run_in_executor(
            None, gdrive_oauth.revoke_token, row["refresh_token"]
        )
    deleted = library_db.delete_gdrive_tokens(tenant_key)
    return {"ok": True, "deleted": deleted, "revoked": revoked}


# ──────────────────────────────────────────────────────────────────────
# Two-step verification (TOTP 2FA) — opt-in per tenant.
#
# A signed, stateless "2FA-passed" token is issued on successful code
# verification and sent back by the client as X-Narrative-2FA on every
# /api/* request. The middleware (require_api_key) gates a tenant's
# requests once that tenant has a CONFIRMED enrollment. The /api/2fa/*
# routes themselves are exempt from the gate (so a user can always
# enroll / verify) but still require the API key.

# "Remember this device" lifetime for the 2FA session token.
_2FA_TOKEN_TTL = 30 * 24 * 3600  # 30 days
# Brute-force guard: TOTP is only 6 digits, so cap failed attempts.
_2FA_MAX_FAILS = 5
_2FA_LOCKOUT_SEC = 60
_2fa_attempts: dict[str, list] = {}  # tenant_key -> [fail_count, window_start]


def _2fa_signing_key() -> bytes:
    """HMAC key for 2FA session tokens — the server's NARRATIVE_KEY. It's
    always set in deployed mode (where 2FA is enforced); rotating it
    invalidates outstanding 2FA tokens, which is acceptable."""
    return os.environ.get("NARRATIVE_KEY", "").encode("utf-8")


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * ((4 - len(s) % 4) % 4))


def _issue_2fa_token(tenant_key: str) -> tuple[str, int]:
    """Return (token, ttl_seconds). Token = b64(payload).b64(HMAC) where
    payload is 'tenant_key|expiry_epoch'. Stateless — no DB row."""
    exp = int(time.time()) + _2FA_TOKEN_TTL
    payload = f"{tenant_key}|{exp}".encode("utf-8")
    sig = hmac.new(_2fa_signing_key(), payload, hashlib.sha256).digest()
    return f"{_b64url(payload)}.{_b64url(sig)}", _2FA_TOKEN_TTL


def _verify_2fa_token(token: str, tenant_key: str) -> bool:
    """True iff token is a valid, unexpired 2FA token for THIS tenant.
    The signature covers the tenant_key, and we also compare it to the
    request's tenant_key, so a token can't be replayed across tenants."""
    if not token or "." not in token or not tenant_key:
        return False
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        payload = _b64url_decode(payload_b64)
        sig = _b64url_decode(sig_b64)
    except Exception:
        return False
    expected = hmac.new(_2fa_signing_key(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        tok_tenant, exp = payload.decode("utf-8").split("|", 1)
        exp_epoch = int(exp)
    except Exception:
        return False
    if not hmac.compare_digest(tok_tenant, tenant_key):
        return False
    return time.time() < exp_epoch


def _enforce_2fa(request: Request, tenant_key: str, path: str):
    """Called from the auth middleware after the tenant is resolved.
    Returns a JSONResponse to block the request, or None to allow it.
    Blocks only when the tenant has a CONFIRMED enrollment, the path isn't
    a 2FA endpoint, and no valid 2FA token is presented."""
    if path.startswith("/api/2fa/"):
        return None
    if not library_db.totp_confirmed(tenant_key):
        return None
    if _verify_2fa_token(request.headers.get("X-Narrative-2FA", ""), tenant_key):
        return None
    return JSONResponse(status_code=401, content={"detail": "2fa_required"})


def _2fa_rate_limited(tenant_key: str) -> bool:
    rec = _2fa_attempts.get(tenant_key)
    if not rec:
        return False
    if time.time() - rec[1] > _2FA_LOCKOUT_SEC:
        _2fa_attempts.pop(tenant_key, None)
        return False
    return rec[0] >= _2FA_MAX_FAILS


def _2fa_record_fail(tenant_key: str) -> None:
    now = time.time()
    rec = _2fa_attempts.get(tenant_key)
    if not rec or now - rec[1] > _2FA_LOCKOUT_SEC:
        _2fa_attempts[tenant_key] = [1, now]
    else:
        rec[0] += 1


def _2fa_clear_fails(tenant_key: str) -> None:
    _2fa_attempts.pop(tenant_key, None)


class TotpCodeRequest(BaseModel):
    """A 6-digit TOTP code or a recovery code (e.g. 'A7K2-9QMP')."""
    code: str = Field(..., min_length=4, max_length=20)


@app.get("/api/2fa/status")
async def totp_status_endpoint(request: Request):
    """Drives the Settings section + the prompt. `verified` = this request
    already carries a valid 2FA token."""
    tk = getattr(request.state, "tenant_key", "")
    enr = library_db.get_totp_enrollment(tk) if tk else None
    confirmed = bool(enr and enr["confirmed"])
    verified = confirmed and _verify_2fa_token(
        request.headers.get("X-Narrative-2FA", ""), tk
    )
    return {"enrolled": bool(enr), "confirmed": confirmed, "verified": verified}


@app.post("/api/2fa/enroll/start")
async def totp_enroll_start_endpoint(request: Request):
    """Generate a fresh secret + otpauth URI for the enrollment QR. Stores
    it pending (unconfirmed) so it doesn't gate anything yet."""
    tk = getattr(request.state, "tenant_key", "")
    if not tk:
        raise HTTPException(status_code=401, detail="missing tenant")
    enr = library_db.get_totp_enrollment(tk)
    if enr and enr["confirmed"]:
        raise HTTPException(
            status_code=409, detail="two-step verification is already enabled"
        )
    secret = totp.generate_secret()
    library_db.start_totp_enrollment(tk, secret)
    label = getattr(request.state, "tenant_label", "") or "account"
    return {"secret": secret, "otpauth_uri": totp.provisioning_uri(secret, label)}


@app.post("/api/2fa/enroll/confirm")
async def totp_enroll_confirm_endpoint(req: TotpCodeRequest, request: Request):
    """Verify the first code, activate 2FA, and return one-time recovery
    codes (shown once) plus a 2FA token so the user isn't immediately
    locked out of the session they just secured."""
    tk = getattr(request.state, "tenant_key", "")
    if not tk:
        raise HTTPException(status_code=401, detail="missing tenant")
    if _2fa_rate_limited(tk):
        raise HTTPException(status_code=429, detail="too many attempts — wait a minute")
    enr = library_db.get_totp_enrollment(tk)
    if not enr:
        raise HTTPException(status_code=409, detail="no enrollment in progress — start again")
    if enr["confirmed"]:
        raise HTTPException(status_code=409, detail="already enabled")
    if not totp.verify(enr["secret"], req.code):
        _2fa_record_fail(tk)
        raise HTTPException(
            status_code=400,
            detail="incorrect code — check your authenticator app and try again",
        )
    _2fa_clear_fails(tk)
    codes = totp.generate_recovery_codes(10)
    library_db.confirm_totp_enrollment(tk, [totp.hash_recovery_code(c) for c in codes])
    token, ttl = _issue_2fa_token(tk)
    return {"recovery_codes": codes, "token": token, "expires_in": ttl}


@app.post("/api/2fa/verify")
async def totp_verify_endpoint(req: TotpCodeRequest, request: Request):
    """Verify a TOTP code (or consume a recovery code) and mint a 2FA
    session token. Called by the frontend after a `2fa_required` response."""
    tk = getattr(request.state, "tenant_key", "")
    if not tk:
        raise HTTPException(status_code=401, detail="missing tenant")
    if _2fa_rate_limited(tk):
        raise HTTPException(status_code=429, detail="too many attempts — wait a minute")
    enr = library_db.get_totp_enrollment(tk)
    if not enr or not enr["confirmed"]:
        raise HTTPException(status_code=400, detail="two-step verification isn't enabled")
    ok = totp.verify(enr["secret"], req.code)
    if not ok:
        ok = library_db.consume_recovery_code(tk, totp.hash_recovery_code(req.code))
    if not ok:
        _2fa_record_fail(tk)
        raise HTTPException(status_code=400, detail="incorrect code")
    _2fa_clear_fails(tk)
    token, ttl = _issue_2fa_token(tk)
    return {"token": token, "expires_in": ttl}


@app.post("/api/2fa/disable")
async def totp_disable_endpoint(req: TotpCodeRequest, request: Request):
    """Turn 2FA off — requires a current TOTP or recovery code so a
    walk-up attacker with an open session can't silently disable it."""
    tk = getattr(request.state, "tenant_key", "")
    if not tk:
        raise HTTPException(status_code=401, detail="missing tenant")
    if _2fa_rate_limited(tk):
        raise HTTPException(status_code=429, detail="too many attempts — wait a minute")
    enr = library_db.get_totp_enrollment(tk)
    if not enr or not enr["confirmed"]:
        return {"ok": True, "disabled": False}
    ok = totp.verify(enr["secret"], req.code) or library_db.consume_recovery_code(
        tk, totp.hash_recovery_code(req.code)
    )
    if not ok:
        _2fa_record_fail(tk)
        raise HTTPException(status_code=400, detail="incorrect code")
    _2fa_clear_fails(tk)
    library_db.disable_totp(tk)
    return {"ok": True, "disabled": True}


class ExtractUrlRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    # Optional GitHub Personal Access Token for private-repo URLs.
    # Sent in the body rather than a header so the X-Narrative-Key
    # middleware doesn't have to special-case it. The fetcher only
    # forwards it to github.com / raw.githubusercontent.com (verified
    # post-rewrite), so a token for repo X never leaks to host Y.
    github_token: str | None = Field(default=None, max_length=300)
    # Pre-supplied SHA from the repo browser path (saves a contents API
    # round-trip). Optional; if missing for a GitHub URL the backend
    # looks it up.
    git_sha: str | None = Field(default=None, max_length=80)


class ExtractGdriveRequest(BaseModel):
    """v4.96 (#892): public-share Google Drive URL → extracted text.
    Same response shape as ExtractUrl. No auth (OAuth is Phase 2 / #896)."""
    url: str = Field(..., min_length=8, max_length=2048)


class GithubSyncCheckRequest(BaseModel):
    """Batch SHA check. Takes a list of {repoUrl, branch, paths[]} and
    returns the current SHA for each path, so the frontend can flag
    library clips whose stored SHA no longer matches."""
    items: list[dict] = Field(default_factory=list)
    github_token: str | None = Field(default=None, max_length=300)


@app.post("/api/github/sync-check")
async def github_sync_check_endpoint(req: GithubSyncCheckRequest):
    """For each {repoUrl, branch, paths[]} group, fetch the tree once
    and return the current SHA per path. Single API call per repo
    regardless of how many clips share it."""
    import asyncio
    import functools

    loop = asyncio.get_running_loop()

    async def _one(group: dict) -> dict:
        owner, repo = extract._parse_github_repo_url(group.get("repoUrl") or "")
        branch = group.get("branch") or None
        paths = group.get("paths") or []
        if not owner or not repo:
            return {"repoUrl": group.get("repoUrl"), "branch": branch, "shas": {}, "error": "invalid repoUrl"}
        # v181: route the API call to the correct host (github.com or GHE)
        # based on the clip's stored repoUrl. host is None for github.com.
        host = extract._parse_github_repo_url_host(group.get("repoUrl") or "")
        try:
            tree = await loop.run_in_executor(
                None,
                functools.partial(
                    extract.fetch_github_tree,
                    owner,
                    repo,
                    branch=branch,
                    github_token=req.github_token,
                    host=host,
                ),
            )
        except extract.ExtractionError as e:
            return {"repoUrl": group["repoUrl"], "branch": branch, "shas": {}, "error": str(e)}
        path_to_sha = {f["path"]: f["sha"] for f in tree.get("files", [])}
        return {
            "repoUrl": group["repoUrl"],
            "branch": tree["branch"],
            "shas": {p: path_to_sha.get(p, "") for p in paths},
        }

    results = await asyncio.gather(*[_one(g) for g in req.items])
    return {"results": list(results)}


@app.post("/api/extract/url")
async def extract_url_endpoint(req: ExtractUrlRequest):
    """Fetch a URL server-side and extract the article text."""
    import asyncio
    import functools

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(
                extract.fetch_and_extract_url,
                req.url,
                github_token=req.github_token,
                git_sha=req.git_sha,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.post("/api/extract/gdrive")
async def extract_gdrive_endpoint(req: ExtractGdriveRequest):
    """v4.96 (#892): fetch a public-share Google Drive URL.

    Returns the same shape as /api/extract/url: {filename, chars, text,
    images}. Google Docs export as DOCX (which the existing dispatcher
    reads); arbitrary Drive files download as raw bytes + run through
    extract_text. No OAuth — that lives in #896 (Phase 2)."""
    import asyncio
    import functools

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            functools.partial(extract.fetch_and_extract_gdrive, req.url),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.post("/api/extract")
async def extract_endpoint(file: UploadFile = File(...)):
    """Pull the text out of an uploaded document so the user can pipe it into TTS."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="no filename")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({len(data)} bytes, max {MAX_UPLOAD_BYTES})",
        )
    # v225fz13 (#687): for EPUBs, use the inline-image-aware extractor so
    # <img> tags inside the spine HTML get base64-encoded and threaded
    # through as `images` (mirroring the URL-fetch shape). Other formats
    # still use the text-only dispatcher — DOCX inline shapes would need
    # their own walker, and PDFs already surface their images via
    # image_detector's chapter_images path.
    inline_images: list = []
    try:
        ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
        if ext == "epub":
            epub_result = extract._extract_epub_with_images(data)
            text = extract._normalize(epub_result["text"])
            inline_images = epub_result.get("images") or []
        else:
            text = extract.extract_text(file.filename, data)
    except extract.UnsupportedFormatError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    # v225fz10 (#676): also detect the cover + chapter-leading images
    # for EPUB / PDF / DOCX. Best-effort enrichment; image_detector
    # returns {"cover": None, "chapter_images": []} on any failure so
    # the rest of the response is unaffected. See image_detector.py
    # for the per-format detection rules.
    try:
        import image_detector
        image_data = image_detector.detect_images(file.filename, data)
    except Exception as e:
        print(f"[/api/extract] image detection failed: {e!r}", flush=True)
        image_data = {"cover": None, "chapter_images": []}
    return {
        "filename": file.filename,
        "chars": len(text),
        "text": text,
        # v225fz13 (#687): EPUB inline-image list (URL-fetch shape).
        # Empty list for other formats so the frontend's array spread
        # stays defensive.
        "images": inline_images,
        "cover": image_data.get("cover"),
        "chapter_images": image_data.get("chapter_images") or [],
    }


@app.post("/api/extract/scrivener")
async def extract_scrivener_endpoint(file: UploadFile = File(...)):
    """Parse a Scrivener .scriv.zip bundle and return its chapter list.

    Same upload pattern as /api/extract, different shape on return:
        {project_name, chapters: [{id, title, path, text, chars}], skipped: [...]}
    The frontend opens its Scrivener browser dialog on this shape so the
    user can pick which chapters to import as a queue.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="no filename")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({len(data)} bytes, max {MAX_UPLOAD_BYTES})",
        )
    try:
        result = extract.extract_scrivener_bundle(data)
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


@app.post("/api/scrivener/patch")
async def scrivener_patch_endpoint(
    file: UploadFile = File(...),
    edits: str = Form(...),
):
    """Apply revised text to a .scriv.zip and stream back the patched zip.

    v4.96 (#538 Phase 2): the Edit dialog's "Push to Scrivener" button
    posts the user's *original* .scriv bundle plus a JSON `edits` array
    of `{doc_id, new_text}` entries. We replace each matching
    `Files/Docs/<doc_id>.rtf` with a minimal-RTF rendering of new_text
    (loses formatting in those scenes — that's the documented tradeoff)
    and stream the rebuilt zip back as an attachment download. The
    bundle isn't persisted server-side; this is one-shot.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="no filename")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({len(data)} bytes, max {MAX_UPLOAD_BYTES})",
        )
    import json as _json
    try:
        edit_list = _json.loads(edits)
    except (_json.JSONDecodeError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"edits not JSON: {e}")
    if not isinstance(edit_list, list) or not edit_list:
        raise HTTPException(status_code=400, detail="edits must be a non-empty list")
    try:
        patched, summary = extract.patch_scrivener_bundle(data, edit_list)
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    project_name = summary.get("project_name") or "scrivener-project"
    safe_name = "".join(
        c if c.isalnum() or c in ("-", "_", ".") else "_"
        for c in project_name
    ) or "scrivener-project"
    filename = f"{safe_name}.scriv.zip"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Scriv-Patched": ",".join(summary.get("patched") or []),
        "X-Scriv-Missing": ",".join(summary.get("missing") or []),
    }
    return Response(
        content=patched,
        media_type="application/zip",
        headers=headers,
    )


@app.post("/api/extract/obsidian")
async def extract_obsidian_endpoint(file: UploadFile = File(...)):
    """Parse an Obsidian vault zip and return its note list.

    Authors zip their Obsidian vault folder (or its contents) and
    upload it through the Import → Obsidian menu item. The parser
    skips .obsidian/, templates/, attachments/, hidden dotdirs, and
    non-markdown files, then strips wikilinks/embeds so notes are
    TTS-ready. Returns:
        {vault_name, chapters: [{id, title, path, text, chars}], skipped: [...]}
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="no filename")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large ({len(data)} bytes, max {MAX_UPLOAD_BYTES})",
        )
    try:
        result = extract.extract_obsidian_vault(data)
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return result


# v225v3.38 (#767): debug log → GitHub push. Phone-side
# _autoDownloadDebugLog also POSTs here after the local download
# fires. The server commits the log to the private
# narrative-debug-logs repo via the Contents API. Authed via the
# normal middleware (same X-Narrative-Key) so only known tenants
# can write. Best-effort: a failure here never blocks the local
# download path on the client.
class DebugLogPushRequest(BaseModel):
    """Payload from the phone. `log` is the raw text the local
    auto-download would have written; the server prepends its own
    provenance header before committing."""
    log: str = Field(..., min_length=1, max_length=4_000_000)  # 4 MB hard cap; helper enforces 2 MB
    reason: str = Field(default="unknown", max_length=64)
    version: str = Field(default="unknown", max_length=32)
    ua: str = Field(default="", max_length=300)


@app.post("/api/debug-log")
async def debug_log_endpoint(req: DebugLogPushRequest, request: Request):
    """Push a debug log to narrative-debug-logs. Returns
    {ok, path?, sha?, html_url?, reason?} so the phone-side can
    surface a quiet success/failure indicator next to the version
    stamp without blocking on it.

    Failure modes are returned as 200 ok=False, not 5xx — the phone
    treats this as a side-effect that may quietly fail, never as a
    blocker. The actual error reason ("disabled", "too_large",
    "github_403", "network", etc.) is in the response body.
    """
    import asyncio
    import functools

    tenant_label = getattr(request.state, "tenant_label", "") or ""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        functools.partial(
            debug_log_push.push_log,
            log=req.log,
            reason=req.reason,
            version=req.version,
            ua=req.ua,
            tenant_label=tenant_label,
        ),
    )
    return result


@app.get("/api/debug-log/status")
async def debug_log_status_endpoint():
    """Tells the phone-side whether the push pipeline is configured.
    Used by the manual "Push debug log to debugger" button to decide
    whether to show itself + what to say if the push silently fails."""
    return {"enabled": debug_log_push.is_enabled()}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def _lan_ip() -> str | None:
    """Best-effort detection of this machine's LAN IP."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def _print_banner(port: int) -> None:
    ip = _lan_ip()
    bar = "=" * 56
    lines = [
        bar,
        "  Narrative - local text-to-speech",
        bar,
        f"  This machine:  http://localhost:{port}",
    ]
    if ip:
        lines.append(f"  On your phone: http://{ip}:{port}")
    lines += [
        bar,
        "  Tip: phone must be on the same Wi-Fi network.",
        "  Windows may prompt to allow firewall access on first run.",
        "  iPhone:  Safari -> Share -> Add to Home Screen",
        "  Android: Chrome -> menu -> Install App / Add to Home screen",
        "  (PWA install on Android requires HTTPS or localhost.)",
        bar,
        "  Want HTTPS so the phone PWA installs + works over cellular?",
        "    python scripts/tunnel.py",
        "  (one-time: winget install --id Cloudflare.cloudflared)",
        bar,
    ]

    if not os.environ.get("NARRATIVE_KEY", "").strip():
        import secrets as _secrets

        lines += [
            "  Exposing this to the internet (e.g. via the tunnel)?",
            "  Set NARRATIVE_KEY so random visitors can't use your TTS:",
            f"    $env:NARRATIVE_KEY = '{_secrets.token_urlsafe(24)}'",
            "  Then paste the same string into the prompt the first time",
            "  you open the URL on your phone.",
            bar,
        ]
    else:
        lines += [
            "  NARRATIVE_KEY is set — /api/* requests require X-Narrative-Key.",
            bar,
        ]
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    import uvicorn

    # PORT defaults to 8000 (the documented dev port) but can be
    # overridden via env so the Playwright suite can launch on a
    # separate port (8001) without clashing with a dev server already
    # running on 8000.
    PORT = int(os.environ.get("PORT", "8000"))
    _print_banner(PORT)
    # Pass `app` as an object instead of the "server:app" string so the
    # PyInstaller-bundled Tauri sidecar works — frozen bundles don't
    # have a "server" module on the import path, but `app` is already
    # in scope right here. Cloud + dev runs still work the same way.
    uvicorn.run(app, host="0.0.0.0", port=PORT, reload=False)
