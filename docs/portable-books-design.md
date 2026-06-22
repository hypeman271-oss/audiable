# Portable books — author-authored animations that reach every reader

**Vision (the product goal).** An author designs a book — text, narration,
cover, images, and *animations* (full-page scenes, per-sentence sprites,
badges, emphasis). Anyone on the **free consumer app** can then open that book
and experience it **exactly as the author intended**, on their own device.

Today that doesn't happen for animations. This doc specs the path, grounded in
the architecture that already exists.

---

## 1. Current reality (verified in code, 2026-06-22)

- **Clip sync** is `PUT /api/library/clips/:id` (`_syncPushClip`,
  static/app.js). Its payload carries: text, `kind`, voice, rate, offsets,
  `bookmarks`, `note(s)`, `tags`, **`cover`**, **`images`**, `annotations`,
  `lines`, and audio (as `audioSha256` when the server already has the blob,
  else base64). Covers + inline images therefore DO travel.
- **`animationCues` is NOT in the sync payload.** Cues live only on the local
  IndexedDB clip object. → On another device the clip arrives with zero
  animation cues.
- **Sheets (the images/sprite-sheets) live in a device-local IndexedDB store**
  (`anim_sheets`, key = `sheetId`). They are never uploaded. The cue references
  them by local `sheetId` only. (This separation was deliberate — it's the
  audio-hitch fix: multi-MB blobs must stay off the per-clip sync row.)
- **Sync is tenant-scoped** (your own devices, keyed by the bearer's sha256).
  There is no author→consumer / non-owner read path.
- **Audio is already content-addressed** on the server volume
  (`store_sentence_audio(bytes) -> sha256`, `SENTENCE_DIR`, with
  `gc_orphan_sentence_audio`). This is the exact pattern to mirror for sheets.

**Three gaps:** (a) cues don't sync, (b) sheets don't sync, (c) no distribution
to non-owners.

---

## 2. Phase 1 — make animations portable (foundation)

Goal: an author opening their own book on any of *their* devices sees the
animations. This is required no matter which distribution model we pick, and it
immediately fixes "my animations vanish on my other device."

**2a. Sync the cue metadata.** Add `animationCues` to the `_syncPushClip`
payload and to the server clip row (new `animation_cues_json` column + schema
bump), merged the same way `annotations_json` already is (last-writer-wins on
the row; cues are small). Cues carry: `kind`, `effect`, `startIdx`/`endIdx`,
`startLineId`/`endLineId`, `frames`, `fps`, `source`, and the asset reference
(below). No blobs here — just the small JSON.

**2b. Content-addressed sheet store on the server.** Mirror sentence-audio:
- `store_anim_sheet(bytes) -> sha256` writing to `DATA_DIR/anim_sheets/<sha>`,
  with a `gc_orphan_anim_sheet` pass (mirror `gc_orphan_sentence_audio`).
- `POST /api/library/anim-sheet` — body = the (already downscaled, ≤2048px)
  image bytes; returns `{ sha256 }`. Dedup: if the sha exists, no-op.
- `GET /api/library/anim-sheet/:sha` — returns the bytes (long-cache; content
  is immutable by hash).

**2c. Cue carries `sheetSha`.** Alongside the local `sheetId`, a cue gains a
`sheetSha` (the server content hash). On save (`_animSaveCueForSentence`):
after `putAnimSheet` (local) + downscale, also `POST /api/library/anim-sheet`
and stamp `cue.sheetSha`. The sha rides in the synced cue JSON (small). Keep the
local `sheetId`→blob cache so the authoring device never re-fetches.

**2d. Fetch-on-miss.** In `_animResolveSheetUrl` / `getAnimSheet`: if there's no
local blob for the cue but it has a `sheetSha`, `GET /api/library/anim-sheet/:sha`,
store the blob in the local `anim_sheets` cache (keyed by `sheetId` or the sha),
and render. So a device that received the cue via sync pulls the asset on demand,
once, then caches it. Audio-safe: still no IDB/decode on the hot path beyond the
first fetch, and never on the per-clip sync row.

**Covers + inline images** already sync (inline on the clip). Optionally move
them to the same content-addressed store later to shrink the sync row, but it's
not required for parity.

---

## 3. Phase 2 — distribution (author → consumer "as intended")

Phase 1 makes assets portable; Phase 2 is how a *non-owner* obtains the book.
This is the real product decision. All options sit on the Phase 1 foundation
(content-addressed assets + synced cues), so the choice is independent of the
build above.

- **A. Share link / published id.** Author "publishes" a clip → a read-only
  bundle (text + `audioSha256` + cover + `animationCues` + `sheetSha`s) becomes
  fetchable by anyone with the link, no tenant gate on the published GET. The
  consumer app fetches the bundle + pulls assets by sha. Simplest path to "send
  someone my book."
- **B. Consumer catalog/library.** Published books listed in a consumer-facing
  catalog the free app browses. Bigger surface; needs listing/discovery UI.
- **C. Export/import bundle.** A single downloadable file (e.g.
  `.narrativebook`) packing text + audio + cover + cues + sheets. Consumer
  imports it. Fully offline/portable, no server distribution needed; weakest for
  "just open it."

These compose — A is the natural first distribution step and B/C can follow.

---

## 4. Constraints + notes

- **Keep sheets off the per-clip sync row.** Upload via the separate
  `anim-sheet` endpoint, reference by sha. This preserves the audio-hitch fix
  (progress-save must never re-upload MBs).
- **Dedup is free** via content-addressing — the same sprite reused across
  books/sentences stores once.
- **Downscale first** (already shipped, ≤2048px) so uploaded assets are bounded.
- **Licensing:** author-uploaded art is the author's responsibility; we store +
  serve. (Bundled/first-party assets would need CC0 — out of scope here.)
- **Auth on GET:** Phase 1 GET stays tenant-scoped (your own devices). Phase 2's
  published GET is the only non-owner read path and must be explicitly opt-in
  per book (publish flag), never automatic.

---

## 4b. AS-BUILT — Phase 1 (v4.141, SHIPPED)

- **Schema v10** (`library_db.py`): `clips.animation_cues_json` column (mirrors
  `annotations_json`). Migration verified.
- **Content-addressed sheet store** (`library_db.py`): `store_anim_sheet(bytes)
  -> sha`, `anim_sheet_path(sha)` (path-traversal guarded), `ANIM_SHEET_DIR`.
- **Endpoints** (`library_api.py`): `POST /api/library/anim-sheet` (raw body →
  `{sha256}`, 8MB cap), `GET /api/library/anim-sheet/{sha}` (immutable cache).
- **Cue sync** (`library_api.py`): `ClipUpsert.animationCues: list|None`.
  None = downlevel/empty push → **preserve stored** (no wipe); explicit array
  (incl. `[]`) = authoritative whole-array LWW. Added to UPSERT + GET
  serialization.
- **Client** (`app.js`): `animationCues` added to `_syncPushClip` payload +
  applied in `_syncAbsorbServerClip`. `_animSaveCueForSentence` uploads the
  (downscaled) blob → `cue.sheetSha` (both fresh + edit-in-place + legacy
  migration). `_animEnsureSheetBlob` = local IDB → **fetch-on-miss by
  `sheetSha`** → cache; used by `_animResolveSheetUrl` + `_animPreloadSheets`,
  so every renderer (scene, sprite, book-view) resolves cross-device.

**Verified:** server round-trip via TestClient (upload/fetch/404, cue PUT/GET
with sheetSha, downlevel-preserve, explicit-`[]`-wipe) + live client round-trip
(save → upload → sheetSha persisted → delete local blob → fetch-on-miss
re-pulls + re-caches). Cross-tenant author→author (your own two devices) is the
user's two-device verification; needs library_db enabled (Fly).

## 4c. AS-BUILT — Phase 2 share-link distribution (v4.142, SHIPPED)

- **Schema v11** (`library_db.py`): `published_books(token PK, tenant_key,
  clip_id, bundle_json, created_at, revoked)` + `create/get/list/revoke`
  helpers. Snapshot-at-publish (stable link until re-publish).
- **Authed** (`library_api.py`): `POST /api/library/clips/{id}/publish`
  (snapshot text + audio sha + cover + animationCues w/ sheetSha → unguessable
  `secrets.token_urlsafe` token), `GET /api/library/published` (author list),
  `DELETE /api/library/published/{token}` (revoke, tenant-scoped).
- **Public** (`public_router`, `/api/published`, carved out of
  `require_api_key` in server.py): `GET /{token}` (bundle), `/{token}/audio.mp3`,
  `/{token}/sheet/{sha}`. **Asset reads validate `sha` is referenced by THIS
  token's bundle** — the public surface is bounded to exactly what the author
  published (no blob enumeration).
- **Client author** (`app.js`): `🔗 Share` button (in the reading-view actions
  row, shown only when sync is on + not a consumer) → `_shareCurrentClip`
  pushes the clip then POSTs publish, copies the `/?book=<token>` link.
- **Client consumer** (`app.js`): `?book=<token>` on load → `_openPublishedBook`
  fetches the bundle, pulls audio from the public endpoint, builds a local clip,
  loads it + opens book view with animations on. `_publishedBookToken` routes
  `_animEnsureSheetBlob` sheet fetches through the public `/sheet/{sha}` path
  (a consumer has no API key). SW v4.142.

**Verified:** TestClient (publish/read/audio/sheet, unreferenced-sha 404 gating,
revoke→404) + live preview end-to-end (author publishes → fresh consumer with
**wiped IndexedDB + no key** opens the share link → book + audio load + the
full-page scene fetches via the public endpoint and renders in book view).

**Follow-ups (not built):** consumer chrome polish (hide author-only UI in
reader mode), publish-management UI (list/revoke from Settings), re-publish
updates the same link, consumer catalog (Phase 2 option B).

## 5. Recommendation / phasing

1. **Build Phase 1 now** (2a→2d). It's required for every distribution model and
   independently fixes cross-device animations for the author. Verifiable on two
   tenant devices: author adds a scene on device A → opens the book on device B →
   cue syncs + sheet fetches + scene renders.
2. **Then pick a Phase 2 distribution model** (A recommended first).

Order within Phase 1: 2b (server store) → 2a+2c (cue sync + sheetSha on save) →
2d (fetch-on-miss) → verify on two devices. Bump SW; assets are immutable by
hash so they cache aggressively.
