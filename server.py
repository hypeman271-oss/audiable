"""Narrative — local text-to-speech web prototype.

Run:
    pip install -r requirements.txt
    python server.py
    # open http://localhost:8000
"""

from __future__ import annotations

import hmac
import mimetypes
import os
import socket
import sys
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import extract
import github_oauth
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


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    """Optional shared-secret auth on /api/* — gated by env var NARRATIVE_KEY.

    Designed for the Cloudflare-tunnel use case: when the app is exposed to
    the public internet via the tunnel, set NARRATIVE_KEY so random visitors
    who stumble onto the URL can't run synthesis on your CPU / install
    voices on your disk / proxy URL fetches through your server.

    When NARRATIVE_KEY is unset (default for purely-local use), this is a
    no-op and every request passes through. When set, /api/* requires the
    matching X-Narrative-Key header.

    Two carve-outs:
      - Static files (anything not under /api/) are always allowed so the
        frontend can boot and prompt for the key in the first place.
      - /api/voices/sample/* is unauthenticated so <audio src="..."> sample
        previews keep working without each one having to be loaded via
        Fetch + Blob URL. The samples are already public on HuggingFace,
        so there's no real privacy lost.
    """
    required_key = os.environ.get("NARRATIVE_KEY", "").strip()
    if not required_key:
        return await call_next(request)

    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    if path.startswith("/api/voices/sample/"):
        return await call_next(request)
    # v180: GitHub OAuth round-trip. /start is hit by the user via a
    # window.location navigation (no X-Narrative-Key header — that
    # only goes through fetch); /callback is hit by GitHub redirecting
    # back. Neither can carry the header, so both must be exempt.
    # /status is exempt so the frontend can decide whether to surface
    # the Sign-In button before the user has any key set.
    if path.startswith("/api/github/oauth/"):
        return await call_next(request)

    provided = request.headers.get("X-Narrative-Key", "")
    if not provided or not hmac.compare_digest(
        provided.encode("utf-8"), required_key.encode("utf-8")
    ):
        return JSONResponse(
            status_code=401,
            content={"detail": "missing or invalid X-Narrative-Key"},
        )
    return await call_next(request)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500_000)
    voice_id: str | None = None
    rate: int | None = Field(default=None, ge=50, le=400)
    volume: float | None = Field(default=None, ge=0.0, le=1.0)
    # 0..num_speakers-1. Ignored for single-speaker voices and for SAPI.
    # Upper bound is enforced by Piper's model at synth time, not here, since
    # the request can target any voice and we don't want to special-case.
    speaker_id: int | None = Field(default=None, ge=0, le=10000)


class SynthesisSegment(BaseModel):
    text: str = Field(..., min_length=1, max_length=500_000)
    voice_id: str | None = None
    speaker_id: int | None = Field(default=None, ge=0, le=10000)


class SynthesizeSegmentsRequest(BaseModel):
    segments: list[SynthesisSegment] = Field(..., min_length=1, max_length=2000)
    rate: int | None = Field(default=None, ge=50, le=400)
    volume: float | None = Field(default=None, ge=0.0, le=1.0)


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
            return {
                "type": "result",
                "mp3_b64": base64.b64encode(mp3_bytes).decode(),
                "sentence_offsets_ms": ev["sentence_offsets_ms"],
            }

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


@app.get("/api/voices/sample/{voice_id}")
async def voice_sample(voice_id: str, speaker: int = 0):
    """Proxy the official Piper preview MP3 for a (voice, speaker) pair.

    `?speaker=N` picks a specific speaker for multi-speaker models like
    LibriTTS. Defaults to 0 — works for every voice. Cached in-process
    per (voice, speaker), and we ask the browser to cache for a day so
    flipping back and forth doesn't re-hit the network.
    """
    import asyncio

    from tts import catalog

    if speaker < 0 or speaker > 10000:
        raise HTTPException(status_code=400, detail="speaker out of range")

    loop = asyncio.get_running_loop()
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
            return {
                "type": "result",
                "mp3_b64": base64.b64encode(mp3_bytes).decode(),
                "sentence_offsets_ms": ev["sentence_offsets_ms"],
            }

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


class GithubTreeRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    branch: str | None = Field(default=None, max_length=200)
    github_token: str | None = Field(default=None, max_length=200)


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


class GithubBranchesRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    github_token: str | None = Field(default=None, max_length=200)


class GistMetaRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    github_token: str | None = Field(default=None, max_length=200)


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


class ExtractUrlRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    # Optional GitHub Personal Access Token for private-repo URLs.
    # Sent in the body rather than a header so the X-Narrative-Key
    # middleware doesn't have to special-case it. The fetcher only
    # forwards it to github.com / raw.githubusercontent.com (verified
    # post-rewrite), so a token for repo X never leaks to host Y.
    github_token: str | None = Field(default=None, max_length=200)
    # Pre-supplied SHA from the repo browser path (saves a contents API
    # round-trip). Optional; if missing for a GitHub URL the backend
    # looks it up.
    git_sha: str | None = Field(default=None, max_length=80)


class GithubSyncCheckRequest(BaseModel):
    """Batch SHA check. Takes a list of {repoUrl, branch, paths[]} and
    returns the current SHA for each path, so the frontend can flag
    library clips whose stored SHA no longer matches."""
    items: list[dict] = Field(default_factory=list)
    github_token: str | None = Field(default=None, max_length=200)


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
    try:
        text = extract.extract_text(file.filename, data)
    except extract.UnsupportedFormatError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except extract.ExtractionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "filename": file.filename,
        "chars": len(text),
        "text": text,
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
