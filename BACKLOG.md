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

#### Tier 1 — Last-named-speaker + paragraph-aware

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

#### Tier 2 — Gender-aware pronouns

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

### Author mode features

- **Filler-word callout.** Inline panel below the textarea (Author mode
  only) showing counts of common crutch words: "just 12, very 8, really
  5, that 23." Updates live as you type. Pitched and gated behind
  Author mode but never shipped.
- **Long-sentence highlighter.** In the reading view, sentences over ~35
  words get a warm-tinted background. Composes with the karaoke
  highlight. Pitched but never shipped.
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

- **LibriTTS speaker audition wizard.** Auditing 904 anonymous numeric
  speaker IDs is unrealistic with the current preview button. A guided
  flow that plays 20-second samples in batches, lets you star ones
  you like, and ranks speakers by listen-count would be genuinely
  useful. Could include a curated "starting points" list of widely-
  liked speaker IDs from the Piper community.
- **Voice favorites.** Star voices in the catalog and main dropdown.
  Starred voices float to the top of the picker. A "Favorites" filter
  chip in the voice browser. Especially helpful once you have LibriTTS
  installed and want fast access to your 2–3 go-to speakers.
- **Custom preview text.** Type your own sentence (or paste a paragraph
  from your manuscript), preview it across multiple voices to compare.
  Currently the preview button only plays the canned sample sentence.

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

- **Real screenshots.** The current manual uses inline SVG illustrations
  of UI elements. Replacing them with actual PNG screenshots would
  feel more polished once the UI is stable. The `<figure>` wrappers
  in `static/manual.html` are set up so dropping in `<img>` tags is a
  one-line edit per illustration.
- **"What's new" log.** A short changelog page summarizing each
  noteworthy addition by date. Useful if the app is ever shared with
  others; lets returning users see what's changed without re-reading
  the whole manual.

### Quality-of-life

- ~~**5-second skip-forward**~~ Shipped in v48. Mirrors the existing
  ↶5s back chip; shares CSS via grouped selectors. Handler uses the
  same virtualTime + seekToTime path so it works in both streaming and
  combined-WAV modes; seekToTime's existing duration clamp handles
  overshoot at the end of a clip.
- **Auto-pause on phone call / notification.** Standard MediaSession
  handles some of this; explicit handling of `interruptionend` could
  make resume cleaner.
- **Bulk library operations.** Multi-select clips for delete or
  export. Currently each clip is one × at a time. Useful past ~30
  clips.

### Tools that aren't features but would help maintenance

- **End-to-end Playwright tests.** Manual smoke testing every clip
  state across 40+ shell versions adds up. A short Playwright suite
  hitting "generate → save → load → bookmark → reset → delete" would
  catch regressions cheaply.
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
