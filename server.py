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
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import extract
import tts

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB cap on uploads

STATIC_DIR = Path(__file__).parent / "static"

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
                    yield f"data: {_json.dumps({'type': 'error', 'message': f'mp3 encode failed: {exc}'})}\n\n"
                    break
            yield f"data: {_json.dumps(event)}\n\n"

    return StreamingResponse(
        _agen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # tell nginx not to buffer SSE
        },
    )


class ExtractUrlRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)


@app.post("/api/extract/url")
async def extract_url_endpoint(req: ExtractUrlRequest):
    """Fetch a URL server-side and extract the article text."""
    import asyncio

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None, extract.fetch_and_extract_url, req.url
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

    PORT = 8000
    _print_banner(PORT)
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=False)
