# Handoff: Adonis Voice Studio integration (`voicestudio:` engine)

**Audience:** Lyrith agent picking up work on the Voice Studio dispatcher or the
streaming endpoint.
**Status:** shipped and wired. The `voicestudio:` prefix routes synthesis to a
local Adonis Voice Studio instance; the streaming endpoint is live. Read this
before touching either side.

---

## What this is

Adonis Voice Studio (`E:\AI_VOICE`, served at `http://localhost:7861`) is the
author's local GPU app. It holds:
- **Kokoro** (Apache-2.0, CPU/GPU) — same model as Lyrith's Fly server
- **StyleTTS2 fine-tuned voices** (MIT, GPU) — trained on the author's own voice;
  these are the voices you can't get on the Fly CPU server
- **knn-vc zero-shot cloning** (MIT) — real-time voice conversion over Kokoro audio

When Voice Studio is running, Lyrith can route synthesis through it to get
GPU-accelerated and/or trained-voice output without paying for cloud GPU.

---

## The `voicestudio:` prefix — how it works

### Lyrith side (`tts/__init__.py`)

```
voicestudio:<voice_name>  →  _vs_synthesize_iter()  →  VS /api/synthesize/stream
```

Three additions to `tts/__init__.py`:

| Symbol | Purpose |
|---|---|
| `_VS_URL = "http://localhost:7861"` | base URL; change here if port changes |
| `_list_vs_voices()` | fetches `/api/voices` with 0.8 s timeout; returns `[]` when offline |
| `_vs_synthesize_iter(text, voice_id)` | opens SSE stream from VS; yields standard events |

`list_voices()` prepends `_list_vs_voices()` so VS voices appear first in the
picker (and disappear automatically when VS is offline).

`synthesize_iter()` checks `voice_id.startswith("voicestudio:")` **before**
Kokoro/Piper so routing is unambiguous.

### Voice Studio side (`api/server.py`)

New endpoint: `POST /api/synthesize/stream`

Request:
```json
{"text": "...", "voice": "cousin", "rate": 1.0, "volume": 1.0}
```

Response: `text/event-stream` — two event types:

```
data: {"type":"sentence","index":N,"total":M,"offset_ms":ms,"wav_b64":"<16-bit PCM WAV b64>"}

data: {"type":"result","wav_b64":"<full stitched + loudness-normalised WAV b64>","sentence_offsets_ms":[...]}
```

`offset_ms` values match the stitch logic exactly (`int(round(pause * sr))` —
same constants as `render_text`: lead_in=0.05 s, sentence_pause=0.30 s,
paragraph_pause=0.70 s, lead_out=0.30 s). The `result` event's WAV is built with
the stitch function so offsets and combined audio are guaranteed in sync.

CORS is already open for localhost origins (added in a prior session) so Lyrith's
Fly-hosted frontend can also call VS when the author uses the app locally.

---

## License / commercial-use status

| Voice type | License | Commercial audiobook? |
|---|---|---|
| `voicestudio:*` (Kokoro base) | Apache-2.0 | ✅ |
| `voicestudio:*` (StyleTTS2 fine-tune of author's own voice) | MIT model + author owns recordings | ✅ |
| `voicestudio:*` (knn-vc clone) | MIT | ✅ |

**TODO for Lyrith agent**: add `voicestudio:*` entries to `tts/voice_licenses.py`
so the commercial-use gate passes. Use a wildcard or enumerate the specific voice
names the author has trained. The current code will route synthesis correctly but
the license gate may block it in the audiobook export flow.

---

## Offline behavior

- `_list_vs_voices()` silently returns `[]` (0.8 s timeout) — voice picker just
  shows Kokoro/Piper as usual.
- `_vs_synthesize_iter()` raises `RuntimeError("Voice Studio is offline…")` —
  this surfaces to the user as a synth error. Consider catching it in the jobs
  worker and falling back to the Kokoro equivalent if one exists.

---

## How to use a trained voice in Lyrith

1. Train the voice in Voice Studio (Train Voice tab).
2. Voice Studio serves it immediately — no restart needed.
3. In Lyrith's voice picker, select `<voice_name> (Voice Studio)`.
4. Or set it as the default narrator in Settings → Voice.
5. For character voices (animation pipeline): use `voicestudio:<name>` as the
   `voice_id` in the segment map.

---

## What is NOT done yet

- **`voice_licenses.py`**: add entries for `voicestudio:*` trained voices (see TODO above).
- **Cloud GPU worker**: right now this only works when the author's laptop is on
  and VS is running. For serving other Lyrith users: deploy Voice Studio's API
  layer as a Fly GPU machine (L40S autostop), wire it up via the same
  `voicestudio:` prefix but pointing to the Fly URL. The streaming endpoint
  interface is already correct for this — just swap `_VS_URL`.
- **Streaming in the background jobs worker** (`synth_jobs.py`): the jobs worker
  calls `synthesize_iter` which already routes to `_vs_synthesize_iter`. Verify
  that the SSE streaming doesn't hit the jobs system's timeout or buffering limits
  on a long chapter.
- **Rate/volume**: the `rate` and `volume` params are accepted by VS's
  `SynthesizeStreamReq` but not yet wired into `render_text` (they're silently
  ignored). Wire them to `KokoroEngine`'s `speed` param and a volume post-scale
  if needed.

---

## API contract (minimal — implement once, works everywhere)

Lyrith's `synthesize_iter` expects:
```python
{"type": "sentence", "index": int, "total": int, "offset_ms": int, "wav_b64": str}
{"type": "result", "wav_b64": str, "sentence_offsets_ms": list[int]}
```

`wav_b64` is always **16-bit PCM mono WAV**, base64-encoded. Sample rate is
whatever VS's engine uses (Kokoro: 24 000 Hz; StyleTTS2: 24 000 Hz). Lyrith's
`_concat_wavs_bytes` requires matching sample rates across segments in multi-voice
mode — VS voices are all 24 kHz so they're safe to mix with each other.

---

## Files changed

| File | What changed |
|---|---|
| `tts/__init__.py` | `_VS_URL`, `_list_vs_voices`, `_vs_synthesize_iter`, `voicestudio:` branch in `synthesize_iter`, VS voices in `list_voices` |
| `E:\AI_VOICE\src\voice_studio\api\server.py` | `SynthesizeStreamReq` model + `POST /api/synthesize/stream` endpoint |

No static files were changed → **no `const CACHE` bump needed**.
