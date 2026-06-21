# Animated illustrations for narration — design spec

Goal: let authors layer **animation** over the narration so a book can play
like an animated storybook — Vooks-style, but **not locked to one technique**.
An author should be able to mix hand-drawn character animation, lightweight UI
motion, and video/canvas scenes in the same book, each cue firing at the right
moment in the read-along.

Core principle (see the **editor mockup in chat**): same posture as the sound
effects layer (`sound-effects-design.md`) — **keep animation as a separate,
cue-driven layer rendered at playback time, never baked into the TTS or the
page.** Voice, soundscape, and visuals stay independent so re-narration doesn't
lose animation, the listener can disable it (accessibility / reduced-motion),
and cues ride the timeline we already have (`sentenceOffsetsSec` /
`currentSentenceIndex`, anchored to stable `data-line-id`s).

This spec covers **all three animation tiers at once** (the chosen scope) under
one cue model, so an author never hits a wall where their content doesn't fit.

---

## 1. The three tiers (one cue model)

Every animation is a **cue** with a `kind`. The kinds differ only in how they
render; they share timing, anchoring, targeting, and persistence.

| Tier | `kind` | What it is | Author needs | Cost to build |
| --- | --- | --- | --- | --- |
| **UI effect** | `ui` | CSS-driven motion: fade, scale, slide, glow, highlight a word, swap a character expression (image swap via class) | Nothing — no art assets | **Low** (pure CSS/JS) |
| **Sprite** | `sprite` | Hand-drawn frame animation: cycle a sprite-sheet (walk, blink, gesture) | A sprite sheet (PNG) + frame map | **Medium** (sheet loader + frame cycler) |
| **Video / canvas** | `video` / `canvas` | A clip (MP4/WebM) or a canvas effect (rain, particles, parallax) layered behind/over the page | A video file, or a named built-in canvas effect | **Medium–High** (media layer + blend/layering) |

The **UI tier is the universal floor** — every author can use it with zero art
skill, and it exercises the entire pipeline (cue model → persistence → editor →
playback firing). Sprite and video sit on the same rails; they add a renderer,
not a new system. Building all three together means the data model, editor, and
playback loop are designed once for the general case instead of retrofitted.

---

## 2. The stage layer

Animation needs a surface to render onto, above the reading view. Introduce a
**stage**: a positioned layer that holds the page illustration plus animation
targets, sitting between the reading-view text and the player.

- Reuse the existing per-sentence image renderer (clips already carry
  `images: [...]`, rendered in the reading view — see `app.js` image renderer
  near the sentence spans). The stage is that image area, promoted to a
  container that can host animated targets.
- **Targets** are named elements inside the stage (e.g. `#char`, `#bg`,
  `.word-current`). A cue points at a target via a `target` selector. The
  current-word highlight target already exists (the karaoke highlight).
- **Reduced motion / disable:** the stage honors `prefers-reduced-motion` and a
  user toggle (mirror the SFX volume slider — `narrative.animEnabled`). With
  animation off, the stage shows the static illustration; the book is fully
  readable/listenable. This is a hard requirement, not a nicety.
- **Device tiers (consult `DEVICES.md` before building UI):** the stage renders
  in the reading view, which exists on phone / tablet / wide-desktop / Tauri.
  UI cues are cheap everywhere; sprite is fine everywhere; video/canvas should
  degrade on low-power phones (cap concurrent video layers, fall back to a
  static frame). Default the first build to wide-desktop + tablet, then verify
  phone before enabling there.

---

## 3. Cue data model

A new array on the clip, **parallel to `bookmarks` / `annotations` /
`soundCues`** (clip default shape at [app.js:1436](static/app.js:1436)):

```js
animationCues: [
  {
    id,                       // stable uuid
    kind,                     // 'ui' | 'sprite' | 'video' | 'canvas'
    startLineId,              // anchor to a sentence's data-line-id (stable across edits)
    endLineId,                // optional — for windowed/looping cues; else single-fire
    offsetMs: 0,              // fine offset from the line's start time
    target: '#char',          // selector within the stage
    // --- kind-specific payload ---
    ui:     { effect:'fade-in'|'scale'|'slide-up'|'glow'|'highlight'|'swap',
              durationMs:400, easing:'ease-out', swapTo:'/img/face-smile.png' },
    sprite: { sheetAssetId, frames:[0,1,2,3], fps:10, loop:false },
    video:  { assetId, layer:'bg'|'overlay'|'fg', durationMs, blend:'normal' },
    canvas: { effect:'rain'|'snow'|'particles'|'parallax', durationMs, params:{} },
  },
]
```

**Why anchor to `line_id`, not time:** sentences are stamped with
`data-line-id` ([app.js:16612](static/app.js:16612)); anchoring to the line (not a
raw second) keeps cues correct when the author edits text or re-narrates at a
different rate — same rationale as the `soundCues` design. Resolve `line_id →
time` at playback via `sentenceOffsetsSec`.

**Persistence:** `animationCues` lives on the clip in IndexedDB and survives
export/import, exactly like `bookmarks` and `annotations` (those already round-
trip — see [app.js:8432](static/app.js:8432)). No new server schema needed for the
cue data itself. (Asset *blobs* are a separate concern — §6.)

---

## 4. Playback firing engine

Mirror `_sfxTick()` ([app.js:9046](static/app.js:9046)) — a function called from the
existing playback tick (`timeupdate` → `highlightCurrentSentence`,
[app.js:33188](static/app.js:33188)). Add a sibling `_animTick()`:

- Resolve `idx = currentSentenceIndex(playerEl.currentTime)`.
- **Single-fire cues** (no `endLineId`): when playback crosses the cue's start
  line, fire once (run the CSS transition / start the sprite cycle / play the
  video). Track "already fired this pass" so a `timeupdate` storm doesn't
  re-trigger; reset fired-state on seek-backward and clip change.
- **Windowed cues** (`startLineId..endLineId`): active while inside the range
  (loops, persistent BG video, glow pulse) — same in/out logic as the SFX bed
  (`inside ? on : off`), with fade on the boundaries.
- **On pause / seek / `exitReadingView` / clip change:** stop sprites, pause
  video, ramp UI effects to rest, clear fired-state. (SFX already does this
  teardown — reuse the lifecycle hook.)

**Streaming-mode caveat (same as SFX):** the prototype targets the **combined-
MP3 timeline** first. Per-sentence streaming tracks time via `_streamElapsed` /
`_streamPlayhead` ([app.js:7585](static/app.js:7585)) — `_sfxTick` deliberately stays
silent there. Animation does the same: support combined-MP3 first, add the
streaming time source as a later increment. Call this out so it's a known gap,
not a surprise.

**Renderers (one per kind, behind a tiny dispatch):**
- `ui`: toggle a CSS class / set inline transform on `target`; for `swap`, set
  `img.src`. (This is the `tutorials.js` walkthrough vocabulary generalized —
  `.shown`/`.pressed` style class toggles already proven in the manual.)
- `sprite`: a frame cycler stepping `background-position` on `target` at `fps`
  (the demo in chat); preload the sheet.
- `video`: a pooled `<video>` in the stage layer at the chosen `layer`, with
  `blend` via `mix-blend-mode`; play/pause on cue.
- `canvas`: a small library of built-in effects (rain/snow/particles/parallax)
  drawing to a `<canvas>` in the stage; start/stop on cue.

---

## 5. Authoring UX (the editor)

Two modes (built in the **mockup in chat**), both writing the same
`animationCues`:

**Mode A — Hand-place (full control).** Reuse the per-sentence selection from
the annotate/bookmark flow: select a passage → "Add animation" → pick a tier
(sprite / UI / video) → configure (the type-specific config panel) → preview.
Cues render as colored markers on a mini timeline and as underlays in the
reading view (parallel to how annotations/bookmarks already render).

**Mode B — Auto-suggest (fast-track).** An LLM pass over the sentence text
proposes cues the author accepts/tweaks (§7): "walked" → sprite walk cycle;
"smiling" → expression swap; "the room" → background fade. This is additive —
it just emits candidate `animationCues` for review; the hand-place editor is the
ground truth.

**Reduced-motion preview:** the editor can toggle the stage's reduced-motion
state so authors see the static fallback their cues degrade to.

---

## 6. Assets + licensing

Animation assets are **mostly author-supplied** (their own art/video), which is
the easy licensing case — the author owns or licenses their material, same as
the cover art and per-sentence images they already upload. Two storage shapes:

1. **Author-uploaded** (sprite sheets, video clips): store as content-addressed
   blobs like the existing image/audio blob store (content-addressed, on the Fly
   volume) — dedup by sha256, reference by `assetId` from the cue. Survives
   export/import by bundling referenced blobs (as images already do).
2. **Bundled starter library** (optional, like `voices/` and `static/sfx/`):
   a small CC0 set of reusable sprites (blink, idle, generic walk) and canvas
   effects. **Same licensing bar as SFX** (`sound-effects-design.md` §3): because
   we *serve the raw files*, bundled assets must be **CC0** (commercial use, no
   attribution, redistribution OK). Built-in canvas effects (rain/particles) are
   our own code — no third-party license.

Record per bundled asset `{source, url, license, commercial:true,
attribution:""}`, mirroring the voice/SFX audit. Author-uploaded assets carry no
bundling concern (not redistributed by us).

---

## 7. AI assist (auto-suggest + generation)

Two distinct AI uses, both optional layers on the same cue model:

1. **Auto-suggest cues (Claude API):** a pass over the manuscript/sentence text
   detects action verbs, emotions, and scene shifts and proposes an
   `animationCues` sheet for author review — the "animation director,"
   analogous to the SFX auto-tagger. Pure text-in, cues-out; no asset
   generation. This is the cheapest, highest-leverage AI feature and works even
   for authors with zero art (it leans on the UI tier).
2. **Asset generation (image / video models):** generate sprite frames from a
   base character image (e.g. a smile/blink/walk set) or short scene videos.
   **Commercial-rights bar applies** (same as SFX §4): use providers that grant
   commercial rights to the output and keep a per-asset provenance record.
   Generated output we own has no "don't redistribute" clause, so it's safe to
   bundle. Treat as a later enhancement — author upload covers the base case.

---

## 8. Phasing (shippable increments)

Each phase is independently shippable and flag-gated until ready. "All three
tiers" is the *design* scope; the *build* still sequences to de-risk.

- **Phase 0 — Prototype (flag `?anim=1`):** the stage layer + `_animTick` +
  **one hard-coded UI cue** on a test clip (e.g. fade a badge in over a sentence
  range), combined-MP3 only, no editor, no persistence. Proves the firing loop
  rides the timeline correctly. (Exactly how SFX started — `_MVP_SFX_CUE`.)
- **Phase 1 — Cue model + persistence + UI tier:** real `animationCues` on the
  clip, export/import round-trip, the firing engine for `ui` cues, and the
  hand-place editor for UI effects. Universal (no assets), end-to-end.
- **Phase 2 — Sprite tier:** sprite-sheet upload (blob store) + frame cycler +
  editor config. Adds the renderer; the system is unchanged.
- **Phase 3 — Video / canvas tier:** media layer (pooled `<video>`, blend,
  layering) + built-in canvas effects, with phone degradation.
- **Phase 4 — Auto-suggest (Claude API):** the animation director proposes cue
  sheets; asset generation as a sub-step.

Each phase: bump the SW cache (`const CACHE` in `static/sw.js`), keep
`origin/main` current (two-agent rule — `INTEGRATION.md`), and verify across the
device tiers it touches (`DEVICES.md`).

---

## 9. Integration points (codebase)

- **Clip model:** add `animationCues: []` to the clip default
  ([app.js:1436](static/app.js:1436)); persists in IndexedDB; bundle referenced asset
  blobs in export like images.
- **Timeline map:** `currentSentenceIndex(time)` + `sentenceOffsetsSec`
  ([app.js:1572](static/app.js:1572)) — the time↔sentence source the highlight + SFX
  already use.
- **Anchoring:** `data-line-id` on sentence spans ([app.js:16612](static/app.js:16612)).
- **Firing hook:** sibling to `_sfxTick()` ([app.js:9046](static/app.js:9046)),
  called from the `timeupdate` tick ([app.js:33188](static/app.js:33188)).
- **Stage:** the reading-view per-sentence image area, promoted to a target
  container; honors `prefers-reduced-motion` + `narrative.animEnabled`.
- **Editor:** reuse the per-sentence selection from annotate/bookmark; render
  cue markers like annotations.
- **Class-toggle vocabulary:** generalize the proven `tutorials.js` walkthrough
  pattern (`.shown`/`.pressed`/transition classes) for the `ui` renderer.
- **Streaming gap:** `_streamElapsed` / `_streamPlayhead`
  ([app.js:7585](static/app.js:7585)) — combined-MP3 first, streaming later.

---

## 10. Open questions / risks

- **Streaming-mode timing:** as with SFX, per-sentence streaming needs the
  `_streamElapsed` time source wired in before animation works during live
  synth. Acceptable to defer (combined-MP3 covers saved clips).
- **Performance on phones:** multiple video layers + canvas effects can stutter
  on low-end devices — needs the degrade path (cap layers, static fallback) and
  real phone testing per `DEVICES.md`.
- **Editor complexity:** three tiers in one editor risks clutter — the mockup's
  tier-picker + per-tier config keeps it scoped, but watch the surface area.
- **Export size:** bundling sprite sheets / video into exported books inflates
  file size — may need an "export without media" option or external asset refs.
- **Accessibility:** reduced-motion + a hard disable are mandatory; verify the
  book is fully usable with animation off before shipping any tier.

---

## 11. Prototype status

Phases 0–2 shipped behind `?anim=1` (Settings → Mode → Animation toggle):
UI tier (highlight/glow/badge), sprite tier, and the full-page scene tier, all
authored from the standalone 🎬 Animate palette and rendered in the **scrolling
reading view**. Sheets live in a separate IndexedDB store (`anim_sheets`) so
they never bloat the clip's progress-save/sync (the audio-hitch fix).

---

## 12. Book-view rendering (the CONSUMER surface) — spec

**Strategic reframing.** Narrative is splitting into a paid **author** app
(compose books) and a free **consumer** app (read them); for consumers the
primary surface is **Book view** (paginated spreads), and "reading + images" is
the core experience. So animation rendering in Book view is *not* a follow-up —
it's the consumption product. Authors compose in the scrolling Author view
(current renderer); consumers read in Book view (this renderer). **Same cue
model, two renderers.**

**Current gap (verified).** The animation engine hooks ONLY `#reading-view`
(`_animInit`'s host). Book view renders none of the tiers today.

**What Book view already gives us (reuse, don't rebuild):**
- Pagination: `_bookViewPages` / `_bookSentenceToPage`; `_bookViewRenderSpread`
  builds `.book-page` slots (cover on spread 0; `ppr` = `_bookViewPagesPerSpread`
  = 1 phone / 2 desktop). `_bookSentenceSpans` = the spans on the visible spread.
- Sentence→spread mapping: `_bookViewSpreadOfSentence(idx, ppr)`.
- Narration sync: the highlight tick auto-flips to the active sentence's spread
  (unless user-pinned via `_bookViewUserPaged`) and `_bookViewApplyActive(idx)`
  marks the active span. That's the hook cues fire on.
- Cue model, sheet store, `_animResolveSheetUrl`, the page/sprite/badge render
  helpers — all shared.

**Per-tier mapping onto a spread:**
- **Full-page scene (the headline).** Discrete pages make this *easier* than the
  scrolling view — no sticky. For each `.book-page`, find the page cue (scene
  marker) covering that page's sentence range and fill the page's background +
  scrim; the page's text sits on top (live, highlightable). Per-page (a desktop
  2-page spread can show two scenes if a boundary falls mid-spread). This is
  **spread-static** — the page shows its scene the whole time you're on it, not
  per-sentence. Best for consumption.
- **Sprite / badge.** Overlay on the `.book-page` whose cued sentence is on that
  page. **Sentence-synced** — fire as narration reaches the line (reuse the
  active-sentence hook), so a character "performs" on its line.
- **Highlight / glow.** Augment `_bookViewApplyActive`'s `.active` span with the
  emphasis class.

**Firing model.** Spreads re-render **destructively** (`bookViewSpread.innerHTML
= ""`), so animation layers must be re-applied per render: add a hook
`_animApplyToSpread(spreadEl)` at the END of `_bookViewRenderSpread` that, for
each page, resolves the covering scene + on-page sprites/badges and injects the
layers. Sentence-synced cues additionally update from the highlight tick.

**Performance / audio (critical — this is the consumer surface).** Re-resolving
sheets from IndexedDB on every page flip would re-read + decode mid-listen and
hitch audio (same class of bug as before). So **preload + cache sheet object
URLs at clip load** (a per-clip `sheetId → objectURL` map, revoked on clip
change); spread renders just assign cached URLs. No IDB/decode at flip or
fire time.

**Phone vs desktop (`DEVICES.md`).** Desktop spread = 2 pages (up to 2 scenes);
phone = 1 page = 1 scene. Sprites/badges per page. Verify both tiers.

**Cover spread.** Spread 0's cover page keeps the cover art; scenes start on the
first text page.

**Honest constraints.** Destructive re-render + the page-flip clone overlay
(`book-page-flipping`) interplay; objectURL lifecycle across flips; reduced-
motion + hard-disable still mandatory; the scrolling-view engine assumes
persistent spans, Book view does not — so the Book-view renderer is a sibling,
not a reuse of `_animInit`.

**Build phases:** (a) full-page scene per spread (consumer headline) →
(b) sprite/badge/highlight per spread → (c) preload cache + phone/desktop
polish. Flag-gated until ready; bump SW; verify both device tiers.

### 12a. AS-BUILT — Phase (a) full-page scene (v4.134, SHIPPED)

The spec above assumed the legacy `_bookViewRenderSpread` / `_bookViewPages` /
`.book-page` renderer. **Reality: V3 is the default Book-view paginator**
(`_bookViewV3Enabled()` defaults true; `?bookviewv3=0` kills it). V3 differs in
three ways that changed the integration:

- **Pages are `.book-view-page` (with `.book-view-page-body`), not `.book-page`.**
  V3 stamps `page.dataset.textPageIdx` in `closeTextPage` and populates the
  shared `_bookSentenceToPage[]` (sentence idx → text-page idx). Legacy
  `_bookViewPages` is empty under V3 — do NOT rely on it.
- **V3 builds ALL pages once in `_bookViewV3Setup`, then *slides* between
  spreads** (translateX) — it does NOT re-render per flip. So the scene hook is
  applied **once at the end of `_bookViewV3Setup`** (before `_bookViewV3GotoSpread(0)`),
  not per-spread. (The legacy `_bookViewRenderSpread` also got the hook for the
  kill-switch path; harmless.)
- **`_animApplyToSpreadScenes()`** (app.js) targets
  `.book-view-page[data-text-page-idx], .book-page[data-text-page-idx]`,
  derives each page's first sentence from `_bookSentenceToPage`, picks the
  scene-marker page cue with the largest start ≤ that sentence, and injects
  `.anim-book-scene` (`.anim-book-scene-bg` + `.anim-book-scene-scrim`) as the
  page's first child. The page's body/footer are lifted above via
  `.book-page--scene > *:not(.anim-book-scene){z-index:1}`. Still images get the
  shared `.anim-page-bg--kenburns` drift; **sprite-source scenes now loop**
  (v4.135) via per-scene tickers (`_animBookSpriteStart`/`_animBookSpriteStopAll`)
  that step `background-position-x` (strip scaled to N page-widths, percentage
  trick — mirrors `_animPagePlay`). Cheap (cached URL, no IDB), reduced-motion
  freezes on frame 0, timers torn down on re-apply + in `exitBookView`.

**Audio safety (built):** preload + cache `sheetId → objectURL` at clip load
(`_animSheetUrlCache`, `_animClearSheetCache`, `_animPreloadSheets` in
`_animLoadCues`; re-preload after `_animMigrateLegacySheets`). The book-scene
renderer reads ONLY the cache (cache miss → skip; `_animPreloadSheets` re-applies
scenes when it lands). `_animResolveSheetUrl` now prefers the cache too, so the
scrolling-view sprite/page fire no longer reads IndexedDB at fire time either.
Verified: scene renders behind readable text in V3 Book view; audio advanced
0→4.37s smoothly during playback with the scene up.

**Still pending:** (b) sprite/badge/highlight per page in Book view;
(c) phone (1-page) tier verification. (Sprite-loop full-page in Book view —
done v4.135, verified: 4-frame strip cycled 0/33/66/100% in V3 Book view.)

---

## 13. Prototype status (original — superseded by §11)

This doc began as a pre-build spec; §11 records what actually shipped.
