# Narrative — State & Data-Flow Audit (v225v4.17)

Companion to `ARCHITECTURE.md`. Where ARCHITECTURE answers *"what
lives where and why"*, this doc answers *"what data lives in storage,
who reads it, who writes it, and what's gone stale."*

This is the **storage-side** cousin of the dead-code audit
(`dead-code-audit-v4.17.md`). Both feed cleanup work: dead-code finds
unreferenced functions; this finds unreferenced storage keys, orphan
flags, and doc-vs-code drift.

When code disagrees with this doc, **the code wins.** Bump this doc.

---

## 0. Storage surfaces — at a glance

| Surface | Lifetime | Sync? | What lives here |
|---------|----------|-------|-----------------|
| **IndexedDB** `audiable` v1, store `clips` | per device, persistent | mirrored to server when opt-in sync on | The clip corpus — audio, text, sentences, bookmarks, annotations, voice provenance, cover. |
| **localStorage** | per device, persistent | only `narrative.presets` (server-side sync, #674) | User prefs, feature flags, one-shot UI hints, GitHub tokens, voice favorites, sync state. |
| **sessionStorage** | per tab, ephemeral | no | One key only: `narrative.maintenanceDismissed`. |
| **Module-scope globals** (`app.js`) | per page-load | no | In-flight playback, current clip pointer, dialog state, drag state, debug log buffer. |
| **Server SQLite** (`/data/library.db`) | persistent, tenant-scoped | source of truth when sync on | See `library_db.py` + ARCHITECTURE §4. |
| **SW cache** `narrative-shell-v<X>` | rolled on every release | no | Shell + manual + landing assets. Bumps invalidate. |

---

## 1. IndexedDB

### Database

| Property | Value | Defined at |
|----------|-------|------------|
| `DB_NAME` | `"audiable"` | `app.js:20179` |
| `DB_VERSION` | `1` | `app.js:20180` |
| `STORE` | `"clips"` | `app.js:20181` |
| `keyPath` | `"id"` | `app.js:20189` |

> ⚠️ **DOC DRIFT — fix in ARCHITECTURE.md.** ARCHITECTURE §4
> describes the IndexedDB database as `narrative-db`. The actual
> name is `audiable` — a historical leftover from when the app was
> called Audiable. The schema "narrative-db" string in ARCHITECTURE
> would not open the real database; the doc reads as if there are
> separate `clips` / `libraryOrder` / `preferences` / `voicePresets`
> object stores. **There is one object store: `clips`.** Everything
> else lives in localStorage.

### Object store: `clips`

Single store. Every entry is a Clip record keyed by string `id`.

Clip shape (compiled from the saveClip mutators and Edit dialog):

```
{
  id: string,
  title: string,
  text: string,

  // Audio
  audioBlob: Blob | null,        // combined WAV/MP3 after synth
  voice: string,                 // voice id, e.g. "piper:..."
  speakerId: number | null,      // multi-speaker engines
  rate: number | null,
  volume: number | null,

  // Sentence-level
  sentences: string[],           // pre-split sentence strings
  sentenceOffsetsSec: number[],  // playback offset per sentence
  sentenceVoices?: {idx → voice} // per-sentence overrides (#388)
  highlights?: Highlight[],      // M7.1 text highlights

  // Reading-progress
  progressSec: number,
  bookmarks: Bookmark[],         // {timeSec, label, note?, sentenceIdx?}
  annotations: Annotation[],     // {sentenceIdx, tags[], voiceNote?, transcript?}

  // Author surfaces
  notes: string,                 // free-form per-clip notes
  tags: string[],                // clip-level tags (#249)
  cover?: {url, w, h} | string,  // cover image (auto-detect or upload)
  chapterImages?: ChapterImg[],  // per-chapter leading images (#678)

  // Import provenance
  source?: "url" | "epub" | "pdf" | ... ,
  gitRef?: {repo, branch, path, sha},   // GitHub-imported clips
  scrivenerDoc?: string,
  obsidianNote?: string,

  // Sync metadata
  syncedAt?: number,             // ms epoch — last server confirmation
  updatedAt?: number,            // local mtime

  // Provenance for re-narrate
  voiceProvenance?: {            // #353 — multi-voice license tracking
    id, speaker, license, attribution
  },

  // Type flag
  kind?: "audio" | "ebook",      // #690 — ebook = no audio
}
```

> ⚠️ **Schema versioning gap.** `DB_VERSION = 1` from day one. Every
> field above has been added by mutating clip objects in place —
> there is no migration ladder. New clips have new fields; old clips
> don't. Read paths must always handle both shapes. If we ever
> need to drop a field cleanly, we will need to bump `DB_VERSION`
> and write the first IDB migration. See `onupgradeneeded` at
> `app.js:20188`.

### Transaction sites

11 places open IDB transactions. Most go through `saveClip` (which
itself is atomic since #488). Direct transaction openers:

| Line | Purpose |
|------|---------|
| 7476 | Clip lookup during synth — get current clip for re-narrate |
| 15761 | Bookmark mutators (add) |
| 15852 | Bookmark mutators (delete) |
| 15905 | Bookmark mutators (update note) |
| 17321 | Voice-note annotation save |
| 20185 | `indexedDB.open(DB_NAME, DB_VERSION)` — single opener |
| 20229 | DB helper — read clip by id |
| 20270 | DB helper — `saveClip` (atomic put) |
| 20281 | DB helper — `getAllClips` |
| 20295 | DB helper — `getClip(id)` |
| 20300 | DB helper — `deleteClip(id)` |
| 20819 | Sync absorb — server → IDB |
| 21508 | Library order mutator |
| 30903 | "Clear all clips" — Settings nuke (`store.clear()`) |

**Invariant:** new mutating callsites should use `saveClip(id, mut)`
not `getClip → mutate → put`. See ARCHITECTURE §8 "Atomic clip saves".

---

## 2. localStorage

### 2.1 Inventory by subsystem

Each row shows the **const name** in `app.js` and the **storage key
string** the browser sees. Lifecycle column says when it's read /
written / cleared.

#### Identity & API

| Const | Key | Lifecycle | Notes |
|-------|-----|-----------|-------|
| `API_KEY_STORAGE` | `narrative.apiKey` | read on boot (`getApiKey`); write on Settings → Switch key | The X-Narrative-Key bearer. Cleared by "Switch key" button (#505). |
| `GITHUB_TOKEN_KEY` | `narrative.githubToken` | read in GitHub picker; write on Settings → GitHub PAT save | Optional — OAuth path (#298) is the recommended alt. |

#### Theme & UI mode

| Const | Key | Lifecycle | Notes |
|-------|-----|-----------|-------|
| `THEME_KEY` | `narrative.theme` | read pre-paint in `<head>`; write on Settings → Theme radio | values: `"auto"`, `"dark"`, `"light"`. Pre-paint to avoid FOUC. |
| `UI_MODE_KEY` | `narrative.uiMode` | read on boot; write on Settings → Mode radio | values: `"simple"`, `"standard"`, `"author"`. |
| `LEGACY_AUTHOR_MODE_KEY` | `narrative.authorMode` | **migration-only** — read once on boot, then removed | ⚠️ **ORPHAN candidate.** Migration shipped in #203 (v76). Every active user has migrated by now. Safe to delete the read+removeItem branch at `app.js:1362–1370`. |

#### Playback

| Const | Key | Lifecycle | Notes |
|-------|-----|-----------|-------|
| `SPEED_STORAGE_KEY` | `narrative.playbackRate` | read on boot; write on speed-chip cycle | float, one of `SPEEDS`. |
| `REPEAT_STORAGE_KEY` | `narrative.repeatMode` | read on boot; write on Repeat chip cycle | `"off"` / `"one"` / `"all"`. |
| `SKIP_INTERVAL_KEY` | `narrative.skipInterval` | read on boot; write on Settings → skip radio | int seconds. |
| `STATS_KEY` | `narrative.stats` | read on boot; write on tick + on visibility hide | Listening-time accumulator. |
| `narrative.keepScreenOnDuringPlayback` | (raw string, no const) | read at `app.js:12606` — wake-lock gate | Write site: Settings checkbox. Not wrapped in a const — single-callsite read. |
| `narrative.paragraphPauseSec` | (raw string, no const) | read on boot + Settings; write on radio | Inter-paragraph silence in synth. |

#### Voices

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `SPEAKER_STORAGE_KEY` | `narrative.speakerByVoice` | per-voice last-used speaker id |
| `VOICE_FAVORITES_KEY` | `narrative.voiceFavorites` | starred voice IDs (#147) |
| `SPEAKER_FAVS_KEY` | `narrative.speakerFavorites` | per-voice starred speaker indices (#187) |
| `PRESETS_STORAGE_KEY` | `narrative.presets` | voice + speaker + rate presets. **Also synced to server (#674) — only synced localStorage key.** |
| `CHARACTERS_STORAGE_KEY` | `narrative.characters` | character roster for multi-voice (#113) |

#### Library

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `PLAY_MODE_KEY` | `narrative.playMode` | sort: `newest` / `oldest` / `longest` / `shortest` / `custom` / `shuffle` |
| `LIBRARY_ORDER_KEY` | `narrative.libraryOrder` | drag-defined clip-id order |
| `HIDE_PLAYED_KEY` | `narrative.hidePlayed` | bool — "Hide played" filter (#109) |
| `LIBRARY_ACTIVE_KIND_KEY` | `narrative.libraryActiveKind` | `"audio"` \| `"ebook"` — tabbed library (#792) |

#### GitHub import

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `LAST_GITHUB_REPO_KEY` | `narrative.lastGithubRepo` | ⚠️ **LEGACY** — `// legacy (single)` per source comment (`app.js:8021`). Superseded by recent-repos. Read at boot in a one-shot seed (`app.js:8041`) to populate `RECENT_GITHUB_REPOS_KEY` for upgrading users. **Safe to delete after a couple of versions.** |
| `RECENT_GITHUB_REPOS_KEY` | `narrative.recentGithubRepos` | last 3-5 repos (#290). Active. |

#### Sync

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `SYNC_ENABLED_KEY` | `narrative.syncEnabled` | per-device opt-in flag (Settings → App) |
| `SYNC_LAST_PULL_KEY` | `narrative.syncLastPullAt` | ms epoch of last pull — passed as `?since=` |
| `SYNC_MIGRATED_KEY` | `narrative.syncMigratedAt` | ISO date — set after first migration push |
| `SYNC_KIND_BACKFILL_KEY` | `narrative.syncKindBackfilledAtV2` | one-shot backfill flag for clip.kind sync (#786) |

#### Book view feature flags

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `BOOK_FONT_SIZE_KEY` | `bookFontSize` | ⚠️ **un-namespaced** (no `narrative.` prefix). Read/write at `app.js:19865`. |
| `BOOK_THEME_KEY` | `bookTheme` | ⚠️ **un-namespaced**. Read/write at `app.js:19891`. |
| (raw) | `bookViewV2` | ⚠️ **DEAD FLAG** — V2 paginator was abandoned (#733, #743). The read at `app.js:18152` still gates a code path that no current user hits, but the V2 code itself is pending delete in #743. **Delete both together.** |
| (raw) | `bookViewV3` | feature kill switch — `?bookviewv3=0` opts out. V3 is the default since v225v3.10. Will become obsolete once V1/V2 are deleted (#748, #743). |
| (raw) | `narrative.bookFlipDisabled` | reduced-motion opt-out for page-flip animation. Read once at `app.js:18051`. |

#### One-shot hints / tour state

These exist to render a hint or banner exactly once, then go quiet
forever. Most are managed by `_resetHints()` at `app.js:5258`, which
sweeps `_ONBOARDING_HINT_KEYS` to "Replay onboarding tips."

| Const / Key | Surface |
|-------------|---------|
| `WHATS_NEW_KEY` = `narrative.lastSeenWhatsNew` | NEW badge tracking on whats-new link |
| `_INSTALL_DISMISSED_KEY` = `narrative.installDismissed` | PWA install prompt |
| `_EMPTY_STATE_DISMISSED_KEY` = `narrative.dismissedEmptyState` | "Start a new clip" helper (#405) |
| `MANUAL_FIRST_OPEN_KEY` = `narrative.hintSeen.manualFirstOpen` | first-time manual nudge |
| `HELP_ATTENTION_KEY` = `narrative.helpAttentionSeen` | ? + ⚙ pulse animation (#367) |
| `SPEAKER_AUDITION_TIP_DISMISSED_KEY` = `narrative.speakerAuditionTipDismissed` | speaker-audition hint |
| `SPEAKER_AUDITION_TIP_USED_KEY` = `narrative.speakerAuditionTipUsed` | speaker-audition hint (separate "used" gate) |
| `FIRST_CLIP_TOUR_KEY` = `narrative.firstClipTourSeen` | first-clip tour gate |
| `FIRST_CLIP_CONFETTI_KEY` = `narrative.firstClipConfettiSeen` | one-shot confetti gate |
| `DRAG_HINT_KEY` = `narrative.dragHintDismissed` | drag-handle hint (#270) |
| `VOICE_FAV_TIP_KEY` = `narrative.voiceFavTipDismissed` | voice star hint |
| `VOICE_COMM_TIP_KEY` = `narrative.voiceCommercialTipDismissed` | commercial filter hint (#356) |
| `_TAGROW_HINT_KEY` = `narrative.hintSeen.tagRow` | phone tag-row first-tap hint (#533) |
| `narrative.annotateMode` | persists annotate-on-tap state across sessions (skipped on phone since #551) |

#### Offline draft queues

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `_OFFLINE_PENDING_SYNTH_KEY` | `narrative.pendingSynth` | drafts queued offline (#567 Tier 1) |
| `_OFFLINE_PENDING_TRANSCRIBE_KEY` | `narrative.pendingTranscribe` | voice-note transcripts queued offline (#569 Tier 2) |

#### Author UX

| Const | Key | Lifecycle |
|-------|-----|-----------|
| `_CLEAR_MARKS_EXPORT_PREF_KEY` | `narrative.clearMarks.exportFirst` | confirm-modal checkbox state (#670) |
| `_STORE_BY_LINES_KEY` | `narrative.storeByLines.default` | per-sentence storage opt-in default (#814) |

#### Tutorials & tour engine

| Const | Key | Lifecycle | Notes |
|-------|-----|-----------|-------|
| `TUT_KEY` | `narrative.tutorialLog` | rolling 50-entry breadcrumb log written by `tutorials.js:42–46` and consumed by debug-log push | App-side sweep at `app.js:78–88` reads + removes after capture. |
| (templated) | `narrative.tour.${id}.seen` | written by `overlay-tour.js:406`, read at line 427 | one key per tour id — `narrative.tour.firstTour.seen` etc. **No central list of tour ids exists.** |

#### Computed / templated keys

| Helper | Pattern | Use |
|--------|---------|-----|
| `_PANE_HIDDEN_KEY(name)` | `narrative.paneHidden.<name>` | per-pane hide toggle on desktop (#685) |
| `KEY(p)` | `narrative.paneWidth.<p>` | per-pane drag-resize widths (`app.js:3515`) — double-click reset clears the key. |

---

### 2.2 Read/write/clear callsites

Most keys are written by single callsites and read at boot + on Settings change.
A few callsites that wipe broadly:

| Callsite | Behavior |
|----------|----------|
| `_resetHints()` @ `app.js:5258` | Loops `_ONBOARDING_HINT_KEYS`, removes each. Used by "Replay onboarding tips" in Settings. |
| "Switch key" @ Settings (#505) | Clears `narrative.apiKey` + the library + reloads. Triggers an IndexedDB nuke. |
| "Clear all clips" @ `app.js:30903` | `store.clear()` on the `clips` store. Does NOT touch localStorage. |
| SW `activate` @ `sw.js:40–49` | Deletes old caches by name; does NOT touch IndexedDB or localStorage. |
| `_ONBOARDING_HINT_KEYS` @ `app.js:5227` | The canonical list of one-shot hint keys — keep this in sync when adding a new hint. |

---

## 3. sessionStorage

Used in exactly one place:

| Key | Read at | Purpose |
|-----|---------|---------|
| `narrative.maintenanceDismissed` | `app.js:1570` | "Service maintenance" banner — dismiss persists across tab-life only, reappears in new tabs. |

This is intentional — the banner should reappear if the user closes
and reopens the tab during the maintenance window.

---

## 4. Module-scope globals (`app.js`)

The "current world" for an open tab. None of these survive a reload —
all are rebuilt from IndexedDB + localStorage + the `<audio>` element.

### Identity & playback

| Variable | Type | Role |
|----------|------|------|
| `_currentClipId` | string \| null | The loaded clip. `null` = no clip open. |
| `_currentClipKind` | `"audio"` \| `"ebook"` \| null | Mirrors `clip.kind` for the loaded clip. Also exposed on `window`. |
| `_currentPlayingVoiceId` | string | Voice the current `<audio>` was synthesized with. Used to detect re-narrate triggers. |
| `_currentPlayingRate` / `_currentPlayingVolume` / `_currentPlayingSpeakerId` | number | Same idea for other synth params. |
| `_playbackRate` | number | Current player rate. Initialized from `SPEED_STORAGE_KEY`. |
| `_repeatMode` | `"off"`\|`"one"`\|`"all"` | Active repeat mode. Initialized from `REPEAT_STORAGE_KEY`. |
| `_skipInterval` | number | Skip-back interval (s). Initialized from `SKIP_INTERVAL_KEY`. |

### Reading view & sentences

| Variable | Type | Role |
|----------|------|------|
| `sentenceOffsetsSec` | number[] | per-sentence audio start offset for the current clip |
| `sentenceSpans` | Element[] | reading-view `<span class="sentence">` array |
| `activeSentenceIdx` / `_selectedSentenceIdx` | int | active during playback / selected by drag-tap |
| `_currentClipAssignments` | {idx → voice} | per-sentence voice assignments (#388), dirty flag tracked separately |

### Synth / queue state

| Variable | Type | Role |
|----------|------|------|
| `_synthController` | AbortController | live SSE synth job; aborted on Clear / page hide |
| `_streamQueue` / `_streamPlayhead` / `_streamElapsed` | array + ints | per-sentence WAV stream during synthesis |
| `_chapterQueue` / `_chapterTotalCount` / `_chapterCurrentIndex` | array + ints | multi-chapter import queue (#138 family) |
| `_silentChapterQueue` | bool | background-mode toggle for queue (#265) |
| `_queueAudioComplete` / `_queueSaveComplete` | bool | chapter-queue advance gate flags (#225 fix) |
| `_autoAdvanceTimer` / `_queueAdvanceTimer` | timer | scheduled advances; cleared on stop |

### Sleep timer & A↔B loop

| Variable | Type | Role |
|----------|------|------|
| `_sleepIdx` / `_sleepExpiryMs` / `_sleepTickHandle` / `_sleepFadeHandle` / `_sleepFadeStartVol` / `_sleepEndOfChapter` | mixed | sleep timer state machine |
| `_loopA` / `_loopB` | number \| null | A↔B loop endpoints (#110, #383) |

### Library

| Variable | Type | Role |
|----------|------|------|
| `_libraryHasClips` | bool | hero empty-state gate |
| `_outdatedClipIds` | `Set<string>` | clips whose GitHub source diverged — drives ↻ banner |
| `_libraryTagFilter` | `Set<string>` | active tag-filter chips (#250) |
| `_renarrateDismissedClipId` | string \| null | suppresses banner after explicit dismiss |
| `_regenTargetClipId` / `_regenResumeAtSec` / `_regenSuppressStreaming` | mixed | partial re-narrate / re-narrate paths |
| `_libraryRenarrateNoAutoPlay` | bool | silent re-narrate gate (#384) |

### Dialogs & UI

| Variable | Type | Role |
|----------|------|------|
| `_notesEditingClipId` | string \| null | Notes dialog target |
| `_assignmentDialog` / `_assignSelectedIndices` / `_assignSelectBar` / `_dragState` | mixed | per-sentence voice assignment UI |
| `_pendingAssignmentsBanner` | element \| null | persistent banner element (#393) |
| `_pendingImages` / `_pendingDetectedCover` / `_pendingChapterImages` | mixed | import preview state |
| `_pendingEbookMode` | bool | ebook-mode flag during import |
| `_pendingGitRef` | object \| null | GitHub source info during import |
| `_ebookPreviewSnapshot` | object \| null | restore-on-close snapshot (#738) |
| `_externallyPaused` / `_suppressNextPauseFlag` | bool | pause-source disambiguation for annotate / voice-note guards |
| `_suppressNextSentenceClick` | bool | drag-vs-tap guard (#392 family) |

### Voice flow

| Variable | Type | Role |
|----------|------|------|
| `_voicesLoadFailed` / `_voicesRetryTimer` | bool + timer | catalog fetch retry |
| `_voicePreviewNowActive` / `_voicePreviewNowBlobUrl` | bool + string | "play preview" state |
| `_speakerPreviewActive` | bool | speaker preview gate |
| `_wizardPage` / `_wizardStarredOnly` / `_wizardActiveBtn` / `_wizardVoiceId` / `_wizardSpeakerCount` | mixed | Speaker wizard state |

### Bookmarks

| Variable | Type | Role |
|----------|------|------|
| `_lastBookmarkAddMs` | int | debounce duplicate-add (#547) |
| `_bookmarkEditorBound` / `_bookmarkEditorCurrentId` / `_bookmarkEditorIsNew` | mixed | centered editor state (#546) |

### Maintenance / admin

| Variable | Type | Role |
|----------|------|------|
| `_maintenanceCurrent` / `_maintenanceTickTimer` | object + timer | maintenance banner (#434) |
| `_whoamiCache` | object \| null | bearer → role lookup cache |

### GitHub OAuth

| Variable | Type | Role |
|----------|------|------|
| `_githubOAuthStatusCache` | object \| null | "have we signed in" cache |
| `_githubOAuthInflightUser` | promise \| null | fetch dedupe |
| `_githubOAuthLastTokenChecked` | string | skip duplicate /user calls |

### Phone-specific

| Variable | Type | Role |
|----------|------|------|
| `_phoneManualLoaded` / `_phoneManualSections` / `_phoneManualPendingAnchor` | mixed | phone manual viewer (#526) |

### Stats & debug

| Variable | Type | Role |
|----------|------|------|
| `_stats` / `_statsDirty` / `_lastListenTime` | mixed | listening-time accumulator |
| `_bgArtUrl` | string \| null | clip-card swatch URL |
| `_DEBUG_LOG_CAP` / `_debugLog` | int + array | in-memory ring buffer for `_dlog` |

### `window.*` exposure

For HTML `onclick=` attrs and tutorial-engine reach-ins:

- `window._paintImportPreview` — `app.js:550`
- `window._coverImgSrc` — `app.js:588`
- `window._currentClipKind` + `window._setCurrentClipKind` — `app.js:620, 634`
- `window._ebookPreviewSnapshot` — `app.js:645`
- `window._openAsEbook` / `window._updateOpenAsEbookEnabled` — `app.js:845, 856`

If we ever do a global-namespace cleanup pass, these are the
unavoidable few. Everything else stays inside the IIFE.

---

## 5. Server SQLite (pointer only)

Source of truth: `library_db.py` + ARCHITECTURE §4.

Quick reminders for the storage-side reader:

- Schema is at **v3** (annotations migration).
- Migrations are append-only; the ladder lives in `library_db.MIGRATIONS`.
- Every table is tenant-scoped by `tenant_key = sha256(bearer)`. No
  query bypasses this; see `library_api.py` middleware.
- The `clip_audio` table holds the combined WAV as bytea — there is
  no separate object-storage tier.
- Tombstones survive client deletes so deletions sync (#458).

---

## 6. SW cache

| Property | Value |
|----------|-------|
| Cache name | `narrative-shell-v225v4.17` (current) |
| Defined in | `sw.js:5` |
| What's cached | shell + manual + landing + icons (see `SHELL` array) |
| API responses | **never** cached (`/api/*` short-circuits at `sw.js:58`) |

The cache name is also read at runtime by `_dlog` to stamp the
build version on every log entry (#500). When you bump SW, you also
bump:

- `static/index.html` — version badge in Settings
- `whats-new.html` — newest release entry promoted to `.release-newest`

(See ARCHITECTURE §8 "Service-worker cache versioning" for the full ritual.)

---

## 7. Orphan candidates — punch list

The point of this audit. Items here are safe-to-investigate-for-delete.
Each row is a discrete cleanup ticket.

| # | Item | Where | Why orphan | Risk |
|---|------|-------|------------|------|
| 1 | `LEGACY_AUTHOR_MODE_KEY` migration branch | `app.js:1353, 1362–1370` | Migration shipped in v76 (#203). 2+ years of users have migrated. | Low — the read+removeItem branch is idempotent. |
| 2 | `LAST_GITHUB_REPO_KEY` legacy seed | `app.js:8021, 8041–8049` | Comment literally says `// legacy (single)`. Seeds `RECENT_GITHUB_REPOS_KEY` once for upgrading users. | Low after a couple of versions. |
| 3 | `bookViewV2` flag + V2 paginator | `app.js:18126, 18149, 18152` + V2 code | V2 abandoned in #733. Already a pending cleanup task (#743). | Medium — confirm no clip relies on V2-only behavior first. |
| 4 | V1 paginator + its `?bookviewv3=0` opt-out | V1 region of app.js | V3 has been default since v225v3.10. Pending cleanup task #748. | Medium — V3 needs to soak without rollbacks first. |
| 5 | `bookFontSize` / `bookTheme` un-namespaced keys | `app.js:19865, 19891` | Inconsistent with the rest of the codebase (`narrative.*` prefix). | Low — but bumping the key string would orphan users' saved prefs. Better: leave alone, just document. |
| 6 | `narrative.tutorialLog` sweep | `app.js:62, 78–88` | The cross-frame breadcrumb only exists for the standalone-iframe case. If `tutorials.js` is always loaded inside the SPA now (which it is — #625), the sweep may be dead. | Low — verify by checking if tutorials are ever served standalone. |
| 7 | `_OFFLINE_PENDING_SYNTH_KEY` | `app.js:1102, 1106, 1116` | Tier 1 offline drafts (#567). Status in task list: **pending**. The key exists, the consumer may not. | High — if this is for a not-yet-shipped feature, deleting it loses scaffolding. |
| 8 | `_OFFLINE_PENDING_TRANSCRIBE_KEY` | `app.js:17218, 17221, 17231` | Tier 2 transcript queue (#569 / #570). Status: **pending**. Same caveat as above. | High — pre-built scaffolding. |
| 9 | `SPEAKER_AUDITION_TIP_DISMISSED_KEY` vs `_USED_KEY` | `app.js:8319, 8320` | Two separate one-shots for the same hint — dismissed vs used. The "used" key is set when the user actually uses Audition (#9112, #9148). | Low — two-key pattern is intentional; just confirm both still gate. |
| 10 | ARCHITECTURE.md §4 wrong DB name | `ARCHITECTURE.md:196` | Says `narrative-db`; actual is `audiable`. Also implies separate `libraryOrder` / `preferences` / `voicePresets` stores — there's only `clips`. | None — doc fix. Bump ARCHITECTURE.md when this lands. |

---

## 8. Methodology

How this doc was produced — so the next maintainer can reproduce it.

### Find every storage key

```
# All localStorage calls in app.js
Grep "localStorage" → 137 occurrences

# Resolve the const → string mapping
Grep "^const \w*_KEY\w* = \"narrative\." → 44 named keys
Grep "localStorage.*narrative\." → 7 raw-string keys
Grep tutorials.js + overlay-tour.js → 2 additional (one templated)

# sessionStorage
Grep "sessionStorage" → 1 occurrence
```

### Find every IDB transaction

```
Grep "indexedDB.open|createObjectStore|objectStore\(|transaction\("
→ 11 sites
```

### Find module-scope state

```
Grep "^let \w+ = " in app.js → ~100 top-level globals
Grep "^window\.\w+ = " → 8 window exposures
```

### What was NOT done

- **Per-key callsite count.** Every key has a single canonical
  read/write helper. Counting all callsites would be useful if we
  were renaming a key, but that's a future-work search rather than
  doc work.
- **Server-side state catalog.** ARCHITECTURE.md and SYNC.md cover it.
- **Comment archaeology.** Pending task #746 — out of scope for this
  pass.

---

## 9. Updating this doc

- The companion to ARCHITECTURE.md, not a replacement. When you add
  a new storage key, update §2.1 + flag any orphans in §7.
- When ARCHITECTURE.md drifts from the actual storage layout, fix
  the drift here and link to the offending paragraph.
- When a cleanup ticket from §7 lands, strike the row out (don't
  delete it — the trail matters for understanding why a key was once
  there).
- This doc has a version stamp (`v225v4.17`) so you can tell at a
  glance if it's behind the code. Bump when you reshape §1–§4.
