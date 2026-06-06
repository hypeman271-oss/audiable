"""Smoke test for Phase B / B.2 — upload_sentence_audio endpoint.

Exercises the endpoint function directly with a mock Request so we
don't need to spin up FastAPI. The middleware that normally stamps
tenant_key on request.state is replaced by setting it on the mock.

What this exercises:
    1. Happy path: upload a WAV for a valid line_id → 200 + cache row.
    2. Idempotent re-upload of same bytes → same sha, no duplicate row.
    3. Different bytes for same (clip, line_id) → row updates, sha changes.
    4. Optional voice_id override is recorded.
    5. Negative: clip not found → 404.
    6. Negative: clip has lines_json = null → 409.
    7. Negative: line_id not in lines_json → 404.
    8. Negative: empty WAV body → 400.
    9. Negative: invalid WAV header → 400.

Usage:
    python scripts/smoke_phase_b_b2.py
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace

TMP = Path(tempfile.mkdtemp(prefix="narrative-b2-"))
os.environ["NARRATIVE_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import library_db as ldb  # noqa: E402

# library_api needs to NOT trigger tts/__init__ via its lazy import inside
# the endpoint (only fires when called). So importing the module itself
# is safe — we just have to avoid the engine deps. tts.encode is the
# only thing the endpoint actually uses, and we'll let its lazy import
# resolve naturally inside the endpoint call (Python will find it via
# the same standalone-loader trick the B.1 smoke uses).
import library_api  # noqa: E402

# Pre-load tts.encode under its real name so the endpoint's
# `from tts.encode import ...` succeeds without firing tts/__init__.
_spec = importlib.util.spec_from_file_location(
    "tts.encode",
    Path(__file__).resolve().parent.parent / "tts" / "encode.py",
)
_encode = importlib.util.module_from_spec(_spec)
sys.modules["tts.encode"] = _encode
# tts itself needs to be a package shell so "from tts.encode" works.
sys.modules.setdefault("tts", SimpleNamespace())
_spec.loader.exec_module(_encode)


def fake_wav(seconds: float = 0.5, freq: int = 440, sr: int = 22050) -> bytes:
    import math
    n = int(seconds * sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        for i in range(n):
            s = int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframesraw(struct.pack("<h", s))
    return buf.getvalue()


def mock_request(tenant_key: str, body: bytes) -> SimpleNamespace:
    """Build the minimum Request-shaped object the endpoint touches."""
    state = SimpleNamespace(tenant_key=tenant_key, is_admin=False)
    async def _body():
        return body
    return SimpleNamespace(state=state, body=_body)


def insert_test_clip(
    tenant_key: str,
    clip_id: int,
    lines: list[dict] | None,
    *,
    voice_id: str = "piper:test-v1",
    speaker_id: int = 0,
    rate: int = 100,
) -> None:
    """Direct INSERT for test fixtures (bypasses LWW path)."""
    now = "2026-06-06T16:30:00Z"
    with ldb._conn_lock:
        ldb.conn().execute(
            """
            INSERT INTO clips (
              tenant_key, id, title, text, voice_id, voice_name,
              rate, volume, speaker_id, duration_sec, progress_sec,
              created_at, updated_at, lines_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_key, clip_id, f"test clip {clip_id}", "ignored",
                voice_id, "Test Voice", rate, 1.0, speaker_id,
                0.0, 0.0, now, now,
                json.dumps(lines) if lines is not None else None,
            ),
        )


def ok(msg): print(f"  OK   {msg}")
def fail(msg):
    print(f"  FAIL {msg}")
    sys.exit(1)


async def main() -> int:
    print(f"[smoke] data dir: {TMP}")
    ldb.init_db()
    if not ldb.is_enabled():
        fail(f"library_db disabled: {ldb.disabled_reason()}")
    ok("library_db enabled, schema at v6")

    TENANT = "a" * 64
    CLIP = 9001
    LINE_1 = "c_9001-0001"
    LINE_2 = "c_9001-0002"

    insert_test_clip(
        TENANT, CLIP,
        lines=[
            {"id": LINE_1, "text": "First sentence."},
            {"id": LINE_2, "text": "Second sentence."},
        ],
    )
    ok(f"inserted clip {CLIP} with 2 lines")

    # ── 1. Happy path ────────────────────────────────────────────────────
    wav = fake_wav(seconds=0.5, freq=440)
    req = mock_request(TENANT, wav)
    result = await library_api.upload_sentence_audio(
        clip_id=CLIP, line_id=LINE_1, request=req,
        voice_id=None, speaker_id=None, rate=None,
    )
    if not result.get("ok"):
        fail(f"happy path failed: {result}")
    sha1 = result["sha256"]
    if not (490 <= result["duration_ms"] <= 510):
        fail(f"duration_ms wrong: {result['duration_ms']}")
    ok(f"happy path: sha={sha1[:12]}... dur={result['duration_ms']}ms "
       f"compression={result['bytes_out']/result['bytes_in']:.2f}")

    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    if len(rows) != 1 or rows[0]["audio_sha256"] != sha1:
        fail(f"cache row missing/wrong: {rows}")
    if rows[0]["voice_id"] != "piper:test-v1":
        fail(f"clip-default voice_id not recorded: {rows[0]}")
    ok("cache row recorded with clip-default voice/speaker/rate")

    # ── 2. Idempotent re-upload of identical bytes ───────────────────────
    req = mock_request(TENANT, wav)
    result2 = await library_api.upload_sentence_audio(
        clip_id=CLIP, line_id=LINE_1, request=req,
        voice_id=None, speaker_id=None, rate=None,
    )
    if result2["sha256"] != sha1:
        fail(f"identical bytes produced different sha: {sha1} -> {result2['sha256']}")
    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    if len(rows) != 1:
        fail(f"identical re-upload created extra row: {len(rows)} rows")
    ok("identical re-upload is idempotent (no extra row, same sha)")

    # ── 3. Different bytes for same line → row updates ───────────────────
    wav2 = fake_wav(seconds=0.7, freq=660)
    req = mock_request(TENANT, wav2)
    result3 = await library_api.upload_sentence_audio(
        clip_id=CLIP, line_id=LINE_1, request=req,
        voice_id=None, speaker_id=None, rate=None,
    )
    if result3["sha256"] == sha1:
        fail(f"different bytes produced same sha: {sha1}")
    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    if len(rows) != 1 or rows[0]["audio_sha256"] != result3["sha256"]:
        fail(f"upsert didn't replace: {rows}")
    ok(f"different bytes upserted: new sha={result3['sha256'][:12]}...")

    # ── 4. Voice override is recorded ────────────────────────────────────
    wav3 = fake_wav(seconds=0.4, freq=550)
    req = mock_request(TENANT, wav3)
    await library_api.upload_sentence_audio(
        clip_id=CLIP, line_id=LINE_2, request=req,
        voice_id="kokoro:override-v2", speaker_id=7, rate=120,
    )
    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    line2_row = next(r for r in rows if r["line_id"] == LINE_2)
    if line2_row["voice_id"] != "kokoro:override-v2":
        fail(f"voice_id override not recorded: {line2_row}")
    if line2_row["speaker_id"] != 7 or line2_row["rate"] != 120:
        fail(f"speaker/rate override not recorded: {line2_row}")
    ok("voice/speaker/rate overrides are recorded")

    # ── 5. Negative: clip not found ──────────────────────────────────────
    from fastapi import HTTPException
    try:
        req = mock_request(TENANT, wav)
        await library_api.upload_sentence_audio(
            clip_id=99999, line_id=LINE_1, request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("expected 404 for missing clip, got success")
    except HTTPException as e:
        if e.status_code != 404:
            fail(f"expected 404, got {e.status_code}: {e.detail}")
    ok("missing clip → 404")

    # ── 6. Negative: clip without lines_json → 409 ───────────────────────
    LEGACY_CLIP = 9002
    insert_test_clip(TENANT, LEGACY_CLIP, lines=None)
    try:
        req = mock_request(TENANT, wav)
        await library_api.upload_sentence_audio(
            clip_id=LEGACY_CLIP, line_id=LINE_1, request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("expected 409 for legacy clip, got success")
    except HTTPException as e:
        if e.status_code != 409:
            fail(f"expected 409, got {e.status_code}: {e.detail}")
    ok("legacy clip (lines_json=null) → 409 with clear detail")

    # ── 7. Negative: line_id not in lines_json ───────────────────────────
    try:
        req = mock_request(TENANT, wav)
        await library_api.upload_sentence_audio(
            clip_id=CLIP, line_id="c_9001-9999", request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("expected 404 for missing line_id")
    except HTTPException as e:
        if e.status_code != 404:
            fail(f"expected 404, got {e.status_code}: {e.detail}")
    ok("missing line_id → 404")

    # ── 8. Negative: empty body → 400 ────────────────────────────────────
    try:
        req = mock_request(TENANT, b"")
        await library_api.upload_sentence_audio(
            clip_id=CLIP, line_id=LINE_1, request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("expected 400 for empty body")
    except HTTPException as e:
        if e.status_code != 400:
            fail(f"expected 400, got {e.status_code}: {e.detail}")
    ok("empty body → 400")

    # ── 9. Negative: invalid WAV header → 400 ────────────────────────────
    try:
        req = mock_request(TENANT, b"NOT A WAV FILE")
        await library_api.upload_sentence_audio(
            clip_id=CLIP, line_id=LINE_1, request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("expected 400 for invalid WAV")
    except HTTPException as e:
        if e.status_code != 400:
            fail(f"expected 400, got {e.status_code}: {e.detail}")
    ok("invalid WAV header → 400")

    # ── 10. Tenant scoping: other tenant can't write to this clip ────────
    OTHER_TENANT = "b" * 64
    try:
        req = mock_request(OTHER_TENANT, wav)
        await library_api.upload_sentence_audio(
            clip_id=CLIP, line_id=LINE_1, request=req,
            voice_id=None, speaker_id=None, rate=None,
        )
        fail("other tenant was allowed to write to this clip")
    except HTTPException as e:
        if e.status_code != 404:
            fail(f"expected 404 for tenant-scoped lookup, got {e.status_code}")
    ok("other tenant → 404 (tenant scoping enforced)")

    print("[smoke] ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    finally:
        import shutil
        shutil.rmtree(TMP, ignore_errors=True)
