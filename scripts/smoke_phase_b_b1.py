"""Smoke test for Phase B / B.1 — schema v6 migration + sentence cache helpers.

Runs against a temp data dir so it doesn't touch the real DB.

Usage:
    python scripts/smoke_phase_b_b1.py

What it exercises:
    1. Fresh DB migrates v1 → v6 without error.
    2. sentence_audio table exists with the expected columns.
    3. wav_to_flac + wav_duration_ms round-trip a generated WAV.
    4. store_sentence_audio dedup: same bytes → same sha → no second write.
    5. record_sentence_audio upsert: second call with same key overwrites.
    6. list_sentence_audio_for_clip returns rows.
    7. delete_sentence_audio_for_clip wipes only matching clip.
    8. gc_orphan_sentence_audio leaves referenced FLACs and sweeps the rest
       once they're older than the grace window.
"""
from __future__ import annotations

import io
import os
import struct
import sys
import tempfile
import time
import wave
from pathlib import Path

# Point the lib at a tmp dir BEFORE importing it.
TMP = Path(tempfile.mkdtemp(prefix="narrative-b1-"))
os.environ["NARRATIVE_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import library_db as ldb  # noqa: E402

# Load tts/encode.py without triggering tts/__init__'s eager engine imports
# (piper/kokoro/sapi wheels may not be installed in the smoke env).
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "tts_encode",
    Path(__file__).resolve().parent.parent / "tts" / "encode.py",
)
encode = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(encode)


def fake_wav(seconds: float = 0.5, freq: int = 440, sr: int = 22050) -> bytes:
    """Generate a short 16-bit PCM mono WAV with a sine tone."""
    import math
    n_frames = int(seconds * sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n_frames):
            sample = int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframesraw(struct.pack("<h", sample))
    return buf.getvalue()


def ok(msg: str) -> None:
    print(f"  OK  {msg}")


def fail(msg: str) -> None:
    print(f"  FAIL {msg}")
    sys.exit(1)


def main() -> int:
    print(f"[smoke] data dir: {TMP}")

    # ── 0. Initialize the DB (server.py does this at startup) ────────────
    ldb.init_db()

    # ── 1. Fresh DB migrates to v6 ───────────────────────────────────────
    if not ldb.is_enabled():
        fail(f"library_db disabled: {ldb._disabled_reason}")
    with ldb._conn_lock:
        cur = ldb.conn().execute("SELECT version FROM schema_version").fetchone()
    if cur is None or int(cur["version"]) != 6:
        fail(f"schema not at v6: got {cur}")
    ok(f"schema is v{int(cur['version'])}")

    # ── 2. sentence_audio table has the expected columns ─────────────────
    with ldb._conn_lock:
        cols = [r["name"] for r in ldb.conn().execute(
            "PRAGMA table_info(sentence_audio)"
        )]
    expected = {
        "tenant_key", "clip_id", "line_id", "audio_sha256",
        "voice_id", "speaker_id", "rate", "duration_ms", "created_at",
    }
    missing = expected - set(cols)
    if missing:
        fail(f"sentence_audio missing columns: {missing}")
    ok(f"sentence_audio columns: {sorted(cols)}")

    # ── 3. wav_to_flac round-trip ────────────────────────────────────────
    wav = fake_wav(seconds=0.5)
    dur_ms = encode.wav_duration_ms(wav)
    if not (490 <= dur_ms <= 510):
        fail(f"wav_duration_ms wrong: {dur_ms} (expected ~500)")
    ok(f"wav_duration_ms = {dur_ms}ms for a 0.5s tone")

    flac = encode.wav_to_flac(wav)
    if not flac or not flac.startswith(b"fLaC"):
        fail(f"wav_to_flac produced non-FLAC bytes (head={flac[:8]!r})")
    ratio = len(flac) / len(wav)
    ok(f"wav_to_flac: {len(wav)} -> {len(flac)} bytes (ratio {ratio:.2f})")

    # ── 4. store_sentence_audio dedup ────────────────────────────────────
    sha1 = ldb.store_sentence_audio(flac)
    p = ldb.sentence_audio_path(sha1)
    if not p.exists():
        fail(f"FLAC not written to {p}")
    size_after_first = p.stat().st_size
    sha2 = ldb.store_sentence_audio(flac)
    if sha1 != sha2:
        fail(f"sha changed on re-store: {sha1!r} vs {sha2!r}")
    if p.stat().st_size != size_after_first:
        fail("file size changed on re-store (expected idempotent no-op)")
    ok(f"store_sentence_audio dedup: sha={sha1[:12]}... idempotent")

    # ── 5. record_sentence_audio upsert ──────────────────────────────────
    TENANT = "a" * 64
    CLIP = 123
    LINE = "c_123-0001"

    ldb.record_sentence_audio(
        TENANT, CLIP, LINE,
        audio_sha256=sha1,
        voice_id="piper:test", speaker_id=0, rate=100,
        duration_ms=dur_ms,
    )
    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    if len(rows) != 1 or rows[0]["audio_sha256"] != sha1:
        fail(f"insert: bad rows {rows}")
    ok("record_sentence_audio insert verified")

    # Upsert with different sha
    wav2 = fake_wav(seconds=0.3, freq=660)
    flac2 = encode.wav_to_flac(wav2)
    sha_new = ldb.store_sentence_audio(flac2)
    ldb.record_sentence_audio(
        TENANT, CLIP, LINE,
        audio_sha256=sha_new,
        voice_id="piper:test", speaker_id=0, rate=100,
        duration_ms=encode.wav_duration_ms(wav2),
    )
    rows = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    if len(rows) != 1 or rows[0]["audio_sha256"] != sha_new:
        fail(f"upsert didn't replace: {rows}")
    ok("record_sentence_audio upsert (same key) verified")

    # ── 6. Tenant scoping ────────────────────────────────────────────────
    OTHER_TENANT = "b" * 64
    ldb.record_sentence_audio(
        OTHER_TENANT, CLIP, LINE,
        audio_sha256=sha1,
        voice_id="piper:test", speaker_id=0, rate=100,
        duration_ms=dur_ms,
    )
    rows_a = ldb.list_sentence_audio_for_clip(TENANT, CLIP)
    rows_b = ldb.list_sentence_audio_for_clip(OTHER_TENANT, CLIP)
    if len(rows_a) != 1 or len(rows_b) != 1:
        fail(f"tenant scoping broken: a={rows_a} b={rows_b}")
    if rows_a[0]["audio_sha256"] == rows_b[0]["audio_sha256"]:
        # That's fine — sha can match; we just want separate rows
        pass
    ok(f"tenant scoping: each tenant sees its own row "
       f"(a sha={rows_a[0]['audio_sha256'][:8]}, "
       f"b sha={rows_b[0]['audio_sha256'][:8]})")

    # ── 7. delete_sentence_audio_for_clip ────────────────────────────────
    n = ldb.delete_sentence_audio_for_clip(TENANT, CLIP)
    if n != 1:
        fail(f"delete expected 1, got {n}")
    if ldb.list_sentence_audio_for_clip(TENANT, CLIP):
        fail("rows survived delete")
    if not ldb.list_sentence_audio_for_clip(OTHER_TENANT, CLIP):
        fail("delete leaked across tenants")
    ok("delete_sentence_audio_for_clip scoped correctly")

    # Restore for GC test
    ldb.record_sentence_audio(
        TENANT, CLIP, LINE,
        audio_sha256=sha1,
        voice_id="piper:test", speaker_id=0, rate=100,
        duration_ms=dur_ms,
    )

    # ── 8. gc_orphan_sentence_audio ──────────────────────────────────────
    # Drop OTHER_TENANT's reference so sha_new becomes unreferenced.
    ldb.delete_sentence_audio_for_clip(OTHER_TENANT, CLIP)
    # And write an orphan FLAC directly to disk so we can sweep it.
    wav3 = fake_wav(seconds=0.2, freq=880)
    flac3 = encode.wav_to_flac(wav3)
    orphan_sha = ldb.store_sentence_audio(flac3)
    orphan_path = ldb.sentence_audio_path(orphan_sha)

    # Fresh files are inside the 10-min grace window → GC should NOT touch them.
    n_before = ldb.gc_orphan_sentence_audio()
    if n_before != 0:
        fail(f"gc swept files inside grace window: {n_before}")
    ok("gc respects 10-min grace window")

    # Backdate the orphan file's mtime past the grace window.
    past = time.time() - 700  # > 600s
    os.utime(orphan_path, (past, past))
    past_sha_new = ldb.sentence_audio_path(sha_new)
    if past_sha_new.exists():
        os.utime(past_sha_new, (past, past))

    n_after = ldb.gc_orphan_sentence_audio()
    if n_after < 1:
        fail(f"gc didn't sweep orphan: {n_after}")
    if orphan_path.exists():
        fail("orphan FLAC survived gc")
    # The sha1 FLAC is still referenced by TENANT — must survive.
    if not ldb.sentence_audio_path(sha1).exists():
        fail("referenced FLAC was swept!")
    ok(f"gc swept {n_after} orphan(s); referenced FLAC survived")

    print("[smoke] ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        import shutil
        shutil.rmtree(TMP, ignore_errors=True)
