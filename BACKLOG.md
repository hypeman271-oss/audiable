# Narrative — Backlog

Living document of features and improvements that have been discussed but not
built. When an idea surfaces that's worth keeping but isn't worth doing right
now, capture it here so the reasoning isn't lost and the next iteration has
context to start from.

**See also: [`STRATEGY.md`](./STRATEGY.md)** — once a feature here becomes a
V1 launch differentiator (LLM dialogue detection, chapter auto-split,
filler-word callouts, long-sentence highlighter, voice favorites, listen
statistics, etc.), it's worth re-checking against the launch checklist there.

Entries are roughly ordered by likely value, not chronologically. Each one
should be self-contained enough that picking it up months later doesn't
require re-deriving the analysis.

---

## 1. Character voice detection — better than today's rules

**Triggered by:** Conversation while using Narrative to revise dialogue in a
novel. The author asked how hard it would be to make the app auto-detect
which character is speaking each line.

**Status:** Future work. Not blocking; today's rules-based approach is
shipped and works on simple patterns. Worth revisiting once there's a
clear payoff (a chapter that mostly fails detection).

**Priority:** Medium. Writers iterating on dialogue would feel the
improvement; readers consuming articles don't care.

### What's shipped today

`segmentTextByCharacter()` in `static/app.js`. For each sentence:

- If the sentence contains a quote (`"…"`, `"…"`, `'…'`) **and** a character's
  name appears as a whole word anywhere in the sentence → that sentence is
  attributed to that character.
- Otherwise → narration (fallback voice).
- Consecutive sentences with the same speaker collapse into one segment.

Catches:

- `"Hello," John said.`
- `John said, "Hello."`
- `"Hello." John walked away.`

Misses:

- Pronoun-only attribution (`"How are you?" she asked.`)
- Multi-sentence dialogue from one speaker
- Implicit continuation across sentences
- Free indirect speech
- Action-based attribution without said-tags (`Sarah shrugged. "Whatever."`)

In typical fiction, this resolves maybe **50–60%** of attributed dialogue,
less for first-person / close-third prose dominated by pronouns.

### The improvement gradient

#### Tier 1 — Last-named-speaker + paragraph-aware ~~(deferred)~~ shipped in v62

Single-evening addition. Heuristic:

- Maintain a "last named speaker" cursor while walking sentences.
- When a sentence has a quote but only a pronoun attribution, attribute to
  the last named speaker.
- Reset the cursor on paragraph breaks (standard fiction convention:
  new paragraph + opening quote = new speaker).
- Multi-sentence quotes from one speaker inherit attribution from the
  previous sentence as long as no other named speaker has appeared.

Expected accuracy: **~75–80%** on standard fiction.

Code: ~60 lines on top of the existing function. Pure JS, no backend
changes. Could ship in a single iteration.

**Shipped in v62.** Paragraphs split on `\n\s*\n+`; cursor lives in the
inner-paragraph scope so it resets at every break. Cursor updates on
any sentence that names a character (narration counts — establishing
"John walked in" lets the next "He said hello" inherit). Quoted
sentences without an explicit name inherit the cursor whether
attribution is pronoun-based or a continuation quote — no separate
gate. Fallback to narrator when the cursor is null. Roster order
breaks ties when two names appear in one sentence.

#### Tier 2 — Gender-aware pronouns ~~(deferred)~~ shipped in v65

Small addition on top of Tier 1. Add an optional `gender` field
(`"male" | "female" | "they"`) to each character row in the Characters
dialog. When resolving `she said`, only match against female characters
in scope; same for `he` / `they`.

Handles two-character scenes where attribution is mostly pronouns
(typical for novel dialogue) as long as the speakers aren't the same
gender.

Expected accuracy combined with Tier 1: **~85%**.

UI cost: one extra column in the Characters dialog. Maybe one evening on
top of Tier 1, so two evenings total.

**Shipped in v65.** Schema gains `character.gender` ("" / "male" /
"female" / "they"). Characters dialog gets a compact `<select>` between
name and voice (— / He / She / They); mobile layout drops the field
onto its own row. The segmenter maintains `lastByGender = {male,
female, they}` alongside the Tier 1 `lastNamedChar`; both reset at
paragraph boundaries. Quoted sentences without explicit names call
`_detectAttributionGender()` — which strips `"..." / '...' / "..." /
'...'` quoted spans BEFORE scanning so pronouns inside the dialogue
content don't pollute attribution. Pronoun resolution tries the
gender map first, then falls back to Tier 1, then narrator.

#### Tier 3 — Real coreference resolution (spaCy / neuralcoref)

Significant. Requires either spaCy + neuralcoref or similar real NLP
pipeline. Adds ~500 MB to the Python dependency footprint. Accuracy on
news text is good (~90%) but on novel prose it drops because the models
weren't trained on fiction conventions.

**My instinct: skip this tier.** The dependency cost is high and the
accuracy gain over Tier 1+2 isn't worth it for fiction prose
specifically. If you want better than Tier 1+2, jump to Tier 4.

#### Tier 4 — LLM-based attribution

Send the chapter to an LLM (Claude, GPT-4, or a local model) with a
structured prompt:

> Tag each sentence with the speaker character from this list:
> [Sarah, John, Marcus]. Use "narrator" for prose. Output JSON.

Modern frontier models do this at **~95–98% accuracy** on most fiction,
including the tricky cases — free indirect speech, ambiguous
attribution, complex multi-character scenes.

Tradeoffs:

- Cost: ~$0.01–0.05 per chapter (cheap, but real, recurring)
- API key configuration in Settings
- Latency: 5–30 seconds per chapter
- Privacy: manuscript leaves the local machine

Implementation: new endpoint `/api/segments/llm` that calls the LLM
provider, returns segmented text. Settings dialog grows with provider
configuration (provider, model, API key). Characters dialog gets a
"Use AI dialogue detection" toggle.

### Recommended path when revisiting

1. **Ship Tier 1 first.** Highest accuracy-per-line-of-code ratio. The
   user feels the improvement immediately on their real chapters.
2. **Add Tier 2 if pronouns still mangle things** in their typical
   scenes. Trivial addition once Tier 1 is in.
3. **Skip Tier 3.**
4. **Add Tier 4 as an opt-in "Re-analyze with AI" button** in the
   Characters dialog. Best of both: fast/cheap rules for the common
   case, accurate LLM for tricky chapters. The toggle ships behind
   Author mode + requires API key configuration; defaults off.

### What no detection improvement can fix

- **Ambiguity that a human reader would also struggle with.** If the
  prose is genuinely unclear about who's speaking, no system will
  guess right — the fix is in the prose, not the model.
- **TTS register limits.** Each character's assigned voice has one
  register. A character whispering and the same character shouting
  come out identical from any TTS engine. Worth flagging because users
  often expect this to be a detection problem when it's actually a
  fundamental TTS limit.

---

## 2. Other deferred ideas

Shorter notes on features that have surfaced in conversation but
weren't built. Roughly grouped.

### Considered and intentionally deferred

- **Preview translation across voice languages.** Question: "Can we
  translate the preview text into each voice's language so a German
  voice speaks the German translation of my English text?" Three viable
  paths surfaced:
  - LibreTranslate public API — 2 hrs to ship, free, rate-limited,
    manuscript leaves the server.
  - DeepL API — 2 hrs, best quality, 500K char/mo free tier, secret
    needed, manuscript leaves the server.
  - Self-hosted LibreTranslate — 4 hrs + Fly volume upgrade (3 GB image
    won't fit free tier), in-house only.

  Decision (v61 era): **skip it.** The Language filter shipped in v58
  already lets a single-language author narrow the catalog to their
  language and ignore the rest. Translation only earns its complexity
  for multilingual authors or for non-English users auditioning English
  voices — neither is in the current alpha audience. Revisit if a
  tester actually asks for it.

### Author mode features

- ~~**Filler-word callout.**~~ Shipped in v52. Chip strip below the
  textarea meta line; one pill per crutch word with `word N` (count
  bolded), top-8 by frequency, sorted desc then alphabetical for
  stability. Counter uses one pre-built regex with `\b…\b` word
  boundaries; multi-word entries ("kind of", "sort of") tolerate any
  internal whitespace. Re-counts inside `updateCounts()` so it updates
  live with typing. CSS gated by `.author-only` so readers never see it;
  hidden during reading view and restored on `exitReadingView`.
- ~~**Long-sentence highlighter.**~~ Shipped in v51. Sentences with
  word count ≥ 35 (computed at enterReadingView time using the same
  splitter as the textarea meta) get `data-long-sentence="true"` and a
  `title` showing the exact count. CSS gated by
  `body[data-author-mode]` so readers never see it. The `--long-sentence-tint`
  token differs per theme (soft amber on dark, more saturated orange on
  light). Rule precedence puts the `.active` karaoke highlight after
  long-sentence so the accent wins during read-along.
- ~~**Chapter auto-split on paste.**~~ Shipped in v47. Paste / URL fetch /
  file upload all run `_detectChapters(text)`; two pattern families
  (markdown ATX headings and `Chapter|Part|Book|Section N` line starts
  with optional subtitle). A 2+ hit count surfaces a banner under the
  textarea — Split loads chapter 1 + queues the rest. `generate()`
  reads `_pendingChapterTitle`; on save, `_advanceChapterQueue()` loads
  the next chapter and auto-fires generate(). Pill near the textarea
  shows "Chapter 3 of 5 · Next: '…'" with × to cancel after the current
  chapter. Clear button also cancels the queue.

### Voice browser polish

- ~~**LibriTTS speaker audition wizard.**~~ Shipped in v70. New
  "Audition" link-btn in the speaker row opens a paged dialog (6
  speakers per page). Each row: Speaker N · ▶ play · ★ star · Use.
  ▶ plays the existing `/api/voices/sample/{id}?speaker=N` proxy
  sample. ★ persists in `narrative.speakerFavorites = {voiceId: [ids]}`
  per-voice so multiple multi-speaker voices keep separate shortlists.
  "Use" sets `speakerEl.value` + dispatches change so the main app
  picks up the choice. "★ Starred only" filter chip flips between
  the full 904-range and the starred subset (with empty-state copy
  when no stars yet). Prev / Next page disabled at the edges. The
  ranked-by-listen-count and curated "community favorites" ideas
  are NOT shipped — useful future additions but require data the
  Piper community would need to surface.
- ~~**Voice favorites.**~~ Shipped in v50. ★/☆ button on every catalog
  row toggles; favorites persisted as an ordered array in
  `narrative.voiceFavorites` (most-recently starred at top). Browser
  gets a "★ Favorites only" filter chip with live count and empty-state
  copy. Main voice `<select>` now opens with a "★ Favorites" optgroup
  at the top when any are starred. Star toggle re-fetches voices and
  preserves the current selection so a click doesn't yank the user
  off the voice they're on.
- ~~**Custom preview text.**~~ Shipped in v56. Slim pill input above
  the catalog ("Optional: paste your own text to preview…", 300 char
  cap, Clear button when populated). When non-empty, every ▶ in the
  catalog routes through `/api/synthesize` instead of the static
  `/api/voices/sample/{id}` proxy — auditions YOUR text in each voice.
  Empty input keeps the original canned-sample fast path. Object URLs
  revoked on stop so blobs don't leak. Multi-speaker voices preview
  with speaker 0 (per-voice browsing is about the voice family, not the
  speaker — that picker lives elsewhere). Custom text is preserved
  across browser opens so you don't retype your manuscript snippet.

### Library / playback

- ~~**Listen statistics.**~~ Shipped in v49. Stats panel inside Settings:
  Today / This week / All-time + top voice + most-listened clip + Reset
  button (tap-twice-to-confirm, no native dialog). Accumulator hooks
  player play/pause/seeking/timeupdate; sane-delta gate (0 < dt < 2 sec)
  so seeks and tab-throttling don't bloat counters. localStorage flushed
  every 10 s + on pause + on beforeunload/pagehide. Daily buckets pruned
  past 60 days; voices/clips/total are cumulative. Words listened
  intentionally skipped — adds little signal over time, and the implicit
  "content time" semantics (1.5× plays count as content seconds, not
  wall-clock) is more meaningful anyway.
- ~~**Theme toggle (light mode).**~~ Shipped in v46 (Settings → Theme:
  Auto / Dark / Light). Semantic CSS tokens swap on
  `:root[data-theme="light"]`; inline boot script in index.html applies
  the saved choice before paint to prevent dark-flash on light testers;
  applyTheme also patches the OS theme-color meta so the status bar
  matches.
- **Per-clip notes that sync with audio time.** Already have bookmarks,
  but a flat "notes" panel per clip (longer than a one-line bookmark
  note, separate from the title's overall note field) could be useful
  for chapter-level reflection while listening.

### Tunnel / phone polish

- **Named-tunnel setup wizard.** `scripts/tunnel.py --name` works today
  if you've manually done `cloudflared tunnel login + create +
  route dns`. A guided setup script that walks through those one-time
  commands and prints success messages along the way would lower the
  bar for non-DevOps users.
- **Tunnel auth via URL fragment.** Currently `NARRATIVE_KEY` requires
  pasting into a prompt the first time on each device. Alternative:
  baking it into the URL as `https://…/#key=…` and the frontend reads
  it from `location.hash`. Less secure than the prompt model
  (key visible in URL bar / history) but a much smoother one-tap
  install flow for sharing the tunnel with collaborators.

### Manual / docs

- ~~**Real screenshots.**~~ Solved differently in v53: instead of swapping
  hand-drawn SVGs for PNGs, we swapped them for *real component markup*
  using the actual app's CSS classes (`.catalog-voice`, `.player-actions`,
  `.bookmark-row`, `.clip.current`, `.character-row`). Wrapped in
  `.manual-demo` (pointer-events:none, framed). Net effect: the manual's
  illustrations now look pixel-identical to the live app, follow the
  Light theme automatically, and pick up new chips (skip-forward, ★)
  whenever the app evolves — no PNG regeneration ever.
- ~~**"What's new" log.**~~ Shipped in v66. Standalone `whats-new.html`
  styled with the manual's CSS; entries grouped by version range
  (newest gets accent-tinted highlight). Settings dialog gains a
  "What's new →" link with a "NEW" pill that hangs off it until the
  user opens the changelog. Acknowledgement tracked in
  `narrative.lastSeenWhatsNew` (integer = cache version); bumping
  `WHATS_NEW_LATEST` in app.js automatically lights up the badge on
  next Settings open for every existing tester.

### Quality-of-life

- ~~**Basic / Simple mode.**~~ Shipped in v76. Replaced the boolean
  Author toggle with a three-tier UI mode picker (Simple / Standard /
  Author) in Settings — same shape as the Theme picker. Body gets
  `data-ui-mode=` attr. Two CSS gates do the work:
  `body[data-ui-mode="author"] .author-only` reveals writing-craft
  features; `body[data-ui-mode="simple"] .advanced-only { display:
  none !important }` hides power-user chrome. Marked `.advanced-only`:
  Sleep / A↔B / Bookmark / Speed player chips; bookmark list; library
  tools row (Export / Import / Hide played / Select); play-mode +
  Clear all in the library header; Listen stats panel; Save preset;
  Speaker Audition button; Re-narrate banner; drag handles. One-time
  migration from `narrative.authorMode === "true"` carries existing
  Author testers directly to mode "author"; otherwise default is
  "standard" (preserves prior reader-focused default).
- ~~**Re-narrate loaded clip with new voice.**~~ Shipped in v73.
  Voice is baked into the audio at synthesis, so there's no live
  voice switch. Instead: when the user picks a different voice
  while a clip is loaded, a banner appears offering to re-synthesize
  the loaded clip in the new voice. Confirm fires the existing
  `_regenTargetClipId` path (same as Save-text auto-regen) so the
  new audio replaces the old blob in place; bookmarks/title carry
  through. Dismiss keeps the picker change as default for next
  Generate. Per-clip dismiss tracker so toggling between voices on
  the same clip doesn't keep re-prompting after the user said no.

- ~~**5-second skip-forward**~~ Shipped in v48. Mirrors the existing
  ↶5s back chip; shares CSS via grouped selectors. Handler uses the
  same virtualTime + seekToTime path so it works in both streaming and
  combined-WAV modes; seekToTime's existing duration clamp handles
  overshoot at the end of a clip.
- ~~**Auto-pause on phone call / notification.**~~ Shipped in v72.
  Tracks "external" vs "user-initiated" pauses by checking
  `document.visibilityState` at the pause moment: hidden → call /
  notification / lock interrupt; visible → user clicked the native
  audio bar. JS-initiated pauses (sleep timer expiry, mini-player
  button, MediaSession lock-screen pause / stop) route through a
  `_pauseAsUser()` helper that suppresses the external flag so they
  don't get misread. visibilitychange to visible re-fires play() when
  the flag is set, with a swallowed catch for browsers that block
  unattended resume.
- ~~**Bulk library operations.**~~ Shipped in v67. "Select" link in
  the library-tools row flips renderLibrary into multi-select mode:
  drag-handle slot becomes a `☐ / ☑` checkbox, tapping the card
  toggles the selection (instead of loading the clip), per-clip
  reset/edit/delete buttons hide. Tools row swaps to
  `Cancel · Select all · Export N · Delete N` with live counts.
  "Select all" picks every clip currently rendered (respects the
  active search / hide-played filter, since it reads the DOM). Bulk
  delete uses tap-twice-to-confirm (3 sec armed window, same pattern
  as Reset stats) so a single misclick can't wipe a chapter run.
  Bulk export reuses the existing exportLibrary with a new optional
  `idsFilter` Set — manifest + zip only contain selected clips,
  presets + libraryOrder still travel along for portability.

### Tools that aren't features but would help maintenance

- ~~**End-to-end Playwright tests.**~~ Shipped in v71. `package.json`
  + `playwright.config.js` at the repo root spin up a dedicated
  `python server.py` on port 8001 with `NARRATIVE_KEY=""` so /api/* is
  open. `tests/e2e/smoke.spec.js` covers the headline path: paste →
  Generate → wait for player → verify library → reload → click → drop
  bookmark → delete. `tests/e2e/regression.spec.js` pins the specific
  bugs that have already broken once (mailto encoding from v62,
  voice-id prefix from v57, theme persistence from v46, speaker
  dropdown threshold from v71). Each regression test names the
  version it guards so a future failure points at the relevant
  commit. `tests/README.md` documents install + run. .dockerignore
  excludes Node artifacts so the Fly image stays Python-only.
- **Bundle size budget.** `app.js` is now ~70 KB. Worth periodic
  review to catch accidental copies, dead code, etc.

---

## How to use this file

When an idea worth keeping surfaces during use:

1. Add a new entry above with the trigger, current state if relevant,
   and the analysis.
2. If the entry duplicates a "deferred ideas" line, promote it to a
   full entry with the new context.
3. When picking up an entry to build, leave a one-line note at the top
   of the entry pointing at the resulting commit / PR / chapter mark,
   so future-you can trace it.
