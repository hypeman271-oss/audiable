# Cross-device library sync (Path B)

Scoping doc for v221.sync-1..7 + v221.tenants-1..5.

**Decisions locked in (user, 2026-05-31):**

- Rollout: **opt-in via Settings**. Off by default — flip on per device.
- Conflicts: **per-clip last-write-wins**. Whole clip record replaced
  on save. Simpler, predictable, accepts the rare "two-device
  simultaneous edit" loss.
- **Multi-tenant by key (reversal, same day).** Originally framed as
  single-tenant for V1.1 alpha → multi-user via Supabase for V1.0.
  The alpha gap is the blocker: testers handed one shared
  `NARRATIVE_KEY` would see + clobber each other's libraries the
  moment any of them flipped sync on. Fix is to partition every
  table by `tenant_key = sha256(bearer)`. No real auth — just an
  opaque per-tester key the admin mints by hand. Maps cleanly to
  Path C's per-user-id columns later. See "Multi-tenant" section
  below.

---

## Goal

> "Edit at desk → listen at gym."

Specifically, a single user with two+ devices (desktop + phone)
sharing one library: clips, metadata, audio. When the user re-narrates
a chapter on their desktop, the new audio is playable on their phone
without re-synthesizing.

## Out of scope (for V1.1)

- **Multi-user accounts.** Path C handles this with Supabase Auth.
  Path B is single-tenant — the existing `NARRATIVE_KEY` env var
  identifies "the user." If you give your key to someone, they see
  your library.
- **Real-time CRDT-style merge.** The hard correctness path. We're
  using per-clip LWW; if you bookmark on phone and edit notes on
  desktop in the same minute, the second save wins.
- **Mobile-native apps.** Still PWA. Phone reaches `narrative-alpha.fly.dev`
  via the browser.
- **Selective sync per-clip.** Either the device syncs or it doesn't;
  no per-clip toggles. Path C may revisit this.

---

## Architecture

```
       desktop browser              phone browser
       ┌──────────────┐             ┌──────────────┐
       │  IndexedDB   │             │  IndexedDB   │
       │ (read cache) │             │ (read cache) │
       └──────┬───────┘             └──────┬───────┘
              │ HTTPS (X-Narrative-Key)   │
              └──────────┬─────────────────┘
                         │
                    ┌────▼────────────────────┐
                    │  Fly machine             │
                    │  ┌───────────────────┐   │
                    │  │  FastAPI server   │   │
                    │  │  /api/library/*   │   │
                    │  └─────────┬─────────┘   │
                    │            │             │
                    │       ┌────▼─────┐       │
                    │       │ SQLite   │       │
                    │       │ /data/   │       │
                    │       │ narrative│       │
                    │       │ .db      │       │
                    │       └──────────┘       │
                    │       ┌──────────┐       │
                    │       │ /data/   │       │
                    │       │ audio/   │       │
                    │       │ *.mp3    │       │
                    │       └──────────┘       │
                    └──────────────────────────┘
                         (Fly volume, ~1-3 GB)
```

**Source of truth:** the server. IndexedDB is a read-through cache
that survives offline use but yields to the server on reconnect.

**Why server-as-source:** the alternative (multi-master replication)
needs CRDTs or strong vector clocks. Last-write-wins requires a single
linearization point — that's the server.

---

## Data model: what moves to server vs stays client-only

### Moves to server
- Clips (all metadata: id, title, text, voiceId, voiceName, rate,
  volume, speakerId, sentenceOffsetsSec, durationSec, progressSec,
  bookmarks, notes, note, tags, cover, gitRef, createdAt,
  lastSyncedAt, synthSilentSentenceCount, synthOk, images)
- Audio MP3 blob (stored as separate file, referenced by sha256)
- Library order
- Character roster + per-character colors
- Voice presets
- Settings that should be portable: theme, skip interval, book-view font/theme

### Stays client-only
- Active playback state (currentTime, A↔B markers, sleep timer)
- Voice favorites (per-device — your desk speakers ≠ phone earbuds)
- Last-tab UI state (which view is open, etc.)
- Debug log
- The NARRATIVE_KEY itself (already client-only)

---

## SQLite schema (sketch)

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);

CREATE TABLE clips (
  id INTEGER PRIMARY KEY,           -- client-assigned (Date.now() + rand)
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  voice_id TEXT,
  voice_name TEXT,
  rate INTEGER,
  volume REAL,
  speaker_id INTEGER,
  duration_sec REAL,
  progress_sec REAL DEFAULT 0,
  sentence_offsets_json TEXT,       -- JSON array
  bookmarks_json TEXT,              -- JSON array
  note TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  tags_json TEXT,                   -- JSON array
  cover_json TEXT,                  -- {blob_sha?, color?, ...}
  git_ref_json TEXT,                -- {repoUrl, branch, path, sha}
  audio_sha256 TEXT,                -- → /data/audio/<sha256>.mp3
  images_json TEXT,
  synth_ok INTEGER DEFAULT 1,
  synth_silent_sentence_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT NOT NULL,         -- ISO8601, the LWW comparator
  last_synced_at TEXT,              -- from existing field
  deleted INTEGER DEFAULT 0         -- soft delete so other devices can sync the removal
);

CREATE TABLE library_order (
  position INTEGER PRIMARY KEY,
  clip_id INTEGER NOT NULL REFERENCES clips(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,              -- client-assigned UUID-ish
  name TEXT NOT NULL,
  voice_id TEXT,
  speaker_id INTEGER,
  gender TEXT,
  color TEXT,
  updated_at TEXT NOT NULL,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT,
  voice_id TEXT,
  rate INTEGER,
  volume REAL,
  speaker_id INTEGER,
  updated_at TEXT NOT NULL,
  deleted INTEGER DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_clips_updated ON clips(updated_at);
CREATE INDEX idx_clips_deleted ON clips(deleted);
```

**Why `updated_at` is a TEXT ISO8601:** human-readable in logs, sorts
correctly, no clock-skew handling needed beyond "use the client's wall
clock at save time."

**Soft delete:** so device A deleting a clip while device B is offline
doesn't have B silently re-uploading it on reconnect. B sees
`deleted=1` and tombstones locally.

---

## Fly volume layout

```
/data/
  narrative.db              # SQLite — single file
  narrative.db-wal          # SQLite WAL
  narrative.db-shm          # SQLite shared memory
  audio/
    a3f8e1...mp3            # Keyed by sha256(audio_bytes)
    b29d44...mp3            # Identical re-narrates of same chapter dedup
    ...
```

**Volume size:** start with 3 GB. Audio at ~64 kbps MP3 averages
~480 KB/min. A 100-chapter novel ≈ 100 * 8 min ≈ 800 min ≈ ~400 MB.
3 GB covers an entire writing career.

**Volume cost:** Fly charges ~$0.15/GB/month → 3 GB = $0.45/mo.
Negligible.

**Audio dedup:** content-addressed by sha256. Same text + same voice
= same audio = same sha256 = single file. Re-narrating a chapter with
the same voice doesn't double the storage.

---

## API surface

All endpoints require `X-Narrative-Key` (single-tenant for V1.1).

### Listing + delta sync

```
GET /api/library/sync/state
→ {
    "clips": { "1780218004879": "2026-05-31T16:42:01Z", ... },
    "library_order_updated_at": "2026-05-31T16:42:01Z",
    "characters_updated_at": "2026-05-31T16:42:01Z",
    "presets_updated_at": "2026-05-31T16:42:01Z",
    "server_now": "2026-05-31T17:00:00Z"
  }
```

Client compares against its local cache. For any clip whose
`updated_at` is newer on server than local, fetch via GET below.
For any clip in local but not server (and locally `deleted=0`),
PUT it.

### Per-clip CRUD

```
GET /api/library/clips
→ { clips: [{id, title, updated_at, ...summary fields...}, ...] }

GET /api/library/clips/{id}
→ { clip: {...full fields..., audio_url: "/api/library/audio/<sha>.mp3"} }

PUT /api/library/clips/{id}
  body: { clip: {...all fields including bookmarks, tags...},
          audio_b64?: "..." }
  → { ok: true, updated_at: "..." }
  Note: audio_b64 is optional. If provided, server stores it under
  /data/audio/<sha256>.mp3 and sets clip.audio_sha256.

DELETE /api/library/clips/{id}
  → { ok: true }  // soft delete; clip.deleted=1, updated_at bumps
```

### Audio stream

```
GET /api/library/audio/{sha256}.mp3
→ binary MP3, Content-Type: audio/mpeg
  Cache-Control: public, max-age=31536000, immutable
  (Immutable because the URL is content-addressed.)
```

### Library order

```
GET  /api/library/order
PUT  /api/library/order  body: { order: [clip_id, clip_id, ...] }
```

### Characters + presets + settings

Mirror clip patterns. Same updated_at LWW.

### Bulk endpoints (optional optimization)

```
POST /api/library/bulk-pull   body: { clip_ids: [...] }
→ { clips: [...] }   // saves N round trips on first sync
```

---

## Rollout: opt-in via Settings

A new toggle in Settings → App:

> **Sync library across devices**
> Stores your library on the Narrative server so you can edit on
> your desktop and listen on your phone. Off by default.

When flipped **off → on**:
1. Show a confirm dialog: "This will upload your N clips (~XX MB)
   to narrative-alpha.fly.dev. Continue?"
2. If confirmed, run migration: iterate local clips, PUT each one
   with its audio blob. Progress modal shows N/M complete.
3. After migration, mark `localStorage.narrative.syncEnabled = "1"`.
4. From now on, every save also pushes to server.

When flipped **on → off**:
1. Confirm: "Your library will stay on this device. Clips will not
   sync to your other devices anymore. The server copy remains.
   Continue?"
2. Set the flag off. Client stops pushing/pulling.
3. Server data is untouched — flipping back on resumes sync without
   re-migration.

**Per-device flag** (not a server setting). Means you can have sync
on at home, off at work — same key, different sync policy per
browser.

---

## Conflict resolution: per-clip LWW

Every PUT carries `clip.updated_at` (client wall-clock at save time).
Server compares to its stored row:

- `client.updated_at > server.updated_at` → accept, overwrite, return new state
- `client.updated_at < server.updated_at` → server returns 409 with
  the current server clip in the body; client reconciles by accepting
  the server version, dropping its in-flight local edit (LWW says
  "the more recent change wins"), and surfacing a quiet status:
  *"Library was updated on another device; using the latest."*
- `client.updated_at == server.updated_at` → idempotent (treat as
  accept, since the payload is presumably identical).

**Trade-off:** if you bookmark on the phone and edit notes on the
desktop in the same minute, one of those edits is lost. We accept
this for V1.1 because (a) it's rare in practice, (b) the alternative
(per-field timestamps) is ~1 extra day of code + state to debug.

**Bookmarks specifically** still get the whole-clip treatment. A
bookmark add on device A while device B has a stale clip → if B saves
the clip next (even just for a progress update), A's bookmark could
get clobbered. Mitigation: the sync adapter PULLs before every save
when online, so the window is small.

---

## Offline behavior

- Sync OFF → totally local, no network calls. Unchanged from v220.
- Sync ON, online → every save is "save local + debounced server push."
- Sync ON, offline → saves go to a pending queue (IndexedDB table).
  Status line: *"Offline — N changes queued."* On reconnect, flush
  queue in order. Conflicts handled per the rule above.
- Sync ON, online, but server returns 5xx → treat as offline,
  queue the write, retry with backoff.

Audio specifically: when offline AND the clip's audio blob isn't
already cached locally, the play button shows *"Audio not downloaded
— connect to play."* Once cached after the first play, plays offline
forever.

---

## Migration path for existing local libraries

Triggered by the opt-in flip. Flow:

1. Client lists local clips via existing `listClips()`.
2. For each clip:
   - Encode audio Blob to base64 (one at a time so memory doesn't spike).
   - PUT /api/library/clips/{id} with full payload + audio_b64.
3. Surface progress: *"Syncing library — 12/47 clips uploaded."*
4. On any per-clip failure, log to debug log + skip (don't abort the
   whole migration). Failed clips can retry on next save.
5. After all clips, PUT /api/library/order and /api/library/characters
   and /api/library/presets.
6. Set the sync-enabled flag. Done.

Total time for a 50-clip / 200 MB library on home wifi: ~2-3 minutes.

---

## Open questions / risks

- **NARRATIVE_KEY rotation.** Right now the key is set as a Fly env
  var; rotating it disconnects every client. For sync, we'd want
  multiple keys (a "device tokens" concept) so revoking one phone
  doesn't lock out the desktop. **Decision: defer to Path C** —
  it's a multi-tenant concern that goes with auth.
- **SQLite WAL on a Fly volume.** Fine in practice (Fly volumes are
  fully POSIX). Set `PRAGMA journal_mode=WAL` for concurrent reads.
- **Backup.** None initially. A user nuking their NARRATIVE_KEY
  (or the Fly volume getting wiped) loses everything. Worth a
  weekly automated export to S3 or similar before V1 ship — file
  as a follow-up task.
- **Audio blob orphans.** A re-narrate replaces `clip.audio_sha256`,
  the old sha256 may now have zero references. Garbage-collect via
  a periodic sweep: `SELECT DISTINCT audio_sha256 FROM clips` minus
  the files in `/data/audio/` → unlink unreferenced. Cheap to run
  nightly.
- **Confidentiality.** Audio + text are now stored server-side
  unencrypted. For the indie-author audience this matters; the
  privacy line on the landing page ("Your draft never leaves your
  machine") was for the V1 desktop pitch, not the V1.1 cloud-sync
  alpha. **Update the landing page copy when this ships** — task
  to add to #406.

---

## Sequencing

Tasks #426 through #431 in order. Each is independently testable.
Total estimated time: 4-5 days of focused work, minus interruptions.

---

## Multi-tenant (v221.tenants-1..5, 2026-05-31)

### Why this section exists

Path B as originally specced was single-tenant by NARRATIVE_KEY. That
works for "one human with multiple devices" but FAILS for "alpha tester
group sharing one key" — every tester sees every other tester's
library the moment they enable sync.

We add a tenant column to every live table. Same bearer = same
tenant (the `sha256(bearer)` is deterministic, no separate signup).
Different bearers = isolated libraries. The admin still has special
status because they hold the env-var key.

### What gets a tenant column

Live data tables — **clips, library_order, characters, presets,
settings**. The schema_version table is global (server-side
infrastructure). The audio blob directory stays flat (content-
addressed: identical bytes → identical sha → single file). The
orphan GC already does `SELECT DISTINCT audio_sha256 FROM clips` —
that union across tenants is what we want.

`/data/maintenance.json` stays global — maintenance applies to the
whole server, not a specific tenant.

### How the bearer resolves

```
X-Narrative-Key: <bearer>
    │
    ▼
middleware reads bearer
    │
    ├─ matches env NARRATIVE_KEY  →  admin tenant
    ├─ matches an entry in /data/tenants.json  →  that tenant
    └─ otherwise  →  401
    │
    ▼
tenant_key = sha256(bearer)
    │
    ▼
attached to request.state.tenant_key
    │
    ▼
every library API query: WHERE tenant_key = ?
```

The bearer itself is never written to the DB. The sha256 is the
column; the original string lives only in the env var or
`/data/tenants.json` (which is admin-readable, not user-readable).

### /data/tenants.json schema

```json
{
  "tenants": [
    {
      "label": "alpha tester: alice",
      "key": "narrative-x7k2-9m4p-3rq8-b2nt",
      "tenant_key": "<sha256 of key>",
      "created_at": "2026-05-31T18:00:00Z",
      "last_seen_at": "2026-05-31T18:05:00Z"
    },
    ...
  ]
}
```

The `key` is the raw bearer. Stored once at creation so the admin can
look it up if needed, BUT the admin UI never re-emits it after the
initial display (the create dialog says "Copy this now — it can't be
shown again" and refuses on a second open). After that, only the
`tenant_key` is visible in the admin list, plus the label.

### Admin tenant management endpoints

```
POST   /api/admin/tenants       body: {label}
       → 201 {key, tenant_key, label, created_at}
       (key visible once; admin must capture it on this response)

GET    /api/admin/tenants
       → {tenants: [{label, tenant_key, created_at, last_seen_at}, ...]}
       (keys never re-emitted)

DELETE /api/admin/tenants/{tenant_key}
       → 200 {ok: true}
       (revokes; existing rows under that tenant stay in DB but
        become unreachable. GC can later sweep if we add a
        `purge_tenant` endpoint. For now we leak the data —
        cheap and reversible.)
```

All three require the admin tenant (sha256(NARRATIVE_KEY env var)).
A tester key never sees these endpoints.

### Schema migration v1 → v2

The migration runs idempotently at boot:

1. `ALTER TABLE clips ADD COLUMN tenant_key TEXT NOT NULL DEFAULT '<admin-sha>'`
   — same on library_order, characters, presets, settings.
2. Backfill: existing rows (where `tenant_key` is still the default)
   get the admin tenant. This was the pre-multi-tenant data — it's
   all yours.
3. Add `CREATE INDEX IF NOT EXISTS idx_clips_tenant ON clips(tenant_key)` —
   every query touches this column.
4. Bump `schema_version` to 2.

Roll-back path: schema v2 reads fine in a v1 server (the column is
just ignored), so a partial rollout doesn't corrupt anything. We
keep migrations additive forever.

### Failure modes worth flagging

- **Two testers use the same key**: they'd still merge. The key IS
  the tenant identifier. Solution is "give each tester their own key"
  — this is operationally up to the admin.
- **Tester loses their key**: lost their library, since the bearer is
  the only auth. Admin can mint a new one, but the old library
  remains under the old tenant_key and is unreachable from the new
  one. Acceptable for alpha; pre-launch we'd add an export-by-old-
  key flow.
- **Admin key rotation**: if the env var changes, every existing row
  is suddenly orphaned (the admin tenant_key changes). Fix: don't
  rotate the env var. If you must, run a one-time SQL update mapping
  old admin sha → new admin sha across all tables.

### What's still deferred to Path C

- Real user accounts (email + magic link).
- Self-service signup.
- License key validation tied to identity.
- Multi-key-per-user (mobile + desktop with shared identity).
- Backup + per-user export.

All of those become a per-`user_id` column where v221.tenants put a
per-`tenant_key` column. Mechanical refactor, not architectural.
