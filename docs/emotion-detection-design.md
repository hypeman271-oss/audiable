# Offline emotion / prosody detection — design spec

Goal: a **rule-based, offline, no-AI** pass that reads a manuscript and proposes
*where emotion and inflection belong* — which lines are dialogue, who's
speaking, where to slow down or pause, where to push or soften — then lets the
author review and apply it. No model, no network, no per-token cost: pure
pattern-matching in the browser.

Core principle (same posture as the SFX + animation layers): **authors already
encode emotion in the prose** — punctuation, dialogue, speech verbs ("she
whispered"), intensity words. The detector just *reads what's already there* and
maps it onto the levers Narrative already has. It **suggests; the author
confirms** — never auto-applies blind. And it reuses existing machinery
(`sentenceAssignments`, the paragraph-pause system, per-sentence synth) rather
than inventing a new pipeline.

This is deliberately the **deterministic** path (vs. an LLM "emotion director").
Same input → same suggestions, explainable, runs offline in a Tauri build.

---

## 1. What it detects (signals, all offline)

Ordered by reliability — the first two are the high-leverage core; sentiment is
a softer third pass.

### 1a. Dialogue + speech verbs — the goldmine
A quote followed by an attribution is the author *telling you* the emotion:

> "Get out!" she **screamed**. … he **muttered**, half asleep. … "Please," she **whispered**.

- **Quote detection:** spans inside `"…"` / `"…"` / `'…'` (regex; handle nested + curly quotes). Marks a sentence (or clause) as **dialogue**.
- **Speech-verb map** (a small bundled table, no license): `whispered/murmured/muttered → quiet`; `shouted/yelled/screamed/bellowed → loud`; `sobbed/cried/wailed → sad`; `laughed/giggled/chuckled → bright`; `snapped/hissed/growled → tense`; `said/asked/replied → neutral`. Adverbs after the verb refine it (`said softly`, `asked nervously`).
- **Speaker attribution:** "<Name> said" / "said <Name>" → which character. Feeds the voice lever (§2).

### 1b. Punctuation → pacing (no lexicon needed)
- `?` → questioning lift · `!` → emphasis/energy · `…` → trailing off + a beat
- `—` → interruption / aside · `,` `;` `:` → micro-pauses
- `ALL-CAPS` word / `*emphasis*` markup → stress
- Sentence length + paragraph breaks → natural pause points (extends the
  existing paragraph-pause detection).

### 1c. Sentiment lexicon → per-sentence mood (optional third pass)
- **VADER** (`vaderSentiment`) — a rule-based (NO ML) valence lexicon, ~7.5k
  tokens, that already handles **negation** ("not happy"), **intensifiers**
  ("very", "so"), **caps**, and **punctuation boosts**. Outputs a compound
  score in [-1, +1] per sentence. **MIT-licensed → safe to bundle + ship
  commercially.** It's a small static data file + ~200 lines of rules; portable
  to vanilla JS.
- Maps a sentence's compound score → a gentle pace/volume nudge (somber lines
  slower + softer; upbeat lines a touch brighter/faster).
- **Avoid NRC EmoLex** for bundling (its terms restrict commercial
  redistribution); VADER + the hand-built speech-verb map cover us cleanly.

---

## 2. What it drives — the levers Narrative actually has

Detection is the easy half; *expression* is bounded by the TTS engines, which
in Narrative expose **rate, volume, speaker_id** (plus the playback-time pause
system). So emotion is rendered as **pacing, pauses, loudness, and voice
switching** — not pitch bends or timbre morphing.

| Lever | How | Status in code |
| --- | --- | --- |
| **Who speaks (dialogue → character voice)** | auto-fill `sentenceAssignments` `{ "<idx>": "<character>"\|"narrator" }` | **Already exists** — manual long-press UI + regen path ([app.js:1440](static/app.js:1440), `_currentClipAssignments` [app.js:11933](static/app.js:11933)). Detector just proposes the map. |
| **Pauses (beats, hesitation, scene breaks)** | insert silence at sentence boundaries | **Already exists** — `_paragraphPauseSec` + `_detectParagraphEndIndices` ([app.js:16755](static/app.js:16755)) + `_triggerParagraphPause`. Generalize from paragraph-only to detected beats. Playback-time → no re-synth. |
| **Rate (pacing)** | per-sentence speed | Clip-level `rate` exists; **per-sentence** rate needs the per-sentence synth path (store-by-sentence), not the single combined MP3. |
| **Volume (whisper / emphasis)** | per-sentence gain | Same as rate — per-sentence needs the per-sentence synth path. |

**Honest limits (state them up front):**
- **No pitch / timbre / true emotion morphing** — the engines don't expose it.
  "Sad" = slower + softer + longer pauses + (maybe) a different speaker, not a
  cracking voice.
- **Sentence-level, not word-level** — synthesis is per-sentence, so prosody is
  per-sentence. No per-word emphasis bends.
- **Per-sentence rate/volume requires the per-sentence ("store by sentence")
  path** — in single-combined-MP3 mode only pauses + voice switching apply.
- **Rules miss sarcasm, subtext, and context** — a flat "great." read as bitter
  needs a human. The detector will over- and under-fire; that's why it's
  suggest-then-confirm.

---

## 3. Data model

Voice is already covered by `sentenceAssignments`. Add a parallel **prosody
hint map** on the clip for the how-it's-read part:

```js
prosodyHints: {
  "<sentenceIdx>": {
    emotion: "quiet"|"loud"|"sad"|"bright"|"tense"|"neutral", // label (from detection)
    rate: 0.92,        // optional per-sentence multiplier (per-sentence synth)
    volume: 0.8,       // optional per-sentence gain
    prePauseMs: 400,   // optional beat before this sentence (playback-time)
    source: "speech-verb"|"punctuation"|"vader", // why we suggested it
  },
}
```

Parallel to `bookmarks` / `annotations` / `animationCues`; persists in
IndexedDB, survives export/import. Voice → `sentenceAssignments` (existing);
how-read → `prosodyHints` (new). Both are *proposals* until the author keeps
them.

---

## 4. The detector (offline module)

A pure function, no I/O:

```js
detectProsody(text) -> {
  assignments: { "<idx>": "<character>"|"narrator" },  // dialogue → voice
  hints:       { "<idx>": { emotion, rate, volume, prePauseMs, source } },
}
```

- Splits on the SAME `splitSentencesClient` ([app.js:16718](static/app.js:16718)) the
  reading view uses, so indices line up with `sentenceSpans`.
- Stage 1: quote + speech-verb + attribution scan (regex + the verb table).
- Stage 2: punctuation → `prePauseMs` / pacing.
- Stage 3 (optional): VADER compound → rate/volume nudge.
- Bundle: `vader_lexicon.json` (static, served like other assets) + a tiny
  `speech_verbs.js` map. Both ship in the Tauri build — fully offline.

---

## 5. Authoring UX (suggest → confirm)

Reuse the cue-editor pattern. A **"Suggest emotion"** action (Author mode) runs
`detectProsody` over the chapter and previews the proposals:
- Dialogue lines get the character tint + dotted underline the
  `sentenceAssignments` UI already renders.
- Prosody hints show as small per-sentence chips (e.g. "🔇 quiet", "⏸ beat",
  "🐢 slower").
- Author accepts all / edits / clears per sentence, then **re-narrate** to bake
  voice + per-sentence prosody (the regen path already re-renders
  `sentenceAssignments`; extend it to read `prosodyHints`).

No auto-apply: nothing changes the audio until the author regenerates.

---

## 6. Phasing (shippable increments)

1. **Phase 1 — Dialogue → character voice.** Quote + speech-verb + attribution
   scan → propose `sentenceAssignments`. Highest leverage, reuses the existing
   per-sentence voice system end-to-end (UI + regen already there). No new audio
   plumbing. This alone makes books sound like they have characters.
2. **Phase 2 — Punctuation → pauses.** Generalize the paragraph-pause system to
   detected beats (`…`, dialogue turns, scene breaks). Playback-time, no
   re-synth.
3. **Phase 3 — Speech-verb + VADER → rate/volume.** Per-sentence pacing/loudness
   via the per-sentence synth path; the `prosodyHints` map drives it.
4. **Phase 4 — Review UI polish** + a per-character default-voice picker.

Each phase: flag-gate until ready, bump the SW cache, keep `origin/main`
current, verify across device tiers (`DEVICES.md`).

---

## 7. Integration points (codebase)

- **Per-sentence voice (reuse):** `sentenceAssignments` ([app.js:1440](static/app.js:1440)),
  `_currentClipAssignments` + `_persistSentenceAssignments` ([app.js:11933](static/app.js:11933)),
  the long-press assign UI, and the regen path that re-renders assignments.
- **Pauses (reuse/extend):** `_paragraphPauseSec` / `_detectParagraphEndIndices`
  / `_triggerParagraphPause` ([app.js:16755](static/app.js:16755)).
- **Sentence split (shared):** `splitSentencesClient` ([app.js:16718](static/app.js:16718)) so
  indices match `sentenceSpans`.
- **Synth params:** `speaker_id` + rate/volume in the synth request
  ([app.js:10913](static/app.js:10913)); per-sentence prosody rides the per-sentence
  ("store by sentence") synth path.
- **New:** `prosodyHints` on the clip; a `detectProsody` module +
  `vader_lexicon.json` + `speech_verbs` map (bundled, offline).

---

## 8. Why no-AI is the right call here

- **Offline + free + private** — runs in the browser/Tauri with zero per-use
  cost or data leaving the device; works in the desktop app with no network.
- **Deterministic + explainable** — the author can see *why* a line was tagged
  ("'whispered' → quiet") and trust/override it.
- **The signal is already in the text** — fiction authors write speech verbs and
  punctuation precisely to direct delivery; we're reading their stage
  directions, not guessing.
- An LLM "emotion director" stays possible later as an *optional* online upgrade
  (same `prosodyHints` output), but the rule engine is the dependable default.

**Licensing:** VADER = MIT (commercial OK, bundle freely); speech-verb map is
our own; **exclude NRC EmoLex** (commercial-redistribution restrictions). Same
audit posture as the voice/SFX licensing work.
