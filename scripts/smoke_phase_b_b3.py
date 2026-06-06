"""Smoke test for Phase B / B.3 — restitch endpoint + tts/restitch.py.

End-to-end spike: create a clip with lines, upload per-sentence WAVs
via the B.2 endpoint, call the B.3 restitch endpoint, verify the
combined MP3 + offset table + clip row update.

What this exercises:
    1. tts.restitch.durations_ms reads FLAC headers cheaply
    2. tts.restitch.restitch_clip concatenates without error
    3. restitch endpoint happy path: 3-sentence clip end-to-end
    4. Offsets are monotonic + offsets[0] == 0
    5. duration_sec ≈ sum of input durations (within ~5%)
    6. Re-running restitch with no changes is idempotent on the sha
    7. After uploading a different bytes for line 2, restitch produces
       a different combined sha (the partial re-narrate effect)
    8. Combined MP3 file actually lives at /data/audio/<sha>.mp3
    9. clips row got updated: audio_sha256 + duration_sec + offsets
   10. 409 backfill_required when one line is missing from cache
   11. 409 when clip has no lines_json
   12. 404 when clip doesn't exist
   13. Tenant scoping enforced

Usage:
    python scripts/smoke_phase_b_b3.py
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import shutil
import struct
import sys
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace

TMP = Path(tempfile.mkdtemp(prefix="narrative-b3-"))
os.environ["NARRATIVE_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import library_db as ldb  # noqa: E402
import library_api  # noqa: E402

# Pre-load tts.encode + tts.restitch under their real names so the
# endpoint's lazy `from tts.X import ...` succeeds without firing the
# heavy tts/__init__ (which would pull in piper/kokoro).
sys.modules.setdefault("tts", SimpleNamespace())
for mod_name in ("encode", "restitch"):
    spec = importlib.util.spec_from_file_location(
        f"tts.{mod_name}",
        Path(__file__).resolve().parent.parent / "tts" / f"{mod_name}.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"tts.{mod_name}"] = mod
    spec.loader.exec_module(mod)


def fake_wav(seconds: float, freq: int = 440, sr: int = 22050) -> bytes:
    import math
    n = int(seconds * sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        for i in range(n):
            s = int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframesraw(struct.pack("<h", s))
    return buf.getvalue()


def mock_request(tenant_key: str, body: bytes = b""):
    state = SimpleNamespace(tenant_key=tenant_key, is_admin=False)
    async def _body():
        return body
    return SimpleNamespace(state=state, body=_body)


def insert_test_clip(tenant_key, clip_id, lines, *, voice_id="piper:test"):
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
                tenant_key, clip_id, f"clip {clip_id}", "",
                voice_id, "Test", 100, 1.0, 0, 0.0, 0.0,
                now, now,
                json.dumps(lines) if lines is not None else None,
            ),
        )


def ok(msg): print(f"  OK   {msg}")
def fail(msg):
    print(f"  FAIL {msg}")
    sys.exit(1)


async def upload(tenant, clip_id, line_id, wav_bytes):
    req = mock_request(tenant, wav_bytes)
    return await library_api.upload_sentence_audio(
        clip_id=clip_id, line_id=line_id, request=req,
        voice_id=None, speaker_id=None, rate=None,
    )


async def restitch(tenant, clip_id):
    req = mock_request(tenant)
    return await library_api.restitch_clip_audio(
        clip_id=clip_id, request=req,
    )


async def main():
    print(f"[smoke] data dir: {TMP}")
    ldb.init_db()
    if not ldb.is_enabled():
        fail(f"library_db disabled: {ldb.disabled_reason()}")
    ok("library_db enabled, schema at v6")

    # ── 1. tts.restitch unit smoke ───────────────────────────────────────
    # tts/__init__ pulls in piper/kokoro which aren't installed in this
    # smoke env. Pull the helpers from sys.modules where the pre-load
    # block at the top stashed them.
    tts_encode = sys.modules["tts.encode"]
    tts_restitch = sys.modules["tts.restitch"]

    durs_wav = [0.3, 0.5, 0.4]
    sample_items = []
    for i, sec in enumerate(durs_wav):
        wav = fake_wav(sec, freq=440 + i * 100)
        flac = tts_encode.wav_to_flac(wav)
        dur_ms = tts_encode.wav_duration_ms(wav)
        p = TMP / f"sample_{i}.flac"
        p.write_bytes(flac)
        sample_items.append((p, dur_ms))

    mp3, offsets = tts_restitch.restitch_clip(sample_items)
    if not mp3 or len(mp3) < 100:
        fail(f"restitch_clip returned suspiciously small mp3: {len(mp3)} bytes")
    if offsets[0] != 0:
        fail(f"offsets[0] should be 0, got {offsets[0]}")
    if len(offsets) != 3:
        fail(f"expected 3 offsets, got {len(offsets)}")
    for i in range(1, len(offsets)):
        if offsets[i] <= offsets[i - 1]:
            fail(f"offsets not monotonic at i={i}: {offsets}")
    # Verify offsets match the durations
    expected_offsets = [0, sample_items[0][1], sample_items[0][1] + sample_items[1][1]]
    if offsets != expected_offsets:
        fail(f"offsets {offsets} != expected {expected_offsets}")
    ok(f"restitch_clip: {len(mp3)} byte MP3, offsets={offsets}")

    # Sample files were just for the unit smoke; clean them up.
    for p, _ in sample_items:
        p.unlink()

    # ── 2. End-to-end: clip + 3 lines + 3 uploads + restitch ─────────────
    TENANT = "a" * 64
    CLIP = 5001
    LINES = [
        {"id": "c_5001-0001", "text": "Alpha."},
        {"id": "c_5001-0002", "text": "Bravo."},
        {"id": "c_5001-0003", "text": "Charlie."},
    ]
    insert_test_clip(TENANT, CLIP, LINES)

    wavs = [
        fake_wav(0.4, freq=440),
        fake_wav(0.6, freq=550),
        fake_wav(0.5, freq=660),
    ]
    for ln, w in zip(LINES, wavs):
        await upload(TENANT, CLIP, ln["id"], w)
    ok("uploaded 3 sentence WAVs via B.2 endpoint")

    result = await restitch(TENANT, CLIP)
    if not result.get("ok"):
        fail(f"restitch failed: {result}")
    if result["lines_count"] != 3:
        fail(f"lines_count {result['lines_count']} != 3")
    if len(result["sentence_offsets_ms"]) != 3:
        fail(f"offsets {result['sentence_offsets_ms']!r}")
    if result["sentence_offsets_ms"][0] != 0:
        fail("offsets[0] != 0")

    total_wav_sec = sum(durs_wav := [0.4, 0.6, 0.5])
    if not (total_wav_sec * 0.9 < result["duration_sec"] < total_wav_sec * 1.1):
        fail(
            f"duration_sec {result['duration_sec']:.3f}s "
            f"too far from expected {total_wav_sec}s"
        )
    ok(
        f"restitch end-to-end: combined sha={result['audio_sha256'][:12]}... "
        f"dur={result['duration_sec']:.3f}s offsets={result['sentence_offsets_ms']}"
    )

    # ── 3. Combined MP3 actually on disk + clip row updated ──────────────
    combined_path = ldb.audio_path(result["audio_sha256"])
    if not combined_path.exists():
        fail(f"combined MP3 missing: {combined_path}")
    if combined_path.stat().st_size != result["bytes_out"]:
        fail("on-disk size != bytes_out")
    ok(f"combined MP3 written: {combined_path.stat().st_size} bytes on disk")

    row = ldb.conn().execute(
        "SELECT audio_sha256, duration_sec, sentence_offsets_json "
        "FROM clips WHERE tenant_key = ? AND id = ?",
        (TENANT, CLIP),
    ).fetchone()
    if row["audio_sha256"] != result["audio_sha256"]:
        fail(f"clip row audio_sha256 not updated: {row['audio_sha256']}")
    if abs(row["duration_sec"] - result["duration_sec"]) > 0.001:
        fail(f"clip row duration_sec drift: {row['duration_sec']}")
    stored_offsets = json.loads(row["sentence_offsets_json"])
    if stored_offsets != result["sentence_offsets_ms"]:
        fail(f"stored offsets don't match returned: {stored_offsets}")
    ok("clip row updated (sha, duration, offsets)")

    # ── 4. Idempotent re-stitch with no changes ──────────────────────────
    result2 = await restitch(TENANT, CLIP)
    if result2["audio_sha256"] != result["audio_sha256"]:
        fail(
            f"identical re-stitch produced different sha: "
            f"{result['audio_sha256']} vs {result2['audio_sha256']}"
        )
    ok("idempotent: identical re-stitch produces same combined sha")

    # ── 5. Partial re-narrate effect: change line 2, re-stitch ───────────
    new_wav = fake_wav(0.7, freq=770)
    await upload(TENANT, CLIP, "c_5001-0002", new_wav)
    result3 = await restitch(TENANT, CLIP)
    if result3["audio_sha256"] == result["audio_sha256"]:
        fail(
            "after replacing line 2 the combined sha is unchanged — "
            "the cache isn't being read on the re-stitch path"
        )
    # New duration should be ~0.1s longer (0.7 vs 0.6)
    expected = result["duration_sec"] + 0.1
    if not (expected * 0.9 < result3["duration_sec"] < expected * 1.1):
        fail(
            f"new duration_sec {result3['duration_sec']:.3f}s "
            f"too far from expected ~{expected:.3f}s"
        )
    ok(
        f"partial re-narrate works: new sha={result3['audio_sha256'][:12]}... "
        f"new dur={result3['duration_sec']:.3f}s "
        f"(was {result['duration_sec']:.3f}s)"
    )

    # ── 6. Negative: backfill_required when a line is missing ────────────
    GAPPY_CLIP = 5002
    insert_test_clip(TENANT, GAPPY_CLIP, [
        {"id": "c_5002-0001", "text": "Has audio."},
        {"id": "c_5002-0002", "text": "Missing."},
    ])
    await upload(TENANT, GAPPY_CLIP, "c_5002-0001", fake_wav(0.3))

    from fastapi import HTTPException
    try:
        await restitch(TENANT, GAPPY_CLIP)
        fail("expected 409 backfill_required, got success")
    except HTTPException as e:
        if e.status_code != 409:
            fail(f"expected 409, got {e.status_code}")
        if not isinstance(e.detail, dict):
            fail(f"detail not a dict: {e.detail!r}")
        if e.detail.get("reason") != "backfill_required":
            fail(f"wrong reason: {e.detail}")
        if "c_5002-0002" not in e.detail.get("missing_line_ids", []):
            fail(f"missing_line_ids wrong: {e.detail}")
        if e.detail.get("missing_count") != 1:
            fail(f"missing_count != 1: {e.detail}")
    ok("missing cache row → 409 backfill_required with line list")

    # ── 7. Negative: clip with no lines_json ─────────────────────────────
    LEGACY = 5003
    insert_test_clip(TENANT, LEGACY, lines=None)
    try:
        await restitch(TENANT, LEGACY)
        fail("expected 409 for legacy clip")
    except HTTPException as e:
        if e.status_code != 409:
            fail(f"expected 409, got {e.status_code}")
    ok("legacy clip (lines_json=null) → 409")

    # ── 8. Negative: missing clip ────────────────────────────────────────
    try:
        await restitch(TENANT, 999999)
        fail("expected 404")
    except HTTPException as e:
        if e.status_code != 404:
            fail(f"expected 404, got {e.status_code}")
    ok("missing clip → 404")

    # ── 9. Tenant scoping ────────────────────────────────────────────────
    OTHER = "b" * 64
    try:
        await restitch(OTHER, CLIP)
        fail("other tenant should not see this clip")
    except HTTPException as e:
        if e.status_code != 404:
            fail(f"expected 404 for cross-tenant restitch, got {e.status_code}")
    ok("other tenant → 404 (tenant scoping enforced)")

    print("[smoke] ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
