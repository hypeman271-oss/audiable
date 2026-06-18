# Voice Studio → Narrative integration — handoff

Handoff for **Narrative's agent**. A sister app, **Adonis Voice Studio** (a local
TTS + voice-changer + character-voice + **sound-generator** studio, repo at
`E:\AI_VOICE`), now pushes **voices** and **sound effects** into Narrative across
the local filesystem. The Voice-Studio side is done and committed there. This doc
is the contract + the remaining Narrative-side work.

Written because the repo is the only shared source of truth (per `AGENT_HANDOFF.md`).
See also `sound-effects-design.md` (your SFX design — this delivers its §2 "asset
library") and `INTEGRATION.md` (the app boundary).

---

## The boundary (who owns what)

- **Voice Studio owns:** generating voices + sound assets and pushing them into
  Narrative's folders. It does NOT call your API or touch your DB — it's a pure
  filesystem drop (both apps are local on this machine).
- **Narrative owns:** discovering/playing them. Voices already auto-discover.
  Sounds need wiring into your player (the work below).
- **The interface is two things on disk:** Piper models in `voices/`, and a sound
  **asset manifest** at `static/sfx/assets.json`.

The push is idempotent — Voice Studio re-runs "send" any time to refresh assets.

---

## 1. Voices — ALREADY WORKING, no Narrative change needed

Voice Studio copies portable voices into `voices/`:
- **Piper voices / multi-speaker speakers** → `voices/<id>.onnx` (+ `.onnx.json`).
  Your `piper_engine` globs these on each `/api/voices` call, so they appear
  automatically. A Voice-Studio "LibriTTS speaker 42" = `piper:en_US-libritts-high`
  + `speaker_id:42` (you already support `speaker_id`).
- **Plain Kokoro voices** already exist in your bundle (`kokoro:af_heart` …) — nothing copied.
- **Excluded by design:** Voice Studio's *transformed* voices (pitch/formant/blend,
  knn-vc/XTTS clones). Your engines only do rate/volume/speaker_id, so those have no
  faithful equivalent and are deliberately NOT sent (they'd sound wrong).

**Optional polish:** register a sent voice as a **preset** (`presets` table already
has `{voice_id, speaker_id, rate}`) so a specific speaker shows as a named entry
instead of "pick the model + speaker N". Not required — the voice works without it.

---

## 2. Sound effects — assets DELIVERED, playback is your part

Voice Studio renders **12 procedurally-generated sounds** and writes them into your
asset library:

```
static/sfx/<name>.wav        # the audio (22.05 kHz mono)
static/sfx/assets.json       # the manifest (below)
```

Already present on disk now:
- **Beds (loopable):** rain, wind, fire, static, applause
- **One-shots (spot fx):** thunder, knock, gunshot, whoosh, heartbeat, beep, telephone

(Plus your existing `static/sfx/rain-ambience.mp3` — untouched.)

### `assets.json` schema

A flat array; each entry:

```json
{
  "name": "thunder",
  "file": "/sfx/thunder.wav",
  "kind": "oneshot",                       // "bed" | "oneshot"
  "license": "CC0 (procedurally generated)",
  "commercial": true,
  "attribution": "",
  "source": "Adonis Voice Studio"
}
```

**Why these are safe to bundle:** they're *algorithmically synthesized* (pure DSP,
no recordings), so they're CC0-equivalent — they clear your "bundling = CC0 only"
bar from `sound-effects-design.md` §3 with no redistribution caveat. `kind`
maps to your `bed`/`oneshot` cue types.

### Remaining Narrative-side tasks (the handoff)

This is your `sound-effects-design.md` §2 "asset library" + cue wiring, now that
assets exist:

1. **Serve the manifest.** `static/` is already served unauthenticated, so
   `GET /static/sfx/assets.json` works as-is; or add a thin
   `GET /api/sfx/assets` that reads + returns it (handy for filtering).
2. **`sfx_licenses.py`** mirroring `tts/voice_licenses.py` — but the manifest
   already carries `license`/`commercial`/`attribution`/`source`, so this can just
   ingest the manifest rather than re-audit. Surface the badge like the voice one.
3. **Wire `_sfxMixer` to the library.** Today it's the gated prototype
   (`?sfx=1`, `_MVP_SFX_CUE`, hard-coded `rain-ambience.mp3`). Generalize it to
   load any asset from the manifest: a `bed` loops (your existing path), a
   `oneshot` plays once at a cue time. The Web Audio graph + ducking you already
   built is unchanged — only the asset source becomes data-driven.
4. **Minimal asset picker** in the gated UI: a dropdown of manifest assets feeding
   the existing ambience slider, so the bed is selectable (not hard-coded). Full
   cue editor (the `soundCues` data model on the clip) stays your §2 roadmap.
5. **Bump the SW cache** (`const CACHE` in `static/sw.js`) — you're touching
   `static/`. (Hard convention from `AGENT_HANDOFF.md`.)
6. **Feature branch**, and keep `origin/main` current (two-agents warning in
   `INTEGRATION.md`).

Out of scope for the handoff (your roadmap): cue persistence/schema, AI
auto-tagging, ffmpeg baked-export mixdown.

---

## 3. How to refresh / re-push from Voice Studio

If Voice Studio adds or changes sounds, its operator re-runs the push and the
files + manifest are rewritten in place (existing entries replaced by `name`):

- UI: Voice Studio → **Sound FX** page → "Send all sounds to Narrative".
- API: `POST http://127.0.0.1:7861/api/narrative/send-sfx` `{}` (all) or
  `{"sound":"thunder"}` (one). `GET /api/narrative/status` reports the target dir.

Target dir is `D:\audiable` by default, overridable via the
`VOICE_STUDIO_NARRATIVE_DIR` env var on the Voice-Studio process.

---

## 4. Quick verification

```
ls static/sfx/                      # 12 *.wav + assets.json + rain-ambience.mp3
python -c "import json;print(len(json.load(open('static/sfx/assets.json'))))"   # 12
```

Then: enable the SFX prototype (`?sfx=1`), and once the mixer reads the manifest,
pick e.g. `rain` (bed) or drop a `thunder` (one-shot) cue and confirm it plays
ducked under the narration.
