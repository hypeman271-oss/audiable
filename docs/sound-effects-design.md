# Sound effects / ambience for narration — design + MVP spec

Goal: layer scene ambience and foley under the TTS narration — "old-school
radio show." A car-on-the-highway scene plays the narration with a highway
bed humming underneath, ducked below the voice.

Core principle (see the architecture diagram in chat): **keep effects as a
separate layer mixed at playback time, never baked into the TTS.** Voice and
soundscape stay independent so re-narration doesn't lose effects, the listener
can balance/disable them, and cues ride the timeline we already have
(`sentence_offsets_ms` / `currentSentenceIndex`).

---

## 1. MVP slice (the de-risking prototype)

**Scope:** prove the playback mixing on ONE hard-coded CC0 ambience + ONE
manual cue, with **no authoring UI, no persistence, no asset library, no
export.** Just: does ambience fade in under the narration over a sentence
range and sound right?

### What it does
On playback of a saved clip (combined-MP3 mode), an ambience loop plays under
the narration between sentence `START_IDX` and `END_IDX`, at low gain (ducked),
fading in/out at the boundaries. Hard-coded for the prototype.

### Implementation

**Asset (1 file):** drop one CC0 highway/road ambience at
`static/sfx/highway-loop.mp3` (~30–60s, seamless loop; sourced per §3).

**Hard-coded cue (constant in app.js):**
```js
const _MVP_SFX_CUE = {
  asset: "/sfx/highway-loop.mp3",
  startIdx: 3, endIdx: 9,   // sentence range (tune to a test clip)
  gain: 0.28,               // ducked level under speech
  fadeMs: 800,
};
```

**Web Audio graph** (new, lazy, built on first Play — a user gesture, which
WebAudio requires):
- `ctx = new AudioContext()` (once).
- Route narration: `ctx.createMediaElementSource(playerEl)` → `masterGain` →
  `ctx.destination`. **Guard:** `createMediaElementSource` may be called only
  ONCE per `<audio>` element for the page's life — store the node and reuse.
- Load ambience once: `fetch(asset)` → `arrayBuffer` → `ctx.decodeAudioData`
  → cache the `AudioBuffer`.
- Play ambience: `AudioBufferSourceNode` (`loop = true`) → `ambGain` (start at
  0) → `ctx.destination`; `.start()`.

**Cue windowing** (reuse the existing playback tick — the same `timeupdate` /
rAF loop that drives `highlightCurrentSentence`):
```js
const idx = currentSentenceIndex(playerEl.currentTime);
const inside = idx >= _MVP_SFX_CUE.startIdx && idx <= _MVP_SFX_CUE.endIdx;
const target = inside ? _MVP_SFX_CUE.gain : 0;
ambGain.gain.setTargetAtTime(target, ctx.currentTime, _MVP_SFX_CUE.fadeMs / 3000);
```
On pause / clip change / `exitReadingView`: ramp `ambGain` to 0 and stop the
source. Resume `ctx` (`ctx.resume()`) on play if suspended.

### Integration points (codebase)
- `playerEl` — the single `<audio>` element (the narration source).
- `currentSentenceIndex(time)` + `sentenceOffsetsSec` — the time→sentence map
  (already powers the karaoke highlight).
- The highlight tick (`highlightCurrentSentence`, fired on `timeupdate`) — hook
  the gain update here, or add a sibling `timeupdate` listener.
- New: `static/sfx/` for the bundled asset; a small `_sfxMixer` module in
  `app.js` (init / play / tickGain / stop).

### Acceptance criteria
- Play a test clip: between sentences 3–9 the highway bed fades in under the
  voice, fades out after, voice stays clearly on top.
- Pause/seek/clip-change cleanly silences the bed.
- Works on desktop Chrome + mobile (gesture-started AudioContext).
- Narration audio is unchanged when no cue is active (no regression to the
  normal player).

### Explicitly OUT of scope for the MVP
Persistence, authoring UI, multiple/one-shot cues, the asset library, the
AI auto-tagger, export mixdown, and **streaming-mode** support (target the
combined-MP3 timeline first; per-sentence streaming uses a different time
source — `_streamElapsed` — and is a later increment).

---

## 2. The real feature (post-MVP, for reference)

- **Cue data model** on the clip, parallel to `bookmarks`:
  `soundCues: [{ id, type:'bed'|'oneshot', assetId, startLineId, endLineId,
  gain, loop, fadeInMs, fadeOutMs }]`. Anchor to `line_id`s (stable across
  edits), resolve to time via the offsets at playback.
- **Authoring UX** in Author mode: reuse the per-sentence selection from the
  annotate/bookmark flow — select a passage → "Add ambience → Highway" → set
  level. Cues render as colored underlays in the reading view.
- **Asset library**: a bundled CC0 set (served like `voices/`), with a license
  registry mirroring `tts/voice_licenses.py` (e.g. `sfx_licenses.py`).
- **AI auto-tagging** (Claude API): a pass over the manuscript detects scenes
  ("INT. CAR – HIGHWAY, RAIN") and proposes a cue sheet for author review —
  the "radio director."
- **Baked export**: server-side `ffmpeg amix` + `adelay` mixes narration + cues
  into one downloadable MP3 from the same cue data (ffmpeg is already in the
  image).

---

## 3. CC0 / royalty-free ambience sources + licensing

**The key distinction for us:** two different uses, two different license bars.

| Use | What it is | License bar |
| --- | --- | --- |
| **Output** | ambience mixed into a user's audiobook ("integrated into content") | Pixabay / Mixkit / Sonniss / CC0 all allow this |
| **Bundling** | shipping the raw asset files in the app's library (served like `voices/`) | **CC0 only** — others forbid redistributing standalone files |

Because Narrative would **serve the asset files** (the author picks from a
library), we need **CC0** — it's the only license that permits commercial use,
no attribution, AND redistribution of the raw files. Same posture as the voice
licensing audit.

### Recommended (CC0 — safe to bundle commercially, no attribution)
- **Freesound — filtered to CC0.** Huge library; filter `license:"Creative
  Commons 0"`. CC0 sounds need no credit and can be redistributed. (Freesound
  is mixed-license — you MUST filter; CC-BY/CC-BY-NC items are not safe to
  bundle.) https://freesound.org/help/faq/
- **Kenney (kenney.nl) / OpenGameArt CC0.** Kenney's audio is CC0 — commercial,
  no attribution, redistributable. OpenGameArt is mixed; filter to CC0.
  https://opengameart.org/content/cc0-sound-effects
- Other CC0/public-domain pools: archive.org public-domain audio; freepd-style
  CC0 collections. Verify each item's license individually.

### Usable in OUTPUT, but NOT safe to bundle as raw files
- **Pixabay** — commercial OK, no attribution, but "don't redistribute the raw
  sounds as standalone files." Fine if mixed into output; **not** for our
  served library. https://pixabay.com/service/license-summary/
- **Mixkit** — same shape: royalty-free, no attribution, but no standalone
  redistribution without significant change. https://mixkit.co/license/
- **Sonniss #GameAudioGDC bundle** — royalty-free, commercial, no attribution,
  modify freely, BUT "may not sell the sound effects as they come" and no
  sublicensing → bundling raw files in a served library is gray. Also forbids
  AI-training use (irrelevant to us). https://sonniss.com/gdc-bundle-license/

### Exclude
- **BBC Sound Effects (free / RemArc licence)** — **non-commercial only**
  (research/education/personal). Do NOT use in a paid product. A commercial
  license exists via Pro Sound Effects (paid).
  https://sound-effects.bbcrewind.co.uk/licensing

### Workflow note
Mirror the voice audit: for each bundled asset record `{source, url, license,
commercial:true, attribution:""}` and prefer CC0 end-to-end. Looping beds
(ambience) should be edited to seamless loops; one-shots (foley) stay as-is.

---

## 4. AI-generated assets (alternative / complement to the CC0 library)

Text-to-sound-effect models generate both ambience beds and one-shot foley
well. Same cue/mixer architecture — AI is just another **source** of assets.

**Commercial-rights bar (the crux for a paid product):** use a provider that
grants commercial rights to the *output*, and keep a per-asset record.

| Provider | Commercial output? | Notes |
| --- | --- | --- |
| **ElevenLabs — Sound Effects API** | ✅ on **paid** plans; you own output, perpetual even after cancel | Best API fit; has a loop mode. They keep a license to use content to improve models. |
| **Stability — Stable Audio 2.x (hosted)** | ✅ on **paid** tiers (Creator <$1M/yr; Enterprise) | Free tier non-commercial. Open-weights *Stable Audio Open* = research/community license — don't bundle. |
| **Meta AudioGen / AudioCraft** | ❌ CC-BY-NC weights | Non-commercial — exclude. |

**Why this can be *cleaner* than stock for us:** generated output you own has
no "don't redistribute raw files" clause (unlike Pixabay/Mixkit/Sonniss), so
it's safe to bundle + serve as a library asset. Nuances: AI output may not be
*exclusively* copyrightable (you get usage rights, not necessarily the right to
stop others), and record training-data provenance for risk-averse buyers.

**Integration (two shapes, do both):**
1. **Pre-generate a starter library** (recommended first): batch-generate
   ~20–30 common beds/foley, vet, bundle like `voices/`. Zero runtime cost.
2. **Generate-on-demand**: a server endpoint calls the SFX model
   ("rainy highway at night, looping, 20s"), caches by prompt-hash (content-
   addressed, like the audio blob store), and a cue references it. Pairs with
   the AI auto-tagger: LLM detects the scene → SFX model generates the bed →
   author approves.

**Caveats:** seamless looping for beds (use the provider's loop feature or a
crossfade); short duration caps (generate short, loop); per-gen cost + latency
(cache hard; pre-generate common beds); quality variance (generate-and-pick).

Sources: [ElevenLabs commercial rights](https://terms.law/ai-output-rights/elevenlabs/) ·
[Stable Audio commercial tiers](https://dynamoi.com/learn/ai-music-distribution/can-i-distribute-stable-audio-commercially) ·
[Meta AudioCraft CC-BY-NC](https://huggingface.co/spaces/facebook/MusicGen/discussions/8)

---

## 5. Prototype status

The MVP mixer (§1) is implemented behind a flag in `static/app.js`
(`_sfxMixer` block + `_MVP_SFX_CUE`) with an **ambience volume slider**
(0–80%, persisted as `narrative.sfxVolume`). Enable with `?sfx=1` or
`localStorage.setItem('narrative.sfxPrototype','1')`, then play a clip — the
bed plays under the narration, ducked, adjustable live. Flag OFF = player
unchanged.

Current bed: `static/sfx/rain-ambience.mp3` — a real recorded rainfall
ambience, **public domain**, looped to ~20s + loudness-normalized.
Source: Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Rain.ogg
(released to the public domain by the author; no attribution required).
A true highway/engine loop for production would be sourced the same way
(verified CC0/PD) or AI-generated (§4).

**Sources:**
[Freesound FAQ](https://freesound.org/help/faq/) ·
[Pixabay License](https://pixabay.com/service/license-summary/) ·
[Mixkit License](https://mixkit.co/license/) ·
[Sonniss GDC bundle license](https://sonniss.com/gdc-bundle-license/) ·
[BBC Rewind licensing](https://sound-effects.bbcrewind.co.uk/licensing) ·
[OpenGameArt CC0](https://opengameart.org/content/cc0-sound-effects)
