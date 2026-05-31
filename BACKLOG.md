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

## 2. Book preview / magazine spread view

**Triggered by:** Author showed two reference images while drafting —
a New Yorker "Summer Preview" magazine spread (illustrated columns,
serif body, drop caps, page numbers) and a vintage book introduction
spread from a fables collection (single-column serif, justified, em-spaced
margins, classic novel typesetting). Asked: "what do you think about a
feature so we can see our book like this?" Explicitly deferred — not
now, but worth keeping warm. Saved 2026-05-29.

**Status:** In progress — v185 (Milestone 1, foundation) shipping
2026-05-30. Author committed to the polished 2-3-evening track over
the MVP after revisiting. Milestone 1 ships the book-layout
foundation; Milestone 2 layers drop caps + running headers + page
numbers + font-size control + print stylesheet; Milestone 3 adds the
magazine layout + theme variants + inline-image flow.

**Priority:** Medium. Delightful and on-thesis (Narrative as the place
where a manuscript becomes a finished artifact in two modalities — audio
and visual), but not a launch-blocker. Authors already have Vellum /
Atticus / InDesign for real typesetting; we'd be making a *preview*,
not a publishing tool.

### The two flavors worth distinguishing

The reference images split cleanly into two layout families. A single
toggle in the proposed view gives both:

1. **Book spread** (vintage-novel reference). Single column per page,
   serif body, justified text, drop cap at chapter opening, running
   headers (chapter title / page number), classic margins. Best for
   fiction. ~250–400 words per page depending on font size.
2. **Magazine spread** (New Yorker reference). Two columns per page,
   tighter leading, sidebars/callouts allowed, illustration-friendly
   gutters. Best for essays / non-fiction / shorter pieces.

Both render as a two-page open spread on desktop/tablet, single page on
mobile (the spread doesn't survive the narrow viewport).

### The unique-to-Narrative angle

The reason this isn't just a worse Vellum: pair it with the listening
flow. As audio plays, the current sentence highlights in the rendered
book spread the same way it already highlights in the reading view.
Neither Audible nor Vellum does this. It turns the spread into a
follow-along reading experience — useful for authors editing pacing,
useful for users who want to read-and-listen simultaneously.

### Implementation paths (rough)

**Minimum viable (~1 evening):**

- New `book-view.html` (or a mode flip on the reading view).
- Single layout: book spread, one theme.
- CSS columns + `column-fill: auto` over a fixed-height container to
  approximate pagination — no real page-break math. Words land where
  they land.
- Cover image as the first "page" (left), text starts on the right.
- Karaoke highlight piggybacks on existing `data-sentence-idx` markup.
- Toggle button: 📖 / ▶ to switch between book view and the audio
  player.

**Polished (~2–3 evenings):**

- Both layouts (Book / Magazine), toggle in the view header.
- Real pagination with [paged.js](https://pagedjs.org/) or hand-rolled
  measurement — break on sentence boundaries, never mid-sentence.
- Drop caps at chapter openings (the clip title becomes the chapter
  heading).
- Running headers / footers with page numbers.
- Theme variants: modern book / vintage book / magazine / manuscript
  (typewriter face for early drafts).
- Click a sentence → seek audio to that timestamp.
- Inline images (from URL fetches that pull illustrations — already
  shipped in v85+) flow into the layout.

### Risks / what to be honest about

- **Scope creep.** Real book typesetting is a career. Vellum's entire
  business is "format your manuscript." Our value here is preview +
  follow-along, not export-ready output. Stay disciplined about that
  framing or this swallows weeks.
- **Identity drift.** Narrative is audio-first. A visual book view is
  legitimately new surface area. If we ship it, the pitch needs to
  evolve from "type, listen, download" to something like "type, see,
  listen, download" — which might dilute the audio thesis if framed
  wrong. Frame it as a *companion view to the audio*, not a replacement.
- **Pagination edge cases.** Images mid-paragraph, em-dashes at column
  breaks, dialogue runs, footnotes. The MVP can punt on most of these
  by using CSS columns and accepting some ugliness; the polished
  version needs real layout work.
- **Mobile.** A two-page spread does not survive at 375px wide. Fall
  back to a single column / single page on mobile and call it done.
- **Bundle.** paged.js is ~150 KB. Hand-rolled pagination is
  cheaper but takes longer to write. CSS-columns-only MVP avoids both.

### Recommended path when revisiting

1. **Ship the minimum viable first** — single book layout, CSS
   columns, cover-on-the-left, sentence highlight tied to audio. One
   evening. Get the gut-check: does the author actually use it once
   it exists, or is it a one-time wow?
2. **If they use it**, add the magazine layout + real pagination next.
3. **If they don't**, leave it as a curiosity. The cover-upload work
   already pays off in the library tint and page backdrop; we don't
   need this to justify that effort.
4. **Never bill it as a publishing tool.** Export to real EPUB / PDF
   is a different product (and probably a partnership / integration
   with one of the existing typesetting tools, not a thing we build).

### Adjacent things that fall out of this

- **Read-along view** (text + audio sync) is a real first-class
  feature regardless of whether the spread layout ships. Could be
  extracted earlier as a simpler "follow along while listening"
  mode without the book chrome.
- **Chapter cover sequence as a flip-book.** Once chapters all have
  cover art, the library could offer a "browse covers" view that
  flips through the story-board.

---

## 3. Other deferred ideas

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

## 4. Per-line WAV export for animation pipelines

**Triggered by:** Author / animator asked whether Narrative could replace
ElevenLabs for animation voice work after the v217 commercial-licensing
audit. The license + provenance pieces (v217 + v219) are in place; what's
missing is the *export shape* an animation pipeline actually consumes.

**Status:** Future work. Task #354. The Characters feature + the
`/api/synthesize/segments/stream` endpoint already produce per-segment
audio internally — we just don't expose them as standalone files.

**Priority:** Medium. Unblocks "Narrative for animators" as a real use
case (not just incidental fit). Lifts Narrative from "novel-only" to
"any voice-line workflow," which matters for the SaaS positioning.

### What's shipped today

- Generate combines all sentences into one MP3 per clip.
- Download button gives the user that one MP3.
- The server *can* stream per-sentence WAVs via
  `/api/synthesize/segments/stream` (used for the Characters feature),
  but the frontend assembles them into the combined MP3 before exposing.

### What animators actually want

- One short WAV per line of dialogue, named predictably
  (`chapter01-line0042-bob.wav`)
- A JSON manifest mapping `{lineIndex → text → speaker → startSec
  → endSec → durationSec}` so they can drop the WAVs on a timeline
  with positions pre-computed
- (Optional, much later) Phoneme-level timing data for lip sync, or
  at least a one-click "run Rhubarb Lip Sync on this and produce a
  mouth-shape track" affordance

### Proposed shape

A new "Export per-line WAVs" action in the library card menu (or in
the Edit dialog) that:

1. Re-runs the clip's text through `/api/synthesize/segments/stream`
   with `output_format=wav` (server already has the WAV path internally
   pre-MP3-encode — expose it).
2. Streams one WAV per sentence + per character (already segmented
   when Characters are configured).
3. Packs into a zip: `audio/0001.wav`, `audio/0002.wav`, …,
   `manifest.json`, `transcript.txt` (one line per WAV).
4. Manifest schema mirrors the in-zip filenames + adds metadata:
   `{ schema: 1, source: clipTitle, voiceProvenance: clip.provenance,
   lines: [{ idx, file, text, voice, speaker, startSec, endSec }] }`.

Reuses the existing zip writer (`makeZip()` in app.js) and the
segments SSE endpoint. New code is small: a server flag for WAV
passthrough + a client action that drains segments to a zip.

### Stretch (later)

- "Export with Rhubarb mouth shapes" — calls Rhubarb Lip Sync on each
  WAV server-side, includes the resulting JSON in the zip.
- Re-take loop: generate N variations of a single line, let the user
  pick before bundling.
- Animation-specific cover-art: per-clip "scene reference" image that
  travels with the export.

### Why this fits Narrative's positioning

Today's TTS animation pipeline: ElevenLabs ($22+/mo + per-character
overage + uncertain licensing on cloned voices) → per-line export
→ Premiere/Toon Boom. With this feature, Narrative replaces step 1
with: open-license voices + per-line export + provenance baked in,
for a one-time cost. The audience is small (indie animators) but
high-affinity and overlaps with the indie-author audience.

---

## 5. Qwen3-TTS as a second engine — GPU-tier quality voices

**Triggered by:** Mid-audition for the novel narrator (Piper/VCTK/Jenny),
author asked whether Qwen3-TTS was an option. Research confirmed it
shipped Jan 22 2026 under Apache 2.0 — the cleanest commercial license
open-source TTS has produced so far. Quality reportedly competitive with
ElevenLabs.

**Status:** Future work. Task #358. Significant — not a small follow-on
to v217-v219; a meaningful new engine alongside Piper. Wait until
v220 ships and the Tauri scaffolding (#213) is far enough along to
know whether desktop-only or cloud-GPU is the right deploy story.

**Priority:** High *strategically*, medium *tactically*. This is the
ElevenLabs-killer angle — Apache 2.0 voices with cloning, no per-month
fee, owned forever. It's also a big enough build that doing it before
the SaaS basics (Stripe, landing page, license-key validation) ship
would be premature.

### What Qwen3-TTS is

- Open-source TTS family from Alibaba's Qwen team
- 0.6B and 1.7B parameter sizes
- 10 languages including English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian, Chinese
- Voice cloning from a short reference audio clip
- 49 stock voices
- Released January 22, 2026
- License: **Apache 2.0** — full commercial use, no attribution required, no field-of-use restrictions
- Repo: <https://github.com/QwenLM/Qwen3-TTS>
- HuggingFace: <https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base>
  and <https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice>

### Architectural fit vs Piper

| | Piper (today) | Qwen3-TTS |
|---|---|---|
| Model size | 50–130 MB | 1–4 GB |
| Inference HW | CPU, real-time | GPU required for practical speed |
| Latency | < 1× real-time on CPU | depends on GPU; claimed 97ms ultra-low |
| Voice cloning | none | yes, from reference audio |
| License | per-voice (CC BY 4.0 if green) | Apache 2.0 uniform |
| Self-host story | tiny VM, $5/mo Fly | needs GPU machine ($0.50-$2/hr) |

The architectural divergence is the issue. Narrative's current
deploy story is "cheap always-on CPU VM"; Qwen3-TTS breaks that.

### Two viable deploy stories

**A. Local-only via Tauri build (#213).** Ship Qwen3-TTS as a
desktop-installer feature. User brings their own GPU (Apple Silicon
M-series, or NVIDIA RTX). Tauri downloads the model on first launch.
Generated audio never leaves the user's machine. Aligns with the
"own your voices forever" pitch.

**B. SaaS Pro tier on a GPU machine.** Fly has GPU machines (A10/L4
at ~$0.50-$2/hr). Wire it as a paid tier — `Pro` ($X/mo) gets access
to Qwen3-TTS voices in addition to Piper. Auto-stop the GPU machine
between requests (the v204 keepalive work makes this safer now).
Higher infra cost but a clearer value ladder.

The two aren't exclusive: ship A first (local-only Qwen3-TTS in the
desktop installer), validate demand, then build B if the cloud-GPU
economics work.

### Implementation sketch (high level — refine when picked up)

1. **New engine module** `tts/qwen3.py` (alongside `tts/piper_engine.py`
   and `tts/sapi.py`). Implements the same `synthesize_iter()` +
   `list_voices()` shape so the dispatcher stays uniform.
2. **Voice id prefix**: `qwen3:` (mirrors `piper:`).
3. **Backend dispatch** in `server.py` routes voice ids by prefix —
   no change needed beyond adding a case.
4. **Voice cloning UX**: a new "Clone a voice" action in the voice
   browser. Upload a 5-30s reference audio → server generates a
   speaker embedding → custom voice saved + appears in the picker.
   Provenance (v219) captures the cloning source + a consent
   checkbox the user has to tick.
5. **License audit** (mirror of v217 for Piper voices). Apache 2.0
   on the model release covers a lot, but the training-data
   provenance is a separate question — pull the Qwen3-TTS model
   card / paper and confirm what dataset their stock voices were
   trained on. If any of the 49 stock voices were trained on
   unlicensed-celebrity / dubious data, flag them like we flag
   Lessac-finetuned Piper voices.
6. **Consent UX for cloning**: a checkbox the user has to tick
   confirming they have the right to clone the voice in the
   reference audio. Stored on the resulting voice's provenance
   record so a future audit can confirm.

### Open questions

- **Real quality test**: marketing says "beats ElevenLabs." Needs
  blind A/B against ElevenLabs Pro on the same prompts before
  betting product positioning on it.
- **GPU memory needs**: 1.7B params at fp16 is ~3.4 GB, plus
  activations. Probably fits in 8 GB; verify before committing
  to a deploy SKU.
- **License audit**: Apache 2.0 release ≠ free pass on training
  data. The actual exposure depends on what Alibaba can prove
  about training data consent.
- **Voice library**: do users get to share cloned voices? If yes,
  that's a marketplace; if no, single-tenant only. Big product
  decision — likely "no" at launch to avoid the ElevenLabs
  community-voice publicity-rights mess.

### Why this matters for the product narrative

Today's Narrative pitch (post v217-v219): "own your voices, audit
the license, publish without ElevenLabs subscription risk." Adding
Qwen3-TTS turns that into: "own your voices AND your custom-cloned
voice of yourself AND a quality that rivals ElevenLabs." That's the
full ElevenLabs replacement story, not just the cheaper alternative.

---

## 6. Book view — two-page spread + page-curl flip animation

**Triggered by:** Author asked, mid-narrator-audition, how hard it would
be to add page-turning animation to the book view like the
[Internet Archive BookReader](https://archive.org/details/talkingbeastsboo00wigg/page/n23/mode/2up).
That viewer renders books as a two-page spread with a 3D corner-curl
flip when you turn pages, drag-to-flip from any corner, thumbnail
strip across the bottom.

**Status:** Future work. Task #359. Polish / delight feature, not a
blocker. Defer until after v220 (per-line WAV), #213 (Tauri
scaffolding), and the SaaS basics (#216 Stripe, #217 landing page)
ship — those move the product forward; this makes it more delightful.

**Priority:** Medium-high for product narrative. Book view is already
a meaningful differentiator vs other TTS apps (most have zero reading
UI). An IA-style page-flip reinforces the "serious tool for serious
readers and authors" angle.

### What's shipped today

Book view (v185 onward) already does:

- Paginated reading layout with three themes (paperback / magazine / manuscript) — v199
- Drop caps, chapter-aware running headers, mini TOC — M4.1-M4.4
- Inline images with image-load-aware paginator — v200
- Page numbers + font-size control + print stylesheet — M2.x / M3.3
- Magazine multi-column layout with overflow handling — M5.x
- Bookmarks with visible page marks, page-jump input, Ctrl+F find — M6.1-M6.3
- Touch swipe for page navigation — M6.4
- Text highlights — M7.1

What's *missing* relative to the IA bookreader:

- Two-page spread (currently single page per viewport)
- Animated page transition (currently instant)
- Drag-to-flip interaction (today's swipe just commits, no peel preview)
- Cover-page treatment (front cover sits solo on the right; back cover solo on the left)

### The two halves

**Layout half: two-page spread (1-2 days).** The existing paginator
already produces single pages. Render N + N+1 side-by-side in
landscape; collapse to single-page in portrait / on narrow viewports.
Cover sits solo, mirroring real books. All current interactions
(bookmarks, page-jump, find, highlights) just need to know "which
of the two pages contains this." Theme variants stay per-page.

This alone delivers ~60% of the IA feel.

**Animation half: page-flip (3-5 days).** For IA-quality curl, use
**[StPageFlip](https://github.com/Nodlik/StPageFlip)** — MIT, ~30KB,
vanilla JS, actively maintained. Does corner-peel, drag-to-flip,
both single- and two-page modes.

Integration cost is mostly DOM reconciliation. StPageFlip wants
to own its page container; our paginator emits pages incrementally
as the user reads. Clean handoff: pages get added to the flipbook
as they're generated, not all at once.

### Existing interactions that need attention

| Feature | Concern |
|---|---|
| Touch swipe (M6.4) | Replaced by drag-to-flip. Keep keyboard arrows. |
| Highlights (M7.1) | Text selection must re-enable per-page; cross-spine selection is a special case (probably forbid or render as two highlights). |
| Find (M6.3) | Match results need a "which spread" lookup; "Next match" flips there. |
| Audio-pinned scroll | "Current sentence" highlight stays on whichever page contains the audio cursor; if the user has flipped away, a small "Return to current" affordance (already exists from M3) keeps working. |
| Print stylesheet (M3.3) | Untouched — always emits flat pages. |
| Book view bookmarks (M6.1) | Page marks render on the spread; jump-to-bookmark flips there. |

### Cheaper alternatives if 3-5 days is too much

- **CSS-only slide transition (4-6 hours).** New page slides in
  from the right with a subtle drop shadow. Reads as "turning,"
  not "curling." Kindle does this. Less impressive than IA but
  10× cheaper.
- **CSS 3D rotation (1-2 days).** Page rotates around the spine
  using `transform: rotateY()`. Looks book-like in motion but
  page edge stays flat — no curl. Halfway point.

Recommended path: ship the two-page spread (layout half) first as
its own milestone. Add CSS slide as a cheap "transition feels less
abrupt" win. Hold StPageFlip integration for a later milestone
once we know users actually want the curl.

### Open questions

- **Does StPageFlip play nice with our paginator's incremental
  emission?** Worth a small spike before committing — build a
  toy page that adds pages dynamically and confirm the
  animation doesn't stutter or reset.
- **How does the spread render on a phone?** Portrait phones
  collapse to single-page, but landscape-phone is awkward
  (pages too narrow to read comfortably). Maybe force single
  on phones regardless of orientation.
- **What about RTL languages?** Page-flip direction reverses.
  Not a v1 concern but worth noting.
- **Performance on long books.** A 400-page book in a single
  flipbook DOM might be heavy. May need windowed rendering
  (only ±5 pages from current materialized) — adds complexity.

### Why this matters

Book view is the feature most TTS apps don't have. Doubling down
on it — making it feel like a real reading app, not a debug pane
— compounds Narrative's existing positioning. Combined with the
v217-v219 licensing story and (eventually) the Qwen3-TTS quality
story, page-flip turns book view from "we have one" into "we have
the best one."

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
