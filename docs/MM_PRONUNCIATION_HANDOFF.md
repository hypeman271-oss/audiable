# Handoff: the "Mm" pronunciation problem (TTS interjections)

**Audience:** an agent picking up the non-lexical-interjection pronunciation work in Lyrith.
**Status:** a working text-substitution fix is shipped (v4.202–v4.206). This doc is for someone improving it toward a *real* fix, or extending coverage beyond hums.

---

## The problem

The TTS engine spells short, vowel-less interjections **letter-by-letter** instead of vocalizing them. The canonical case: a script line `MA: Mm.` narrates as **"em em"** instead of a hum. Same for `Mmm`, `Mhm`, and friends.

Root cause: both engines run their text through **espeak-ng's phonemizer** as the g2p frontend (Kokoro via `kokoro_onnx`, see [tts/kokoro_engine.py:133](../tts/kokoro_engine.py); Piper natively). espeak doesn't have `Mm` in its lexicon and has no vowel to anchor, so it falls back to reading the letters.

### Engine reality (measured — see "Verifying" below)
- espeak **only hums** when given a leading `h` plus **2–3** m's: `hmm`, `hmmm` → a real hum.
- **4+ solid m's spell out**: `hmmmm`, `mmmm`, `Mm`, `Mmm` → "em em em…". (More m's = MORE letters = *longer, wronger* audio.)
- `umm` → says "um" (has a vowel). `mhm`, `mm-hmm` → partly spelled.
- Vowel elongation does **not** work: `Ahhh` ≈ `Ahhhhhh` (espeak doesn't sustain repeats).
- **Chaining works**: `hmmm hmmm` or `hmmm-hmmm` → two hums; `hmmm-hmmm-hmmm` → three. Duration scales ~linearly with unit count.

---

## What's shipped (the current fix)

An **audio-only** find/replace + an m-run expander, applied just before synth. The **displayed text is never changed** — the script still shows `Mm.` on screen; only the audio gets the respelling.

### 1. Editable Pronunciation map (Settings)
- UI: Settings → **Pronunciation map** — a toggle + textarea + "Reset to default". Element ids `settings-pron-on`, `settings-pron-map`, `settings-pron-reset` ([static/index.html:1728](../static/index.html)).
- Format: one `word => say-it-like-this` per line; `#` lines are notes. Stored in `localStorage` (`narrativePronOn`, `narrativePronMap`), read **fresh every synth call** (edits apply with no reload).
- Defaults ([static/app.js](../static/app.js) `_PRON_MAP_DEFAULT`, ~line 2290): `mhm => hmmm`, `mm-hmm => hmmm`. Plain m-runs are handled automatically (next item), so the default map only carries the non-m-run cases.

### 2. Author-controlled hum length (`_expandHumRuns`, ~line 2337)
Any standalone m-run token (`\b[Hh]?m{2,}\b`, case-insensitive) is rewritten to a **proportional** hum: `ceil(mCount / 3)` copies of `hmmm` joined by `-`. So:
- `Mm` → `hmm` (short), `Mmmm` → `hmmm-hmmm`, `Mmmmmmmmm` → `hmmm-hmmm-hmmm`. **No length cap** — the author controls duration by how many m's they type in the script.
- Whole-token only (`\b…\b`), so real words (`summer`, `comment`, `grammar`) are never touched.

### 3. Pipeline integration (`_applyPronunciation` ~2345, `_stripSynthChars` ~2404)
`_stripSynthChars(text)` runs, in order: `_stripAVForSpeech` (strips cue prefixes + `[inline directions]`) → `_applyPronunciation` (literal map, THEN `_expandHumRuns`) → symbol stripping. It's called on every segment/clip text right before the synth request. This now runs **regardless of the strip-symbols toggle** so scripts narrate correctly either way.

### Hard constraints any change MUST preserve
- **Audio-only.** Never alter the displayed/reading-view text — only the bytes sent to `/api/synthesize*`.
- **Boundary-safe.** Replacements must not add/remove `.`, `!`, `?`, or newlines, or they shift sentence boundaries and desync the read-along/karaoke. The map parser already strips `.!?`/newlines from replacement values. Keep matches whole-token. (See `SENTENCE_SPLIT` in app.js + `_SENTENCE_SPLIT` in [tts/__init__.py](../tts/__init__.py) — they must stay identical; a [BEAT]/silent-line desync class of bug already bit us, see `_alignOffsetsToDisplay`.)
- **No reload.** Read settings fresh per call.
- **User-editable + Reset.** The map is the user's to tune by ear; keep the Reset-to-default escape hatch.

---

## What's still imperfect (the actual open problems)

The shipped fix is a **spelling hack**. It makes interjections vocalize, but:

1. **Chained hums aren't one smooth drone.** `hmmm-hmmm` is two hums with a faint articulation seam, not a single sustained `mmmmm`. Long hums sound pulsed.
2. **No control over the hum's shape/pitch.** A *thinking* "hmm" (flat/falling) vs an *agreement* "mm-hmm" (rising, two-tone) vs a *pleasure* "mmm" all collapse to the same flat hum. espeak gives no prosody handle here from plain text.
3. **Coverage is hums + whatever the user hand-maps.** Other non-lexical sounds — `ugh`, `tsk`, `pfft`, `psst`, `shh`, `brr`, `ahh`, `ew`, `ugh`, sighs, gasps — each need a map entry AND the right respelling, which is unknown until measured per engine.
4. **Engine/voice-dependent.** Defaults were tuned by ear/byte-size on a Piper en_GB voice. Kokoro voices (the Fly default, see memory) may phonemize differently; a respelling that hums on one voice may not on another.
5. **`5 mm` (millimetres) edge case.** A standalone `mm` unit becomes `hmm` ("5 hmm") — rare in narration, but it's a known false positive of the m-run rule.

---

## Suggested avenues for a deeper fix (in rough order of effort)

1. **espeak phoneme passthrough.** espeak-ng accepts inline phonemes via `[[…]]`. Test whether `kokoro_onnx` / piper pass these through to the phonemizer untouched — if so, feeding `[[m::]]` (sustained nasal) could give a true smooth hum and even prosody. This is the highest-leverage, lowest-effort thing to try **first**. Probe it the same way you'd test any respelling (byte size + listen).
2. **A measured interjection lexicon.** Build a curated table {interjection → best respelling} per engine, derived by the byte-size method + listening, covering the common set (hmm/uh-huh/ugh/tsk/pfft/shh/ahh/oh/ooh/ew/brr…). Ship as expanded `_PRON_MAP_DEFAULT`. Cheap, high coverage, still a hack.
3. **Per-voice tuning.** Key the default respellings (or an override layer) off the voice id, since the engine differs across voices.
4. **Audio-level splice (the real fix).** Keep a tiny library of recorded/registered interjection samples (hum, sigh, tsk…) and splice them into the combined audio at the interjection's sentence offset, *bypassing the engine* for those tokens. Most control (length, pitch, emotion), most work: needs a non-spoken placeholder token in the synth stream that reserves a time slot (compare how `[BEAT]` reserves a slot — `_alignOffsetsToDisplay`, `_avBeatIndices`, `_triggerBeat`), plus sample management and mixing. This is the path if "real-sounding hums" is the goal.
5. **SSML/prosody** if/when an engine that supports it is added.

---

## Verifying without listening (important — you can't hear in CI/agent runs)

Audio **byte size ∝ duration**, and a spelled-out form is markedly longer than a hum. Run a local Piper server and compare `size_download`:

```bash
# .venv has piper; the local server does NOT require X-Narrative-Key (Fly does)
V="piper:en_GB-alan-medium"
for w in "Mm." "mmm." "hmm." "hmmm." "hmmmm." "hmmm-hmmm." "umm."; do
  sz=$(curl -s -X POST "http://localhost:8099/api/synthesize/stream" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$w\",\"voice_id\":\"$V\",\"rate\":180,\"volume\":1.0}" \
    -w "%{size_download}" -o /dev/null)
  printf '%-14s -> %s bytes\n' "$w" "$sz"
done
```

Reference numbers already measured (Piper en_GB-alan-medium):
`Mm.`=61k, `mmm.`=79k, `Mmmm.`=89k (all **spelled**) · `hmm.`=52–57k, `hmmm.`=64k (**hum**) · `hmmmm.`=108k (**spelled again**) · `hmmm-hmmm.`=83k, `hmmm-hmmm-hmmm.`=104k (chained, scales).

For the full text→audio path (cue stripping + map + expansion), POST to `/api/synthesize/segments/stream` (multi-voice) or check `_stripSynthChars(text)` output directly in the browser console via the preview harness.

---

## Code map

| Concern | Location |
|---|---|
| Map storage keys / defaults | `_PRON_ON_KEY`, `_PRON_MAP_KEY`, `_PRON_MAP_DEFAULT` — static/app.js ~2286 |
| Enabled / map text getters | `_pronEnabled`, `_pronMapText` — ~2299 |
| Map parser (→ regex rules) | `_parsePronMap` |
| m-run expander | `_expandHumRuns` — ~2337 |
| Apply (map then expand) | `_applyPronunciation` — ~2345 |
| Pre-synth pipeline | `_stripSynthChars` — ~2404 (calls `_stripAVForSpeech` then `_applyPronunciation`) |
| Settings UI | static/index.html ~1728 (`settings-pron-*`); wiring in static/app.js (search `settings-pron-on` / `settings-pron-reset`) |
| Engine frontends | tts/kokoro_engine.py (espeak via kokoro_onnx), tts/piper_engine.py |

Related memory note: `tts_pronunciation_quirks.md` in the project memory dir.

## Ship checklist (house rules)
- Bump `const CACHE` in [static/sw.js](../static/sw.js) on any static change.
- Deploy: commit → `git pull --rebase origin main` → push → `flyctl deploy` → verify `curl narrative-alpha.fly.dev/sw.js`.
- A 2nd agent also edits this repo — always push origin/main after committing.
