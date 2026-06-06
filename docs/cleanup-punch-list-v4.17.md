# Narrative — Cleanup punch list (post-audit, v225v4.17)

Actionable checklist drawn from:

- `docs/dead-code-audit-v4.17.md` — function-by-function audit of `app.js`
- `docs/state-data-flow-v4.17.md` — storage-key + global-state inventory

This file is a **work queue**, not a reference. Check items off as you
land them. If an item gets bumped to its own ticket on the main task
list, mark it `→ #NNN` here so the trail survives.

Use the **severity** column to triage:

- **safe** — no behavioral risk; pure cleanup
- **low** — small risk; verify locally then ship
- **medium** — needs a smoke test or a soak period before deletion
- **gated** — blocked by an existing pending task; do not touch
  until that lands

---

## Tier 1 — Safe deletions / doc fixes (do anytime)

These are zero-risk. Land them in a small dedicated commit.

- [ ] **Delete `_refreshMaintenanceFormVisibility`** — `app.js:1695`.
  Zero callers anywhere in `static/`. Sibling helpers
  (`_populateMaintenanceForm`, `_startMaintenanceTick`) are wired up;
  this one is orphaned. **safe**.

- [ ] **Fix ARCHITECTURE.md §4 IndexedDB description.**
  - Rename `narrative-db` → `audiable` (actual DB name, see
    `app.js:20179`).
  - Drop the phantom object stores `libraryOrder`, `preferences`,
    `voicePresets`. The only IDB object store is `clips`; the others
    live in localStorage.
  - **safe** — doc-only.

- [ ] **Drop the `narrative.authorMode` legacy migration branch.**
  - Site: `app.js:1353` (const) and `app.js:1362–1370` (read +
    `removeItem`).
  - Migration shipped in v76 (#203, ~2 years ago). Every active
    user has migrated. The read+remove is idempotent dead code now.
  - **safe**.

- [ ] **Drop the `LAST_GITHUB_REPO_KEY` legacy seed.**
  - Sites: `app.js:8021` (const, comment says `// legacy (single)`)
    and `app.js:8041–8049` (one-shot seed of
    `RECENT_GITHUB_REPOS_KEY` for upgrading users from #290 / v176).
  - Anyone who hasn't opened the GitHub browser since v176 will get
    an empty recent-repos list — they'd see the same after a
    keychain wipe. Acceptable.
  - Also delete the paired `_getLastGithubRepo` / `_setLastGithubRepo`
    helpers (`app.js:8082, 8089`) — they're single-callsite and only
    exist to bridge the legacy key.
  - **low** — verify no other reads remain.

## Tier 2 — Decisions (10-minute investigations)

These need a human call. Each one is a small fork.

- [ ] **`_pruneOldDays(stats)` — wire it up or delete it.**
  `app.js:6486`. Takes a `stats` arg, looks designed to TTL-trim
  old day entries from `narrative.stats`. It's never called. Pick:
  - **Wire it up** — call from `_loadStats` at `app.js:6447` with a
    sensible TTL (90 days?). Bounds the stats blob from unbounded
    growth.
  - **Delete it** — accept unbounded growth. The blob is small and
    text-only so this is fine in practice.
  - **safe** either direction.

- [ ] **Verify `narrative.tutorialLog` is still reachable from
  standalone iframes.**
  - The cross-frame breadcrumb at `tutorials.js:42–46` only
    matters if `tutorials.js` is ever loaded outside the main SPA.
    Since #625 (v225eh) extracted the engine into `tutorials.js`,
    I think it's always loaded inside the SPA — but didn't verify.
  - If always-SPA: delete the sweep at `app.js:62, 78–88` plus the
    write in `tutorials.js`.
  - If sometimes-standalone (e.g. opening a tutorial in a new tab):
    leave it.
  - **low**.

- [ ] **`SPEAKER_AUDITION_TIP_*` — confirm two-key pattern is
  intentional.**
  - `_DISMISSED_KEY` + `_USED_KEY` at `app.js:8319–8320`. Two
    separate one-shots gate the same hint. The "used" key fires
    when the user actually uses Audition (#9112, #9148).
  - Probably intentional ("dismissed" = "I don't want this hint
    again", "used" = "I figured the feature out"). Confirm by
    reading the hint show logic.
  - If they collapse, drop one and update `_ONBOARDING_HINT_KEYS`.

- [ ] **Offline scaffolding keys — leave or yank.**
  - `_OFFLINE_PENDING_SYNTH_KEY` (`app.js:1102`) and
    `_OFFLINE_PENDING_TRANSCRIBE_KEY` (`app.js:17218`).
  - Both are scaffolding for **pending** features (#567, #569).
  - If those features are still on the roadmap: leave alone.
  - If they've been dropped: delete the keys and their helpers
    (`_addPendingSynth`, `_clearPendingSynth`, `_clearPendingTranscribe`,
    `_drainPendingTranscribes`).
  - **high risk** to delete blind — confirm roadmap status first.

## Tier 3 — Gated cleanups (blocked by existing tasks)

Do NOT touch these until the gating task lands. Listed here so they
don't get forgotten.

- [ ] **Delete `bookViewV2` flag + V2 paginator family.**
  Gated by **#743** (`Cleanup: drop V2 paginator`). When that lands,
  also drop:
  - `bookViewV2` localStorage key (read at `app.js:18152`,
    writes at `app.js:18149`).
  - `_bookViewV2Setup` (`app.js:18158`) and the whole
    `_bookViewV2*` family (lines 18144–18491).
  - `_enterBookViewV2` (`app.js:18491`).
  - The V2 branch in `enterBookView`.

- [ ] **Delete V1 paginator + `?bookviewv3=0` kill switch.**
  Gated by **#748** (`Cleanup: drop V1 paginator after V3 soak`).
  Soak period not yet declared closed. When it is, drop:
  - `bookViewV3` localStorage key (`app.js:18571–18578`).
  - V1 paginator code path (book view V1 region of `app.js`).
  - Keep `_bookViewV3*` — that's the keeper.

- [ ] **Lift book-view code into `book-view.js`.**
  Gated by **#747**. Becomes possible after #743 + #748 land.
  Both V2 and V3 audit lines (~18144–19795) move together.

- [ ] **Gate `_dlog` behind a build flag.**
  Tracked as **#749**. Needs a build step or runtime toggle. Not
  a deletion — a config decision.

## Tier 4 — Larger refactors (call out, don't schedule)

These are bigger calls. Capture them here so they don't get
re-derived later.

- [ ] **`bookFontSize` / `bookTheme` un-namespaced localStorage
  keys** (`app.js:19865, 19891`). Everything else uses
  `narrative.*`. Renaming would orphan users' saved book-view prefs
  — there's no upside that justifies the migration. **Recommend:
  leave alone, document the inconsistency** (already done in
  `state-data-flow-v4.17.md` §2.1).

- [ ] **Per-clip schema versioning.** IDB `DB_VERSION = 1` from day
  one; every new clip field has been added by in-place mutation. If
  we ever need to *drop* a clip field cleanly (vs. just stop reading
  it), we need an `onupgradeneeded` migration ladder. Not urgent —
  raise when it actually blocks something.

- [ ] **`window.*` exports** (~9 of them — see
  `state-data-flow-v4.17.md` §4). All are intentional reach-ins
  for HTML attributes and the tutorial engine. Don't try to
  eliminate as a goal in itself — they're a real surface.

## Tier 5 — Out of scope here

Pending tasks on the main list that overlap conceptually but don't
belong on this punch list. Pointers only.

- **#746** `Cleanup: comment archaeology pass` — separate sweep.
  Different methodology (read every comment, decide if it's still
  true). Don't fold into the dead-code/state work.

- **#743**, **#747**, **#748**, **#749** — already-tracked
  cleanup tasks. Their work IS the gated items in Tier 3.

---

## Operational follow-ups (from bug hunts)

Tracked items born out of incidents during normal work. Not strictly
cleanup, but related enough that they belong on the same punch list
so they don't get forgotten between sessions.

- [ ] **#823 — Server-side wedge instrumentation.** Origin:
  2026-06-06 Fly machine wedged silently for ~10h with no
  diagnostic trail. Forced restart recovered, but the pre-wedge log
  window had already aged out of Fly's 100-line retention by the
  time I went looking. Diagnosis was inconclusive: could be Kokoro
  espeak-ng zombie thread, SSE keepalive coroutine leak,
  resumable-jobs state corruption, SQLite WAL bloat, or uvloop
  event-loop starvation. Add four pieces so the NEXT wedge
  produces actionable data:

  1. **Async heartbeat task** — logs `[heartbeat] ok` every 60s.
     Silence in `fly logs` = event loop is dead. Cheapest possible
     liveness signal; survives WAL contention.
  2. **Rich `/api/healthz` endpoint** — reports `{sqlite_reachable,
     kokoro_warmed, jobs_cleanup_alive, open_sse_count,
     recent_error_count}`. Curlable from outside, also drivable
     from Fly's health check.
  3. **WAL checkpoint cron** — `PRAGMA wal_checkpoint(TRUNCATE)`
     every 5 min when WAL > N MB. Removes hypothesis D (WAL bloat)
     from future diagnoses permanently.
  4. **SSE coroutine accounting** — counter of open + cleaned per
     stream type, logged on the heartbeat tick. Removes hypothesis
     B (keepalive leak) from future diagnoses.

  ~30-min ticket. Should NOT ship in same deploy as Phase B — keep
  blast radii separate so a recurring wedge can be cleanly
  attributed.

  Related-but-separate existing tasks (don't re-derive):
  - **#343** — Re-enable Fly autostop once v204 keepalive proven.
    Wedge is signal *against* re-enabling — autostop would have
    rolled the wedge an hour in instead of 10 hours. But also
    signal *for*: autostop forces fresh boots which mask
    accumulation bugs we'd rather find.
  - **#574** — Fix Fly autostop × rolling-deploy interaction.
    Same neighborhood; #823's instrumentation will help diagnose
    that too.

---

## Methodology trail

If a future maintainer needs to re-run any of this:

1. **Dead-code re-audit** — reproduce the steps in
   `dead-code-audit-v4.17.md` §"Methodology notes". Pattern: extract
   `function NAME(` definitions, word-bound grep each name against
   all `static/*.js` and `index.html`, bucket by occurrence count.
   2 occurrences = one caller = boot-time wire (not dead).
   1 occurrence = no caller = candidate.

2. **State re-audit** — reproduce the steps in
   `state-data-flow-v4.17.md` §8. Pattern: enumerate every
   `localStorage.\w+` call, resolve const → string mapping, group
   by subsystem, flag legacy / migration-only / scaffolding keys.

3. **Cross-reference** — every key needs a function that reads it,
   and most functions that handle a key get flagged once on the
   dead-code side and once on the storage side. Items that show up
   on both lists (e.g. `_getLastGithubRepo` + `LAST_GITHUB_REPO_KEY`)
   are the highest-confidence cleanups.

---

## Done items (strike, don't delete)

Track landed cleanups here so future audits can verify they stuck.

_(empty — first revision)_

---

## When updating this file

- Treat as append-only history once items land. Strike with
  `~~text~~` rather than deleting; the trail tells the story.
- New cleanup candidates from future audits go in the right tier.
- If an item gets ticketed onto the main task list, append `→ #NNN`
  to the bullet — don't move it off this list.
- This file has a version stamp (`v225v4.17`); bump when you do a
  full re-audit pass.
