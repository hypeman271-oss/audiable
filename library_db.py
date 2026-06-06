"""Server-side library storage (v221.sync-2).

SQLite + a Fly volume at /data. Stores clips, library order, characters,
presets, and settings; audio MP3 blobs live as files under /data/audio/
keyed by sha256 so identical re-narrates dedup automatically.

The schema is forward-compatible via a `schema_version` table — future
migrations land as additional `_apply_vN` functions. Schema v1 is
idempotent (CREATE TABLE IF NOT EXISTS) so re-running `_init_db()` on
every server boot is safe.

Graceful degradation: if NARRATIVE_DATA_DIR (default /data) isn't
writable, log a warning and disable the library API. The app still
works for non-sync users — Path B is opt-in per device.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import sys
import threading
from pathlib import Path

# Override via env var so local dev can use ./data/ instead of /data/.
# Empty string disables persistence entirely (also valid).
DATA_DIR = Path(os.environ.get("NARRATIVE_DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "narrative.db"
AUDIO_DIR = DATA_DIR / "audio"
# v6 (#811): per-sentence FLAC cache for partial re-narrate. Same
# content-addressed pattern as AUDIO_DIR — identical sentences (same
# text + voice + speaker + rate) produce the same sha256 and dedup
# across clips. See docs/phase-b-design.md for the full design.
SENTENCE_DIR = DATA_DIR / "sentences"

# Schema version currently shipped. Bumped when a new migration is added.
CURRENT_SCHEMA_VERSION = 6

# Per-tenant directory file. Lists every alpha-tester bearer the admin
# has minted, keyed by sha256(bearer). The raw bearers are stored here
# so the admin can recover them if needed, but the API only ever re-
# emits them at creation time (the dialog says "copy this now" — same
# pattern as a GitHub personal access token). See SYNC.md
# "Multi-tenant" section for the full rationale.
TENANTS_PATH = DATA_DIR / "tenants.json"

# v1 schema — see SYNC.md for the design rationale. Every "live" table
# carries updated_at (ISO8601 string, client wall-clock at save time)
# for the per-clip last-write-wins rule. Soft delete via `deleted=1`
# so device A deleting while device B is offline doesn't have B
# silently re-uploading on reconnect.
_SCHEMA_V1_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  voice_id TEXT,
  voice_name TEXT,
  rate INTEGER,
  volume REAL,
  speaker_id INTEGER,
  duration_sec REAL,
  progress_sec REAL DEFAULT 0,
  sentence_offsets_json TEXT,
  bookmarks_json TEXT,
  note TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  tags_json TEXT,
  cover_json TEXT,
  git_ref_json TEXT,
  audio_sha256 TEXT,
  images_json TEXT,
  synth_ok INTEGER DEFAULT 1,
  synth_silent_sentence_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_clips_updated ON clips(updated_at);
CREATE INDEX IF NOT EXISTS idx_clips_deleted ON clips(deleted);
CREATE INDEX IF NOT EXISTS idx_clips_audio_sha ON clips(audio_sha256);

CREATE TABLE IF NOT EXISTS library_order (
  position INTEGER PRIMARY KEY,
  clip_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  voice_id TEXT,
  speaker_id INTEGER,
  gender TEXT,
  color TEXT,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT,
  voice_id TEXT,
  rate INTEGER,
  volume REAL,
  speaker_id INTEGER,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


# Thread-safe lazy singleton. SQLite connections aren't safe to share
# across threads by default; we enable check_same_thread=False after
# verifying serialization is on (it is, by default). The per-process
# lock serializes WRITE access; reads under WAL go through fine.
_conn: "sqlite3.Connection | None" = None
_conn_lock = threading.RLock()
_disabled_reason: str | None = None


def is_enabled() -> bool:
    """True iff the data dir is writable and the connection is open."""
    return _conn is not None and _disabled_reason is None


def disabled_reason() -> str | None:
    """Human-readable reason sync isn't available, or None if it is."""
    return _disabled_reason


def init_db() -> None:
    """Initialize the data dir, open the connection, run migrations.

    Call once at server startup. Idempotent. On failure, logs and
    leaves the module in 'disabled' state — callers should check
    `is_enabled()` before touching anything else here.
    """
    global _conn, _disabled_reason

    with _conn_lock:
        if _conn is not None:
            return

        # Check the data dir. Empty string in the env var is an
        # explicit "don't try" signal — useful for tests that import
        # this module without wanting a real DB.
        if not str(DATA_DIR):
            _disabled_reason = "NARRATIVE_DATA_DIR is empty"
            print(
                f"[library_db] {_disabled_reason} — sync disabled",
                file=sys.stderr, flush=True,
            )
            return

        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        except (PermissionError, OSError) as e:
            _disabled_reason = f"cannot create {DATA_DIR}: {e}"
            print(
                f"[library_db] {_disabled_reason} — sync disabled",
                file=sys.stderr, flush=True,
            )
            return

        # Probe writability before opening the DB so we get a clearer
        # error than sqlite's "unable to open database file".
        probe = DATA_DIR / ".write_probe"
        try:
            probe.write_text("ok")
            probe.unlink()
        except OSError as e:
            _disabled_reason = f"{DATA_DIR} not writable: {e}"
            print(
                f"[library_db] {_disabled_reason} — sync disabled",
                file=sys.stderr, flush=True,
            )
            return

        try:
            _conn = sqlite3.connect(
                str(DB_PATH),
                check_same_thread=False,
                isolation_level=None,  # autocommit; we use explicit BEGIN
            )
            _conn.row_factory = sqlite3.Row
            # WAL: better concurrency (readers don't block writers).
            # Synchronous NORMAL is the standard WAL pairing — fsync
            # less often but durable across app crashes. Power loss
            # could lose the last transaction; acceptable for our use.
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA synchronous=NORMAL")
            _conn.execute("PRAGMA foreign_keys=ON")
            _migrate(_conn)
        except Exception as e:
            _disabled_reason = f"DB init failed: {e}"
            print(
                f"[library_db] {_disabled_reason} — sync disabled",
                file=sys.stderr, flush=True,
            )
            _conn = None
            return

        print(
            f"[library_db] ready at {DB_PATH} (schema v{CURRENT_SCHEMA_VERSION})",
            file=sys.stderr, flush=True,
        )


def conn() -> sqlite3.Connection:
    """Return the singleton connection. Raises if not initialized."""
    if _conn is None:
        raise RuntimeError(
            f"library_db not initialized "
            f"({_disabled_reason or 'init_db() not called'})"
        )
    return _conn


def write_lock() -> threading.RLock:
    """Acquire before doing multi-statement writes. WAL allows
    concurrent reads but multiple writers can still race on the same
    row's last-write-wins comparison; the lock makes that comparison
    atomic at the Python level."""
    return _conn_lock


def _migrate(c: sqlite3.Connection) -> None:
    """Run any pending schema migrations.

    Reads the current version from the schema_version table (creating
    it via the v1 SQL block if it doesn't exist) and applies any
    `_apply_vN` for N > current.
    """
    # Ensure the v1 tables exist first — including schema_version
    # itself. This block is idempotent so re-running on every boot
    # is safe.
    c.executescript(_SCHEMA_V1_SQL)

    current = 0
    row = c.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
    if row:
        current = int(row["version"])

    if current < 1:
        # v1 schema was just applied above; record it.
        c.execute("DELETE FROM schema_version")
        c.execute("INSERT INTO schema_version(version) VALUES (1)")
        current = 1

    if current < 2:
        _apply_v2(c)
        c.execute("UPDATE schema_version SET version = 2")
        current = 2

    if current < 3:
        _apply_v3(c)
        c.execute("UPDATE schema_version SET version = 3")
        current = 3

    if current < 4:
        _apply_v4(c)
        c.execute("UPDATE schema_version SET version = 4")
        current = 4

    if current < 5:
        _apply_v5(c)
        c.execute("UPDATE schema_version SET version = 5")
        current = 5

    if current < 6:
        _apply_v6(c)
        c.execute("UPDATE schema_version SET version = 6")
        current = 6

    if current != CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"schema version mismatch: DB at v{current}, code expects "
            f"v{CURRENT_SCHEMA_VERSION}. Missing a migration?"
        )


# ──────────────────────────────────────────────────────────────────────
# Schema v2 — add tenant_key partition column to every live table.
#
# Rationale in SYNC.md "Multi-tenant" section. Short version: alpha
# testers handed one shared NARRATIVE_KEY would see + clobber each
# other's libraries the moment any of them flipped sync on. v2 adds
# a tenant_key column to every per-user table; library_api queries
# filter by tenant_key from request.state. Bearer → tenant mapping
# happens in the auth middleware (see #438).
#
# Migration recreates each table with `(tenant_key, ...)` as the
# PRIMARY KEY so two tenants can independently mint the same clip.id
# or settings.key without collision. Existing v1 rows are tagged with
# the admin tenant (sha256 of NARRATIVE_KEY env var) — they were the
# admin's data before multi-tenant existed.
# ──────────────────────────────────────────────────────────────────────


def _admin_tenant_key_for_migration() -> str:
    """The tenant_key the admin's pre-multi-tenant rows get tagged with.
    Computed from NARRATIVE_KEY at migration time so an incoming admin
    bearer (which the auth middleware will hash the same way) lands on
    the same rows. If the env var is empty we still tag with sha256('')
    — the admin can re-set NARRATIVE_KEY and re-run a one-off retag if
    they ever care."""
    raw = os.environ.get("NARRATIVE_KEY", "") or ""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def compute_tenant_key(bearer: str) -> str:
    """sha256(bearer) — the canonical mapping from a per-device key to
    its tenant partition. Stable across processes and machines so
    desktop + phone with the same bearer hit the same rows."""
    return hashlib.sha256((bearer or "").encode("utf-8")).hexdigest()


def _apply_v2(c: sqlite3.Connection) -> None:
    """Recreate every live table with a tenant_key partition column.

    SQLite can't add a column to a PRIMARY KEY in place, so we use the
    "copy into a new table, drop the old, rename" pattern. Wrapped in a
    transaction so a mid-migration failure rolls back cleanly.
    """
    admin = _admin_tenant_key_for_migration()
    print(
        f"[library_db] migrating to schema v2 (admin tenant = {admin[:12]}…)",
        file=sys.stderr, flush=True,
    )

    c.execute("BEGIN")
    try:
        # ───── clips ─────
        c.execute(
            """
            CREATE TABLE clips_v2 (
              tenant_key TEXT NOT NULL,
              id INTEGER NOT NULL,
              title TEXT NOT NULL,
              text TEXT NOT NULL DEFAULT '',
              voice_id TEXT,
              voice_name TEXT,
              rate INTEGER,
              volume REAL,
              speaker_id INTEGER,
              duration_sec REAL,
              progress_sec REAL DEFAULT 0,
              sentence_offsets_json TEXT,
              bookmarks_json TEXT,
              note TEXT DEFAULT '',
              notes TEXT DEFAULT '',
              tags_json TEXT,
              cover_json TEXT,
              git_ref_json TEXT,
              audio_sha256 TEXT,
              images_json TEXT,
              synth_ok INTEGER DEFAULT 1,
              synth_silent_sentence_count INTEGER DEFAULT 0,
              created_at TEXT,
              updated_at TEXT NOT NULL,
              last_synced_at TEXT,
              deleted INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (tenant_key, id)
            )
            """
        )
        c.execute(
            "INSERT INTO clips_v2 (tenant_key, id, title, text, voice_id, "
            "voice_name, rate, volume, speaker_id, duration_sec, "
            "progress_sec, sentence_offsets_json, bookmarks_json, note, "
            "notes, tags_json, cover_json, git_ref_json, audio_sha256, "
            "images_json, synth_ok, synth_silent_sentence_count, "
            "created_at, updated_at, last_synced_at, deleted) "
            "SELECT ?, id, title, text, voice_id, voice_name, rate, volume, "
            "speaker_id, duration_sec, progress_sec, sentence_offsets_json, "
            "bookmarks_json, note, notes, tags_json, cover_json, "
            "git_ref_json, audio_sha256, images_json, synth_ok, "
            "synth_silent_sentence_count, created_at, updated_at, "
            "last_synced_at, deleted FROM clips",
            (admin,),
        )
        c.execute("DROP TABLE clips")
        c.execute("ALTER TABLE clips_v2 RENAME TO clips")
        c.execute("CREATE INDEX IF NOT EXISTS idx_clips_tenant ON clips(tenant_key)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_clips_updated ON clips(updated_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_clips_deleted ON clips(deleted)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_clips_audio_sha ON clips(audio_sha256)")

        # ───── library_order ─────
        c.execute(
            """
            CREATE TABLE library_order_v2 (
              tenant_key TEXT NOT NULL,
              position INTEGER NOT NULL,
              clip_id INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (tenant_key, position)
            )
            """
        )
        c.execute(
            "INSERT INTO library_order_v2 (tenant_key, position, clip_id, "
            "updated_at) SELECT ?, position, clip_id, updated_at FROM "
            "library_order",
            (admin,),
        )
        c.execute("DROP TABLE library_order")
        c.execute("ALTER TABLE library_order_v2 RENAME TO library_order")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_library_order_tenant "
            "ON library_order(tenant_key)"
        )

        # ───── characters ─────
        c.execute(
            """
            CREATE TABLE characters_v2 (
              tenant_key TEXT NOT NULL,
              id TEXT NOT NULL,
              name TEXT NOT NULL,
              voice_id TEXT,
              speaker_id INTEGER,
              gender TEXT,
              color TEXT,
              updated_at TEXT NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (tenant_key, id)
            )
            """
        )
        c.execute(
            "INSERT INTO characters_v2 (tenant_key, id, name, voice_id, "
            "speaker_id, gender, color, updated_at, deleted) "
            "SELECT ?, id, name, voice_id, speaker_id, gender, color, "
            "updated_at, deleted FROM characters",
            (admin,),
        )
        c.execute("DROP TABLE characters")
        c.execute("ALTER TABLE characters_v2 RENAME TO characters")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_characters_tenant "
            "ON characters(tenant_key)"
        )

        # ───── presets ─────
        c.execute(
            """
            CREATE TABLE presets_v2 (
              tenant_key TEXT NOT NULL,
              id TEXT NOT NULL,
              name TEXT,
              voice_id TEXT,
              rate INTEGER,
              volume REAL,
              speaker_id INTEGER,
              updated_at TEXT NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (tenant_key, id)
            )
            """
        )
        c.execute(
            "INSERT INTO presets_v2 (tenant_key, id, name, voice_id, rate, "
            "volume, speaker_id, updated_at, deleted) "
            "SELECT ?, id, name, voice_id, rate, volume, speaker_id, "
            "updated_at, deleted FROM presets",
            (admin,),
        )
        c.execute("DROP TABLE presets")
        c.execute("ALTER TABLE presets_v2 RENAME TO presets")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_presets_tenant ON presets(tenant_key)"
        )

        # ───── settings ─────
        c.execute(
            """
            CREATE TABLE settings_v2 (
              tenant_key TEXT NOT NULL,
              key TEXT NOT NULL,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (tenant_key, key)
            )
            """
        )
        c.execute(
            "INSERT INTO settings_v2 (tenant_key, key, value, updated_at) "
            "SELECT ?, key, value, updated_at FROM settings",
            (admin,),
        )
        c.execute("DROP TABLE settings")
        c.execute("ALTER TABLE settings_v2 RENAME TO settings")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_settings_tenant ON settings(tenant_key)"
        )

        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


# ──────────────────────────────────────────────────────────────────────
# Schema v3 — add annotations_json column to clips for phone-native
# revision annotations (see STRATEGY.md "Phone-native annotation"
# section + v223.annotate-1 in app.js). Each clip carries an array
# of {id, sentenceIndex, sentenceFingerprint, flaggedAt, tags[], ...}
# entries; the column stores the JSON-serialized array so we don't
# need a relational join for what's a per-clip property.
#
# This is an additive change — existing rows get NULL, which the
# library_api reads as []. No data loss, no recreate, no transaction
# needed (ALTER TABLE ADD COLUMN is atomic in SQLite).
# ──────────────────────────────────────────────────────────────────────


def _apply_v3(c: sqlite3.Connection) -> None:
    """Add annotations_json TEXT column to clips."""
    print(
        "[library_db] migrating to schema v3 (add clips.annotations_json)",
        file=sys.stderr, flush=True,
    )
    c.execute("ALTER TABLE clips ADD COLUMN annotations_json TEXT")


# ──────────────────────────────────────────────────────────────────────
# Schema v4 — add `kind` column to clips so ebook clips sync.
#
# Background: #690 introduced ebook-mode clips that carry text + cover
# but no audio. The original sync push payload + ClipUpsert model
# dropped clip.kind, so receiving devices saw a clip with no kind and
# no audio — book-view routing didn't fire and the clip looked broken.
# Adding the column lets ebook clips round-trip end-to-end.
#
# Additive ALTER, no recreate, no transaction needed. Existing rows
# get NULL — which the library_api emits as `null` in JSON and the
# client reads as undefined, which is exactly what an audio-only clip
# should be.
# ──────────────────────────────────────────────────────────────────────


def _apply_v4(c: sqlite3.Connection) -> None:
    """Add kind TEXT column to clips. NULL = audio clip (legacy default)."""
    print(
        "[library_db] migrating to schema v4 (add clips.kind for ebook sync)",
        file=sys.stderr, flush=True,
    )
    c.execute("ALTER TABLE clips ADD COLUMN kind TEXT")


# ──────────────────────────────────────────────────────────────────────
# Schema v5 — Author-mode per-sentence storage (#810 / #586).
#
# Adds two columns to clips, both NULL on legacy rows:
#   lines_json    JSON array [{id, text, hash, voiceOverride?}, ...]
#                 When NULL: clip is in the legacy blob model. clips.text
#                 is authoritative. Reading view / annotations index by
#                 sentence position.
#                 When set: line-by-line storage is enabled. clips.text
#                 becomes a derived view (lines.map(l=>l.text).join).
#                 Annotations anchor by line.id; reading view renders
#                 from lines with data-line-id attributes.
#   next_line_seq INTEGER. Monotonic counter for minting line IDs on
#                 this clip. id = `c_{clip_id}-{seq:04d}`. Birth-order,
#                 never reused. NULL until the clip opts in.
#
# Both columns are additive ALTERs so the migration is one-way safe and
# downlevel clients (which don't know the columns exist) reading via
# library_api just see NULL → emit no `lines` / `nextLineSeq` field in
# the response, and the existing blob path runs unchanged.
#
# See SENTENCE_IDS.md for the ID derivation decision (clip-local
# counter, not content hash).
# ──────────────────────────────────────────────────────────────────────


def _apply_v5(c: sqlite3.Connection) -> None:
    """Add lines_json + next_line_seq columns for Author-mode per-
    sentence storage. Both NULL for legacy clips; populated only when
    the user opts a clip in via the Edit dialog toggle."""
    print(
        "[library_db] migrating to schema v5 (add clips.lines_json + "
        "next_line_seq for Author-mode per-sentence storage)",
        file=sys.stderr, flush=True,
    )
    c.execute("ALTER TABLE clips ADD COLUMN lines_json TEXT")
    c.execute("ALTER TABLE clips ADD COLUMN next_line_seq INTEGER")


# ──────────────────────────────────────────────────────────────────────
# Schema v6 — per-sentence FLAC cache for partial re-narrate (#811).
#
# When a clip has opted into per-line storage (v5 lines_json non-NULL),
# the synth pipeline writes each sentence's WAV to /data/sentences/
# keyed by sha256, and inserts a row here pointing at it. Partial
# re-narrate then re-synthesizes one sentence, swaps the row, and
# re-stitches the combined MP3 from all the cached FLACs — no seam
# artifact, unlike the splice.py path which atrim+concats the combined
# MP3 directly.
#
# Cache key is (tenant_key, clip_id, line_id) where line_id is the
# stable Phase A ID ("c_{clip_id}-{seq:04d}"). Indexing by position
# would invalidate the cache on every insertion; line_id is birth-
# ordered and never reused.
#
# duration_ms is pre-computed so re-stitch doesn't have to reopen the
# FLACs to build the offset table. We trust the value because it's
# written at the same atomic moment as the file itself.
#
# See docs/phase-b-design.md for the full design.
# ──────────────────────────────────────────────────────────────────────


def _apply_v6(c: sqlite3.Connection) -> None:
    """Add sentence_audio table for per-sentence FLAC cache."""
    print(
        "[library_db] migrating to schema v6 (add sentence_audio table "
        "for Phase B per-sentence WAV cache)",
        file=sys.stderr, flush=True,
    )
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS sentence_audio (
          tenant_key TEXT NOT NULL,
          clip_id INTEGER NOT NULL,
          line_id TEXT NOT NULL,
          audio_sha256 TEXT NOT NULL,
          voice_id TEXT,
          speaker_id INTEGER,
          rate INTEGER,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_key, clip_id, line_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sentence_audio_sha
          ON sentence_audio(audio_sha256);
        CREATE INDEX IF NOT EXISTS idx_sentence_audio_clip
          ON sentence_audio(tenant_key, clip_id);
        """
    )


# ──────────────────────────────────────────────────────────────────────
# Tenant directory (/data/tenants.json).
#
# Tester bearers + the admin label. The file is read on every auth
# check so it stays in sync without a restart when the admin mints
# or revokes a key. Concurrency: writes go through _tenants_lock so
# two admin requests minting at the same moment can't corrupt the
# file. Reads are unlocked — JSON parsing on a partial write would
# just raise, and the next read after the writer's atomic rename
# succeeds.
# ──────────────────────────────────────────────────────────────────────

_tenants_lock = threading.RLock()


def _empty_tenants() -> dict:
    return {"tenants": []}


def load_tenants() -> dict:
    """Read /data/tenants.json or return an empty shell."""
    try:
        if TENANTS_PATH.exists():
            return json.loads(TENANTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"[library_db] tenants.json read failed: {e} — using empty list",
            file=sys.stderr, flush=True,
        )
    return _empty_tenants()


def _save_tenants(data: dict) -> None:
    """Atomically rewrite /data/tenants.json. Caller must hold lock."""
    TENANTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = TENANTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(TENANTS_PATH)


def _mint_bearer() -> str:
    """Mint a new opaque bearer. Format: narrative-XXXX-XXXX-XXXX-XXXX
    where each XXXX is 4 base32-ish chars (no I/O/0/1 to avoid OCR
    confusion). 16 random chars total = ~80 bits of entropy, plenty
    for a closed alpha; trivially upgradeable to UUIDv4 if we ever
    want machine-readable bearers."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"  # 31 chars
    chunks = []
    for _ in range(4):
        chunks.append("".join(secrets.choice(alphabet) for _ in range(4)))
    return "narrative-" + "-".join(chunks)


def create_tenant(label: str) -> dict:
    """Mint a new tester bearer + tenant_key, persist, return the full
    record INCLUDING the raw bearer. Admin captures the bearer from this
    response and shares it with the tester out-of-band; after this it's
    only retrievable from tenants.json on disk (the API listing endpoint
    redacts it)."""
    if not is_enabled():
        raise RuntimeError(f"library_db not enabled: {_disabled_reason}")
    label = (label or "").strip()
    if not label:
        raise ValueError("tenant label is required")

    with _tenants_lock:
        data = load_tenants()
        # Try a few times to avoid the astronomical chance of two
        # simultaneous mints picking the same bearer.
        for _ in range(8):
            bearer = _mint_bearer()
            tk = compute_tenant_key(bearer)
            if not any(t.get("tenant_key") == tk for t in data["tenants"]):
                break
        else:
            raise RuntimeError("could not mint a unique bearer after 8 tries")

        record = {
            "label": label,
            "key": bearer,
            "tenant_key": tk,
            "created_at": _iso_now(),
            "last_seen_at": None,
        }
        data["tenants"].append(record)
        _save_tenants(data)
        return dict(record)


def list_tenants(include_keys: bool = False) -> list[dict]:
    """List tenant records. By default the raw `key` field is stripped
    so a leaky log line or screen-share doesn't expose every tester's
    bearer. Pass include_keys=True for one-off rescue / debug only."""
    data = load_tenants()
    out = []
    for t in data.get("tenants", []):
        rec = {
            "label": t.get("label", ""),
            "tenant_key": t.get("tenant_key", ""),
            "created_at": t.get("created_at"),
            "last_seen_at": t.get("last_seen_at"),
        }
        if include_keys:
            rec["key"] = t.get("key", "")
        out.append(rec)
    return out


def revoke_tenant(tenant_key: str) -> bool:
    """Remove the tester record. Existing DB rows under the tenant_key
    stay (they're unreachable now) — we leak the data cheap-and-
    reversibly. Returns True if a record was removed."""
    with _tenants_lock:
        data = load_tenants()
        before = len(data["tenants"])
        data["tenants"] = [
            t for t in data["tenants"] if t.get("tenant_key") != tenant_key
        ]
        if len(data["tenants"]) == before:
            return False
        _save_tenants(data)
        return True


def find_bearer(bearer: str) -> dict | None:
    """Look up a raw bearer in tenants.json. Returns the record (with
    `key` included so the caller can re-stamp last_seen_at) or None if
    not found. The admin's NARRATIVE_KEY does NOT live in this file —
    the auth middleware checks env first, falls back here."""
    if not bearer:
        return None
    tk = compute_tenant_key(bearer)
    for t in load_tenants().get("tenants", []):
        if t.get("tenant_key") == tk:
            return dict(t)
    return None


def touch_tenant_seen(tenant_key: str) -> None:
    """Update last_seen_at for a tenant. Best-effort; failures swallowed.
    Called from the auth middleware on each authenticated request — keep
    it cheap. Skips writes that wouldn't change the bucketed timestamp
    (whole-minute granularity) to avoid one-write-per-request churn."""
    if not tenant_key:
        return
    now_iso = _iso_now()
    # Bucket to whole minutes — same-minute requests skip the write.
    now_min = now_iso[:16]  # YYYY-MM-DDTHH:MM
    with _tenants_lock:
        try:
            data = load_tenants()
            changed = False
            for t in data.get("tenants", []):
                if t.get("tenant_key") == tenant_key:
                    prev = (t.get("last_seen_at") or "")[:16]
                    if prev != now_min:
                        t["last_seen_at"] = now_iso
                        changed = True
                    break
            if changed:
                _save_tenants(data)
        except OSError:
            pass


def _iso_now() -> str:
    """UTC ISO8601 with seconds precision, Z suffix — matches the
    rest of the codebase. Imported lazily so this module stays
    import-cheap at boot."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


# ──────────────────────────────────────────────────────────────────────
# Audio blob storage. Content-addressed by sha256 of the raw bytes so
# re-narrating with the same voice + text produces the same hash and
# we don't double-store. Each clip row carries audio_sha256; the
# audio file lives at AUDIO_DIR / <sha>.mp3.
# ──────────────────────────────────────────────────────────────────────


def store_audio(blob: bytes) -> str:
    """Write `blob` to AUDIO_DIR / <sha256>.mp3 and return the sha256.

    Idempotent: if the file already exists the bytes are not rewritten
    (sha256 collision means identical content under any reasonable
    threat model). Caller is responsible for updating clip rows to
    reference the returned sha.
    """
    if not is_enabled():
        raise RuntimeError(f"library_db not enabled: {_disabled_reason}")
    sha = hashlib.sha256(blob).hexdigest()
    dest = AUDIO_DIR / f"{sha}.mp3"
    if not dest.exists():
        # Write to a tmp path then rename, so a partial write doesn't
        # leave a corrupt blob under the canonical sha name. Two
        # concurrent stores of the same sha will both write the same
        # bytes; last rename wins, no harm done.
        tmp = AUDIO_DIR / f".{sha}.tmp"
        tmp.write_bytes(blob)
        tmp.replace(dest)
    return sha


def audio_path(sha256: str) -> Path:
    """Path to an audio blob. Caller checks .exists()."""
    # Defensive: reject anything that doesn't look like a hex sha so a
    # path-traversal attempt via the API endpoint can't reach outside
    # AUDIO_DIR. Real sha256 is 64 hex chars.
    if not sha256 or len(sha256) != 64 or any(
        c not in "0123456789abcdef" for c in sha256.lower()
    ):
        raise ValueError(f"invalid sha256: {sha256!r}")
    return AUDIO_DIR / f"{sha256}.mp3"


# ──────────────────────────────────────────────────────────────────────
# Per-sentence FLAC cache (#811 / schema v6).
#
# Mirrors the audio helpers above. Files live at SENTENCE_DIR/<sha>.flac.
# The DB layer doesn't encode FLAC — callers hand us encoded bytes from
# tts.encode.wav_to_flac. This keeps library_db free of an ffmpeg
# dependency at module-import time.
# ──────────────────────────────────────────────────────────────────────


def store_sentence_audio(flac_bytes: bytes) -> str:
    """Write `flac_bytes` to SENTENCE_DIR / <sha256>.flac and return the sha.

    Idempotent: if the file already exists the bytes are not rewritten
    (sha256 collision implies identical content). Tmp-then-rename guards
    against partial writes leaving a corrupt blob at the canonical name.
    Caller is responsible for inserting/updating the sentence_audio row.
    """
    if not is_enabled():
        raise RuntimeError(f"library_db not enabled: {_disabled_reason}")
    if not flac_bytes:
        raise ValueError("flac_bytes is empty")
    SENTENCE_DIR.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256(flac_bytes).hexdigest()
    dest = SENTENCE_DIR / f"{sha}.flac"
    if not dest.exists():
        tmp = SENTENCE_DIR / f".{sha}.tmp"
        tmp.write_bytes(flac_bytes)
        tmp.replace(dest)
    return sha


def sentence_audio_path(sha256: str) -> Path:
    """Path to a sentence FLAC blob. Caller checks .exists().

    Defensive sha validation matches audio_path() so a path-traversal
    attempt via the API endpoint can't reach outside SENTENCE_DIR.
    """
    if not sha256 or len(sha256) != 64 or any(
        c not in "0123456789abcdef" for c in sha256.lower()
    ):
        raise ValueError(f"invalid sha256: {sha256!r}")
    return SENTENCE_DIR / f"{sha256}.flac"


def record_sentence_audio(
    tenant_key: str,
    clip_id: int,
    line_id: str,
    *,
    audio_sha256: str,
    voice_id: str | None,
    speaker_id: int | None,
    rate: int | None,
    duration_ms: int,
) -> None:
    """UPSERT a row into sentence_audio.

    Called by the synth pipeline once per sentence yielded, and by the
    partial-re-narrate endpoint after a single-sentence resynth. The
    PRIMARY KEY (tenant_key, clip_id, line_id) collapses duplicate
    inserts to the latest write.
    """
    if not is_enabled():
        raise RuntimeError(f"library_db not enabled: {_disabled_reason}")
    if not tenant_key:
        raise ValueError("tenant_key required")
    if not line_id:
        raise ValueError("line_id required")
    if duration_ms < 0:
        raise ValueError(f"duration_ms must be non-negative, got {duration_ms}")
    now = _iso_now()
    with _conn_lock:
        conn().execute(
            """
            INSERT INTO sentence_audio (
              tenant_key, clip_id, line_id, audio_sha256,
              voice_id, speaker_id, rate, duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_key, clip_id, line_id) DO UPDATE SET
              audio_sha256 = excluded.audio_sha256,
              voice_id = excluded.voice_id,
              speaker_id = excluded.speaker_id,
              rate = excluded.rate,
              duration_ms = excluded.duration_ms,
              created_at = excluded.created_at
            """,
            (
                tenant_key, int(clip_id), line_id, audio_sha256,
                voice_id, speaker_id, rate, int(duration_ms), now,
            ),
        )
        conn().commit()


def list_sentence_audio_for_clip(tenant_key: str, clip_id: int) -> list[dict]:
    """Return all cached sentences for a clip, as a list of dicts.

    Order is not guaranteed — callers walk the clip's lines_json to
    place rows in document order. Use this to check coverage before
    re-stitching: missing line_ids mean a backfill is needed.

    Each dict: {line_id, audio_sha256, voice_id, speaker_id, rate,
                duration_ms, created_at}.
    """
    if not is_enabled():
        return []
    with _conn_lock:
        rows = conn().execute(
            """
            SELECT line_id, audio_sha256, voice_id, speaker_id, rate,
                   duration_ms, created_at
            FROM sentence_audio
            WHERE tenant_key = ? AND clip_id = ?
            """,
            (tenant_key, int(clip_id)),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_sentence_audio_for_clip(tenant_key: str, clip_id: int) -> int:
    """Delete every cache row for a clip. Returns count deleted.

    Called when a clip is hard-deleted, or when the user toggles per-
    line storage OFF and accepts losing the cache. Does NOT delete the
    FLAC files — those go through gc_orphan_sentence_audio so other
    clips' identical sentences (cross-clip dedup) survive.
    """
    if not is_enabled():
        return 0
    with _conn_lock:
        cur = conn().execute(
            "DELETE FROM sentence_audio WHERE tenant_key = ? AND clip_id = ?",
            (tenant_key, int(clip_id)),
        )
        conn().commit()
        return cur.rowcount or 0


def gc_orphan_sentence_audio() -> int:
    """Delete FLAC blobs not referenced by any sentence_audio row.
    Returns count deleted. Mirrors gc_orphan_audio. Same 10-minute
    grace window for in-flight writes."""
    if not is_enabled():
        return 0
    import time as _time

    referenced = set()
    with _conn_lock:
        for row in conn().execute(
            "SELECT DISTINCT audio_sha256 FROM sentence_audio"
        ):
            referenced.add(row["audio_sha256"])

    if not SENTENCE_DIR.exists():
        return 0
    now = _time.time()
    removed = 0
    for p in SENTENCE_DIR.glob("*.flac"):
        sha = p.stem
        if sha in referenced:
            continue
        try:
            if now - p.stat().st_mtime < 600:  # 10 min grace
                continue
            p.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def gc_orphan_audio() -> int:
    """Delete audio blobs not referenced by any clip row. Returns the
    count deleted. Safe to run periodically (nightly cron, etc.).
    Skips blobs newer than 10 minutes — covers the case where a
    storage just happened and the clip row hasn't been written yet
    (shouldn't normally happen but cheap to guard against)."""
    if not is_enabled():
        return 0
    import time as _time

    referenced = set()
    with _conn_lock:
        for row in conn().execute(
            "SELECT DISTINCT audio_sha256 FROM clips "
            "WHERE audio_sha256 IS NOT NULL AND deleted = 0"
        ):
            referenced.add(row["audio_sha256"])

    now = _time.time()
    removed = 0
    for p in AUDIO_DIR.glob("*.mp3"):
        sha = p.stem
        if sha in referenced:
            continue
        try:
            if now - p.stat().st_mtime < 600:  # 10 min grace
                continue
            p.unlink()
            removed += 1
        except OSError:
            pass
    return removed


# ──────────────────────────────────────────────────────────────────────
# Small JSON helpers for the *_json columns.
# ──────────────────────────────────────────────────────────────────────


def jsdump(value) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def jsload(s: str | None):
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None
