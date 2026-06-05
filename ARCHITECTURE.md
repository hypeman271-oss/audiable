# Narrative — Architecture

Living orientation doc for the Narrative codebase. The job here is to
get a new collaborator (often: future-me at 3 a.m.) productive in
under 30 minutes. Read this once, then jump to the right file with
context already in your head.

This doc covers **what lives where and why**. It does NOT duplicate
the operational docs:

- **STRATEGY.md** — product framing, market, pricing, V1 plan
- **SYNC.md** — Path B cross-device sync design + invariants
- **DEPLOY.md** — Fly deployment walkthrough
- **OAUTH_SETUP.md** — GitHub OAuth configuration
- **BACKLOG.md** — long-tail ideas not on the active task list
- **INVITE_TEMPLATE.md** — boilerplate when onboarding a tester
- **DEBUG_PLAYBOOK.md** — diagnostic methodology + case studies.
  Read this BEFORE chasing any "user reports X looks wrong" bug.
  Saves a session per bug hunt.
- **static/manual.html** — user-facing manual (also the source of
  truth for the in-app help dialog)

When this doc and the code disagree, **the code wins** — update this
doc to match.

---

## 1. What this is

Narrative is a writer-revision tool dressed as a TTS audiobook player.
A novelist drops their manuscript in, gets it narrated, listens during
revision, flags spots that need work, sometimes edits a sentence in
place, and the audio re-synthesizes silently in the background. The
core loop is **Write → Listen → Revise**, repeated until the prose is
right.

Three things are load-bearing for the product:

1. **Importers** — text comes from anywhere a writer keeps it
   (Scrivener, GitHub, Obsidian vaults, EPUB/PDF/DOCX, pasted URLs).
2. **Cross-device sync** — write at the desk, listen at the gym.
   See SYNC.md.
3. **Per-sentence machinery** — sentences are the atomic unit. The
   reading view, audio offsets, annotations, bookmarks, character
   voice assignments, and inline edit all key off a stable sentence
   index.

Everything else is in service of those three.

Deployed at **narrative-alpha.fly.dev**.

---

## 2. Top-level map

### Repo root

| File | Role |
|------|------|
| `server.py` | FastAPI app. Top-level routes for synth, voices, extract, import, GitHub, jobs, splice. Mounts library_api + admin_api as routers. |
| `library_api.py` | `/api/library/*` endpoints — clips, audio, presets, pull/push for sync. Tenant-scoped. |
| `library_db.py` | SQLite schema + connection helpers for the server-side library. Schema v3 (annotations migration). |
| `admin_api.py` | Admin-only endpoints to mint/list/revoke tester keys. Guarded by `NARRATIVE_ADMIN_KEY`. |
| `extract.py` | Text extractors for EPUB / PDF / DOCX / HTML / URL / Scrivener / Obsidian / Markdown / GitHub. Plus the `/api/extract/*` handlers. |
| `image_detector.py` | Auto-detect cover + chapter-leading images during import. Per-format rules + ranked heuristics. See header comment for the format-by-format detection ladder. |
| `synth_jobs.py` | Resumable synth jobs. Background queue that survives client SSE disconnects. Pairs with `/api/synth/jobs/*`. |
| `transcribe.py` | Server-side Whisper for voice-note transcription (annotation voice notes → text). |
| `github_oauth.py` | OAuth-app flow for repo browsing without manual PATs. |
| `tts/` | TTS engine package. See §5. |
| `static/` | Frontend. Served as the SPA + manual + landing. See §6. |
| `src-tauri/` | Native desktop wrapper. Phase 1 (cloud-pointed shell, #397) + Phase 2 (PyInstaller sidecar, #398) shipped. Phases 3+ (#704–708) pending. |
| `scripts/` | Voice download helpers, fixture generators, parser smoke tests. Not part of runtime. |
| `tests/` | Playwright e2e regression suite. `tests/e2e/regression.spec.js`. |
| `Dockerfile` / `fly.toml` | Production deploy. Fly autostop is currently disabled; see #343. |
| `requirements.txt` | Python deps. Pinned for reproducible Docker build. |
| `narrative-server.spec` | PyInstaller spec for the Tauri sidecar bundle. |

### `tts/` package

| File | Role |
|------|------|
| `__init__.py` | The `synthesize` / `synthesize_iter` / `synthesize_segments_iter` API used by `server.py`. Routes by voice-id prefix to the right engine. Owns sentence splitting (shared across engines) and the `Voice` / `SynthesisResult` dataclasses. |
| `piper_engine.py` | Piper (ONNX) — V1 default narrator. CPU, fast, ~50 voices. |
| `kokoro_engine.py` | Kokoro — candidate V1 replacement. Better prosody, slower on CPU. Decision pending (#411). |
| `qwen3_spike.py` | Qwen3-TTS exploration. Apache 2.0, GPU-tier. Not wired into production (#358 / #399). |
| `sapi.py` | Windows SAPI fallback. Mostly historical — useful for local dev without bundled voices. |
| `catalog.py` | Per-voice metadata: license, attribution, install URLs. Drives the voice browser. |
| `voice_licenses.py` | License audit data — Commercial vs Non-commercial filter (#215 / #217). |
| `encode.py` | WAV → MP3 via lameenc. Output encoding for downloads + chapter audio. |
| `splice.py` | Per-sentence WAV splice for inline single-sentence edit (#537 / #584). Re-synthesizes one sentence and stitches into the existing WAV. |

### `static/`

| File | Role |
|------|------|
| `index.html` | SPA shell. Hero, dialogs, library, voice picker, reading view, book view, all banners. ~3,800 lines. |
| `app.js` | The application. ~29k lines, monolithic on purpose (see §6). |
| `styles.css` | All UI. ~13k lines, no preprocessor, semantic tokens for theming. |
| `sw.js` | Service worker. Cache-first for the shell, network for `/api/*`. Cache name = version stamp. |
| `tutorials.js` | Walkthrough engine + the actual tutorials (First listen, Revise as you listen, etc.). |
| `overlay-tour.js` | Shepherd-style guided-tour engine for the "Take the tour" onboarding flows. |
| `manual.html` | User-facing manual. Opened via Settings → Help in an iframe dialog. Also the source for the phone manual viewer (parsed into swipeable section sheets). |
| `whats-new.html` | Changelog. Newest entry gets `.release-newest`; demote previous on each ship. |
| `landing.html` | Marketing landing page. Scaffold only — copy/assets pending (#406–408). |
| `admin-troubleshooting.html` | Admin-only diagnostic page. |
| `manifest.webmanifest` | PWA manifest. |

---

## 3. Runtime architecture

### Synth pipeline (the canonical request)

```
browser                                  Fly app                            engine
───────                                  ───────                            ──────
generate(text, voice)
  ├─ POST /api/synth/jobs ──────────────► synth_jobs.create
  │      {text, voice, ...}                 ├─ tenant_key from bearer
  │                                         ├─ persist job row
  │                                         └─ return job_id
  │
  ├─ GET /api/synth/jobs/{id}/stream ────► SSE keepalive every 15s
  │     (resumable; reconnect-safe)         ├─ split_sentences(text)
  │                                         ├─ for each sentence:
  │                                         │    tts.synthesize_iter ──────► piper / kokoro / ...
  │                                         │       yields WAV bytes
  │                                         │    encode.wav_to_mp3
  │                                         │    emit "sentence" SSE event
  │                                         └─ emit "done" SSE event
  │                                                with combined WAV URL
  │
  ├─ playback starts at first sentence
  │     (sequential per-sentence WAVs)
  │
  └─ on "done": swap to combined WAV
        save clip to IndexedDB (+ server if sync on)
```

**Key invariants:**

- Sentences are split server-side by `tts.split_sentences`. The
  client never re-splits — it relies on the offsets the server
  emits via the `X-Audiable-Sentences` header (legacy name, kept
  for compatibility).
- The synth-jobs API was added for #512 / #580 so a phone that
  backgrounds mid-synth doesn't kill the work. The job runs server-
  side; the client just attaches/reattaches to the SSE stream.
- SSE has a 90-second first-byte watchdog and a 30-second steady-
  state watchdog (#566). On Fly cold start (~10-20 s), the keepalive
  prevents a false-positive disconnect.

### Import pipeline

```
user picks a file / URL / repo
  ├─ POST /api/extract/{format}
  │       ── handled by extract.py per format
  │       ── returns { text, images[], chapters?, source_meta }
  │
  ├─ image_detector picks cover + chapter-leading images
  │       (per-format ranked heuristics — see image_detector.py header)
  │
  ├─ client builds an import preview (thumbnails + first paragraphs)
  │
  └─ user clicks "Open as ebook" or "Generate" → enters the synth pipeline
```

### Sync pipeline (when enabled)

See SYNC.md for the full design. Quick summary:

- **Pull**: `GET /api/library/pull?since={ts}` → tombstones +
  changed clips. Client applies into IndexedDB.
- **Push**: every `saveClip` also POSTs to `/api/library/clips/{id}`.
  Per-clip last-write-wins. Annotations array uses server-side
  merge (#495) to avoid LWW wipe of cross-device annotations.
- **Audio**: synth pipeline persists the combined WAV to the Fly
  volume keyed by `tenant_key + clip_id`. The receiving device
  downloads on demand via `GET /api/library/clips/{id}/audio`.
- **Tenant scoping**: every query filters by
  `tenant_key = sha256(bearer)`. No accounts, just an opaque per-
  tester key minted by the admin.

---

## 4. Data model

### Client (IndexedDB)

The browser is the source of truth for users who haven't turned sync
on. With sync on, the server is authoritative for cross-device state
and the client mirrors.

```
narrative-db (IndexedDB)
├─ clips                  — { id, title, text, audioBlob?, voice, sentences[],
│                             progressSec, bookmarks[], annotations[],
│                             highlights[], notes, tags[], cover,
│                             chapterImages[], gitRef?, syncedAt? }
├─ libraryOrder           — string[]  custom-order clip IDs
├─ preferences            — { mode, theme, skipBackSec, ... }
└─ voicePresets           — { id, voice, speakerId, ... }
```

`saveClip` is atomic via a single IndexedDB transaction (#488 was the
fix for read-modify-write races). Any new callsite that mutates a
clip should use `saveClip(clipId, mutator)` — not read, then write.

### Server (SQLite on the Fly volume)

```
narrative-library.db                      (mount: /data/library.db)
├─ tenants(tenant_key, label, created_at, role)
├─ clips(tenant_key, id, json, updated_at)         — per-clip JSON blob
├─ clip_audio(tenant_key, clip_id, wav, mime)       — bytea audio
├─ presets(tenant_key, id, json, updated_at)
├─ tombstones(tenant_key, id, kind, deleted_at)
└─ jobs(id, tenant_key, status, sse_state, ...)     — synth_jobs
```

Schema migrations are append-only; `library_db.MIGRATIONS` lists each
version. Current schema = **v3** (annotations migration).

### Identity model

There are no user accounts. A bearer token (`X-Narrative-Key` header)
is opaque. The server hashes it (`sha256`) to get a `tenant_key` and
scopes every query by it. The admin mints tester keys by hand and
shares them via `INVITE_TEMPLATE.md`.

When V1 ships, Path C will replace this with Supabase auth. The
schema is already shaped for it — `tenant_key` becomes `user_id`.

---

## 5. TTS engines

### Engine interface

Every engine module exposes:

```python
def list_voices() -> list[Voice]: ...

def synthesize_iter(
    text: str,
    voice_id: str,
    rate: float | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
) -> Iterator[SynthesisResult]:
    """Yield per-sentence WAVs."""
```

`tts/__init__.py` dispatches by voice-id prefix (`piper:`, `kokoro:`,
`sapi:`) and exposes the same surface to `server.py`. To add a new
engine:

1. Drop a `tts/<engine>_engine.py` with the two functions above.
2. Add a case to the dispatcher in `tts/__init__.py`.
3. Add catalog entries in `tts/catalog.py` + license metadata in
   `tts/voice_licenses.py`.
4. Add bundling instructions to the Dockerfile if the engine needs
   model weights.

### Current engines

| Engine | Status | Notes |
|--------|--------|-------|
| Piper | **Production default** | Fast on CPU. ~50 voices. V1 narrator. |
| Kokoro | Shipped, gated to Author mode | Better prosody. RTF currently the gating concern (#411, #582). |
| SAPI | Windows-only fallback | Mostly historical; useful in local dev. |
| Qwen3 | Spike only (`qwen3_spike.py`) | Apache 2.0, GPU-tier. Production wire-up gated on #399. |

`splice.py` provides per-sentence re-synthesis used by the inline
edit feature — it re-runs one sentence through the active engine and
stitches the new WAV into the existing combined audio. The original
sentence WAVs are not persisted (#586 is the future market for that).

---

## 6. Frontend regions

### Why monolithic

`static/app.js` is ~29k lines in a single file. This is deliberate
for the alpha. Reasons:

- **Service-worker cache invalidation is per-file.** Splitting means
  a one-line fix bumps multiple cache entries instead of one. The SW
  cache name bumps with every release; one file = one round-trip on
  upgrade.
- **No build step.** The repo ships as-is to Fly. Adding bundler
  config invites tooling drift; we'd rather pay the editor scroll
  cost.
- **Grep is the IDE.** With one file, function-name grep finds every
  callsite. Splitting would require a real index.

This *will* be revisited when V1 ships. Cleanup task #747 will lift
book-view code into `book-view.js` once the V1 paginator (#748) is
deleted, because that's the biggest standalone chunk.

### Region map (by line range, approximate)

| Lines | Region |
|-------|--------|
| 1–2000 | Globals, IndexedDB helpers, theme boot, mode picker. |
| 2000–7000 | Dialogs (library, voice, settings, edit, characters, picker), banners, sync wiring. |
| 7000–10000 | Player state machine, audio element, mini-player, sleep timer, A↔B loop, skip controls. |
| 10000–14000 | Reading view: span building, sentence selection, inline edit, auto-scroll, annotations, voice notes, drag-to-select. |
| 14000–17000 | Book view V1 (CSS columns) — to be deleted post-V3 soak (#748). |
| 17000–19500 | Book view V3 (manual JS pagination) — current default. |
| 19500–22000 | Empty state, import dropdown, import preview, ebook mode. |
| 22000–26000 | Generate / synth pipeline, bg-queue, chapter queue, re-narrate paths. |
| 26000–29278 | URL/file/GitHub/Scrivener/Obsidian extract handlers, sync adapter, command palette, phone-specific bottom-bar wiring. |

These are starting points, not contracts — `app.js` has been edited
thousands of times and line numbers drift constantly. When you need
a region, grep for a representative function name (e.g. `loadClip`,
`enterReadingView`, `_bookViewV3Setup`, `generate`).

### Key globals

- `currentClipId` — the loaded clip. `null` when no clip is open.
- `_bookSentenceSpans` — array of `<span class="sentence">` for the
  current clip. Populated by `enterReadingView`. Indexed by `data-idx`.
- `_bookSentenceToPage` — map from sentence-idx to page-idx in book
  view. Shared infrastructure that powers TOC, bookmarks, find.
- `_bookViewV3State` — V3 paginator state (pages, spreadIdx, etc.).
- `_dlog(category, message, data)` — self-diagnosing debug log. Every
  log entry stamps the build version + mode. Surfaced via Settings →
  Send feedback (#508). Use this liberally; it's how we diagnose
  remote phone bugs without a remote debugger.

---

## 7. Book view

The book view has had three implementations. Only V3 is the keeper.

| Version | Approach | Status |
|---------|----------|--------|
| V1 | CSS `column-count` lays out a fixed-height container. Browser does the pagination. | Phased out as default in v225v3.10. Still reachable via `?bookviewv3=0`. To be deleted (#748). |
| V2 | Readium-style two-phase manual measure. | Abandoned (#733); pending delete (#743). |
| V3 | Manual JS pagination (word-processor model) — we put one paragraph at a time into a probe element, measure, decide where to break. | **Current default.** |

V3 owns the shared infrastructure (sentence-to-page map, drop caps,
page numbers, bookmark ribbons, find/TOC/page-jump). V1 still has its
own page-flip animation; V3 uses a translateX slide. StPageFlip
corner-curl was tried (v3.19) and dropped (v3.22) — see whats-new.

Book view nav (the prev/next/page-jump controls) auto-hides after
~2.5 s of inactivity on phone (#741, Kindle pattern). The pill lives
in the hero header strip on desktop, not over the spread.

---

## 8. Patterns to preserve

These are the load-bearing conventions. Breaking them silently
breaks something:

### Service-worker cache versioning

Every release bumps:

- `static/sw.js` — `const CACHE = "narrative-shell-vXXX";`
- `static/index.html` — `<span id="settings-version-tag">vXXX</span>`

The version-tag string is also read at runtime by `_dlog` to stamp
the build version on every log line. If you bump SW but not index,
returning users see a version mismatch in Settings.

### Feature flags via localStorage + URL

`?flagname=1` → write `localStorage[flagname] = "true"`, then check
`localStorage.getItem(flagname) === "true"` everywhere. `?flagname=0`
clears it. Default state lives in the read function. Example:
`_bookViewV3Enabled()`. This lets us A/B kill switches and ship
ungated work behind a default-on switch.

### `_dlog` for everything new

When you add a code path that might silently fail or behave
differently on phone, instrument it with `_dlog`. Categories are
free-form strings (`"clip-load"`, `"book-v3"`, `"stpageflip"`, etc.).
Logs are exported via Settings → Send feedback. The underscore
prefix matters — `dlog` (no underscore) was a recurring typo bug
(#718, #600).

### Curated menus

Per user instruction: present the full survey of options, not
pre-trimmed top picks. The user routinely accepts the whole menu.
Applies to UI surfaces (Import dropdown), but also to in-session
recommendations from Claude when narrowing scope.

### Atomic clip saves

`saveClip` mutators must be the single read/modify/write
transaction. Don't `getClip` → mutate → `putClip` — that races
with sync absorb and re-narrate paths. See #488 for the original
class of bug.

### Manual + whats-new sweep on user-facing changes

Anything a user could notice gets:

1. A whats-new entry (newest = `release-newest`, demote previous).
2. A manual update if the behavior changed.
3. A SW bump.
4. A regression test if the surface is bug-prone.

`v225fz4`, `v225fj`, etc. are pure "sweep" tasks doing exactly this.

### Debug-log push pipeline (v225v3.38+)

The phone uploads `_debugLog` exports to a private GitHub repo so
the debugger agent can `git pull` and read them without asking the
user to attach a file. Three pieces:

- **Phone (`app.js`)** — `_autoDownloadDebugLog(reason)` does a
  local download AND a fire-and-forget POST to `/api/debug-log`.
  Settings has a manual **Push debug log to debugger** button for
  on-demand pushes.
- **Server (`debug_log_push.py` + `/api/debug-log`)** — commits
  to the logs repo via the GitHub Contents API. Token + repo in
  Fly secrets (`NARRATIVE_DEBUG_LOGS_TOKEN`,
  `NARRATIVE_DEBUG_LOGS_REPO`). Verbatim (no redaction); the repo
  is private. Failures return ok=false (never 5xx) so the local
  download path is never blocked.
- **Agent (`.claude/agents/debugger.md`)** — clones the logs repo
  once next to the project root, `git pull`s before every diagnosis,
  reads the newest log matching the bug's reason.

DEBUG_PLAYBOOK.md Method 6 documents the protocol end-to-end.
Filename convention `logs/<UTC-iso>-<reason>-<version>.txt`
makes "newest matching log" a trivial `ls | grep | tail`.

---

## 9. Open architectural questions

These are recorded here so future-you doesn't re-derive the trade-off
from scratch. Detail lives on the task list.

| Question | Decision pending | Tasks |
|----------|------------------|-------|
| When can V1 paginator code be deleted? | After V3 soaks without rollbacks. No fixed timeline. | #748 |
| Should V2 paginator be removed now? | Yes — abandoned. Cleanup not yet done. | #743 |
| Should `app.js` be split? | After V1 ships. Book view → `book-view.js` first. | #747 |
| Should `_dlog` be gated by a build flag? | Yes; needs build step or runtime toggle. | #749 |
| Piper or Kokoro as V1 narrator? | Blocked on real-chapter RTF measurement. | #411, #582 |
| When does sync flip to default-on? | After #429–#431 land + smoke-tested on two devices. Currently opt-in. | #429–431 |
| Tauri local assets vs Fly pointer? | Local assets needed before signing/notarizing. | #704 |
| Autostop re-enable on Fly? | After v204 keepalive proven in practice. | #343 |

---

## 10. When updating this doc

- **The code wins.** If you find a contradiction, fix the doc.
- **Don't append history.** Whats-new is for history; this doc is
  for the current shape.
- **Prefer pointers to detail over inlining.** If something is
  fully covered in SYNC.md or DEPLOY.md, link rather than restate.
- **Bump nothing.** This doc has no version; it's the
  always-current snapshot.
