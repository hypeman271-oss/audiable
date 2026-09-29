# Project guide — Lyrith (internal name: Narrative)

TTS / audiobook web app for indie authors. FastAPI backend (`server.py` +
`library_api.py`/`library_db.py`/`extract.py`/`tts/`) serving a vanilla-JS
frontend in `static/` (`app.js`, `styles.css`, `index.html`, `sw.js`). No
build step, no framework. Deployed at narrative-alpha.fly.dev; a Tauri
Windows app (`src-tauri/`) embeds `static/` at build time.

Branding is display-only: **Lyrith** comes from `APP_NAME` in app.js.
Internal identifiers (`narrative.*` keys, `X-Narrative-*` headers,
`narrative-shell-` cache, `audiable` repo/db names) stay as they are.
The voice "Audition" feature keeps its name — it is not a branding leftover.

## Hard rules

1. **Bump `const CACHE` in `static/sw.js` on ANY static/ change** — one
   version per change set (`narrative-shell-v225v4.NNN`). The visible
   version pill derives from it; forgetting the bump ships an update no
   client will load.
2. **Shared repo — a second agent also commits here.** After every commit:
   `git pull --rebase origin main` then `git push origin main`. Never sit
   on local commits. Handoff context: `docs/AGENT_HANDOFF.md`,
   `docs/INTEGRATION.md`.
3. **Never deploy over a running synthesis.** Before `flyctl deploy -a
   narrative-alpha`, check `flyctl logs` heartbeats show a stable `jobs=0`.
   A deploy mid-job kills the user's audiobook build. After deploy, verify:
   `curl -s https://narrative-alpha.fly.dev/sw.js | grep CACHE`.
4. **Consult `DEVICES.md` before touching any UI surface.** State which
   tiers (phone / tablet / wide desktop / Tauri) the change affects and
   default to the narrowest tier the user named. Phone gotcha that keeps
   biting: the text-card label-row and the Generate action rows are
   `height: 0` on phone — a button added there is invisible; phone
   surfaces dispatch from the ☰ menu, tag row, or pull-up instead.
5. **Theme-safe styling only.** Six themes redefine tokens on
   `:root[data-theme]`. Use tokens (`--bg-card`, `--fg`, `--accent`,
   `--working`, …) or `color-mix()` on tokens — never hard-coded colors.
   Sanity-check light + sepia, not just the default dark. Never transition
   the `background` shorthand (Chromium wedges it across theme flips);
   transition `background-color` and friends.
6. **Every text-mutating edit path must set `gitRef.dirty = true`** inside
   its `_mutateClipAtomic` and refresh `_updatePushAffordance()` +
   `_updatePushAllAffordance()`. This drives the entire unpushed-edits /
   push / conflict-guard system; a path that forgets it silently loses
   the user's sync safety net.
7. **Sentence-count-changing edits are serial.** Cut / combine / paste /
   type-to-split all share `_structuralEditInFlight` and drain
   `_renarrateQueue` first — audio splices operate on the previous splice's
   offset table. Route new structural edits through
   `_commitStructuralEdit` (1-in-N-out splice); never invent a parallel
   path.

## Verifying in the browser (the SW will lie to you)

The service worker serves cached JS under the old cache key, so an edit can
"verify" against stale code. Before trusting anything you see:

- unregister all SWs + `caches.delete(...)` + hard navigate, or fetch the
  file with `cache: "reload"`;
- confirm the LIVE function has your change:
  `someFn.toString().includes("newFragment")`;
- `node --check static/app.js` after every app.js edit (also sw.js).

The desktop Browser pane throttles hidden tabs: CSS transitions never
advance and screenshots time out unless the pane is fronted. Measure with
computed styles / `getAnimations()`, and disable transitions
(`* { transition: none !important; }`) when reading colors.

## Debugging

Read `DEBUG_PLAYBOOK.md` first for any "X behaves wrong" report; probe
before fixing. Users push client logs via Settings → Admin → Push debug
log → private repo `hypeman271-oss/narrative-debug-logs` (read with
`gh api`). Instrument new features with `_dlog(category, msg, payload)` so
the next report pins the bail point. Server side: `flyctl logs`; heartbeat
lines carry `jobs=` and `disk=` markers.

## Conventions

- Reuse the shared machinery: `_mutateClipAtomic` for clip writes,
  `_gitPushClip` for GitHub pushes, `_openGitCommitSheet` /
  `_openDirtyConflictSheet` dialog patterns, `splitSentencesClient` for
  sentence splitting, `_locateSentenceRange` for exact text offsets,
  `setStatus(msg, isError)` for user feedback.
- Comments explain WHY and carry the version tag (`// v4.NNN: …`) —
  match the existing density; app.js is the project's institutional
  memory.
- Commit messages: `type(scope): summary (v4.NNN)` with a body that
  explains cause → fix; end with the Claude co-author line.
- New backlog/design work goes in `BACKLOG.md` / `docs/*-design.md`;
  architecture in `ARCHITECTURE.md`; deploy details in `DEPLOY.md`.

## Definition of done

1. `node --check` passes on every edited JS file.
2. Verified against the LIVE code in the browser (fresh SW, see above),
   exercising the real feature — on every tier the change touches.
3. Console: **zero errors**.
4. `sw.js` cache bumped; committed with the version in the message;
   pulled --rebase and pushed to origin/main.
5. `jobs=0` confirmed, `flyctl deploy`, and the deployed `sw.js` version
   curl-verified.
