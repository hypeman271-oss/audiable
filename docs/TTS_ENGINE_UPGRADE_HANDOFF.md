# Handoff: TTS engine upgrade (better quality / voice cloning)

**Audience:** an agent/project evaluating or integrating a higher-quality TTS engine into Lyrith (indie-author audiobook SaaS).
**TL;DR:** the current engines are free and CPU-hosted and Kokoro is already good. An "upgrade" only earns its cost if you need **voice cloning** (narrate in the author's own voice) or markedly more **expressive** delivery — and that means a GPU. The cost is **compute, not software**. Don't ship XTTS (non-commercial).

> **PRODUCT DECISION (owner): premium TTS is a USER-FUNDED opt-in.** Lyrith's
> hosting cost stays flat — authors who want top-tier/cloned voices pay for it
> themselves. Build #5 toward this, not toward the SaaS eating GPU/API cost.
> Three patterns, all routing through the same `voice_id`-prefix dispatcher:
>
> 1. **Bring Your Own Voice Studio (BUILT).** User runs Adonis Voice Studio on
>    their own GPU; `voicestudio:` prefix. $0 to the SaaS, $0 marginal to the
>    user (their hardware). Limit: works only when Lyrith's *server* is on the
>    same machine (local/desktop) — see docs/VOICE_STUDIO_INTEGRATION.md. The
>    cloud version of this = deploy VS's API on an autostop Fly GPU and point
>    `_VS_URL` at it (then it's pattern 3).
> 2. **Bring Your Own API Key (BYOK) — recommended for the hosted app.** User
>    pastes their own ElevenLabs/Cartesia/OpenAI key in Settings; a new
>    `<provider>:` engine calls the provider with *their* key, so the provider
>    bills *them* directly. $0 to the SaaS, pay-per-use to the user, works on
>    the deployed site, top quality. Store the key with the existing sealed-
>    secret pattern (see the 2FA/Drive token encryption work). Surface that the
>    user is responsible for the provider's commercial/redistribution terms.
> 3. **User-funded hosted GPU.** SaaS hosts + meters + bills the user. Most work
>    (metering + Stripe/Lemon Squeezy — overlaps the parked Paywall Phase 4).
>    Defer unless 1+2 prove insufficient.
>
> Net: the engine work is the same per-sentence-event integration; the
> *monetization* is "user pays their provider/their GPU," not the SaaS.

---

## What runs today

Lyrith dispatches by a `voice_id` prefix in [tts/__init__.py](../tts/__init__.py):

- `kokoro:` → [tts/kokoro_engine.py](../tts/kokoro_engine.py) — Kokoro 82M, **CPU**, Apache-2.0. The Fly default; genuinely good for its size.
- `piper:` → [tts/piper_engine.py](../tts/piper_engine.py) — Piper, **CPU**, permissive. LibriTTS + others.
- else → [tts/sapi.py](../tts/sapi.py) — OS voices (desktop only).

Supporting modules: [tts/catalog.py](../tts/catalog.py) (voice install/list), [tts/voice_licenses.py](../tts/voice_licenses.py) (**commercial-use tracking — the product already gates voices on commercial rights**), and a **parked spike** [tts/qwen3_spike.py](../tts/qwen3_spike.py) (Qwen3-TTS-1.7B, ~3.4 GB, needs CUDA; issue #358).

**Hosting now:** Fly `shared-cpu-1x`, 2 GB, **24/7** (`auto_stop_machines = "off"`, `min_machines_running = 1` — set deliberately because synth streams are long; see [fly.toml](../fly.toml)). ~$5/mo.

---

## The engine interface a new engine must implement

To slot in behind the dispatcher, implement a generator yielding this exact event shape (matches Kokoro/Piper, consumed by `synthesize_iter`, `synthesize_segments_iter`, the streaming endpoints, and the background jobs worker):

```
yield {"type":"sentence","index":N,"total":M,"offset_ms":ms,"wav_b64":"..."}   # per sentence, in order
yield {"type":"result","wav_b64":"<full combined WAV b64>","sentence_offsets_ms":[...]}
```

Then add a `newengine:` prefix branch in `tts/synthesize_iter`. If it yields the standard events, **everything downstream works unchanged**: multi-voice (`synthesize_segments_iter` just calls `synthesize_iter` per segment), the resumable background jobs ([synth_jobs.py](../synth_jobs.py)), the read-along offsets, and the pronunciation layer (it operates on text *before* synth — see below).

**Must keep working** (don't regress these):
- **Per-sentence event stream** (drives streaming UI + read-along offsets). The client/server sentence split must stay aligned — `SENTENCE_SPLIT` in static/app.js ≡ `_SENTENCE_SPLIT` in tts/__init__.py.
- **Multi-voice segments** (character voices) — each segment carries its own `voice_id`/`speaker_id`.
- **Pronunciation map + built-in lexicon + phonemes** — these rewrite the *text* pre-synth (audio-only). NOTE: espeak `[[phonemes]]` only work on espeak-frontend engines (Kokoro/Piper). A neural engine with a different g2p won't honor `[[…]]`; the plain-respelling and lexicon layers still apply, but the Fix-pronunciation tool's "Advanced: phonemes" field is engine-specific. See `docs/MM_PRONUNCIATION_HANDOFF.md`.
- **Commercial-use licensing** — every shippable voice must be cleared for commercial audiobook **distribution** (resale of generated audio), tracked in `voice_licenses.py`.

---

## Cost reality (the actual question)

Prices are ballparks (verify against current Fly pricing — this was written ~early 2026).

| Path | Software | Compute | Monthly |
|---|---|---|---|
| **Stay CPU** (Kokoro/Piper, or a better CPU model) | $0 | shared CPU | ~$5 |
| **GPU, 24/7** (A10/L40S/A100) | $0 (open weights) | GPU always on | **~$900–1,800** ❌ |
| **GPU, autostop** | $0 | per active second | ~$30–150 (usage-dependent) |
| **Commercial API** (ElevenLabs/Cartesia/etc.) | per-character | none | scales with usage; audiobooks are huge |

**Key tension for the GPU-autostop path** (the only economically viable GPU option): Lyrith's synth streams are **long** (a chapter is minutes), which is exactly why autostop is currently OFF. A GPU machine that scales to zero also pays a **cold-start** penalty loading multi-GB weights into VRAM (~10–30 s on the first request after idle). Making long streams + autostop + cold starts coexist is the real engineering work — likely: a dedicated GPU "synth worker" machine, separate from the always-on CPU app machine, that the background jobs system ([synth_jobs.py](../synth_jobs.py)) wakes on demand and that streams back. The jobs system's resume/reattach design already tolerates restarts, which helps.

---

## Open self-hostable models + LICENSING (the landmine)

| Model | ~Size | HW | Cloning | Commercial license |
|---|---|---|---|---|
| Piper (have) | tiny | CPU | no | ✅ permissive |
| Kokoro (have) | 82M | CPU | no | ✅ Apache-2.0 |
| StyleTTS2 | ~few-100M | GPU | zero-shot | ✅ MIT (code) |
| Orpheus (Canopy) | 3B | GPU | yes, expressive | ✅ Apache-2.0 |
| F5-TTS / E2 | ~300M+ | GPU | yes | ✅ MIT code (verify training data) |
| Qwen3-TTS | 1.7B | GPU | likely | ⚠️ verify Qwen license terms |
| Fish/OpenAudio | ~500M+ | GPU | yes | ⚠️ some tiers non-commercial |
| **XTTS-v2 (Coqui)** | mid | GPU | yes | ❌ **NON-COMMERCIAL (CPML)** — illegal in a paid product |

**The trap:** XTTS-v2 is the most-recommended cloning model online and is **non-commercial** — do not ship it. Several cloning models have similar restrictions. For a paid audiobook SaaS the safe high-quality picks are **Orpheus** and **StyleTTS2** (verify each release); **Qwen3** pending its license check. License must cover **redistribution/resale of generated audio**, not just "use the model."

---

## Decision criteria (from the spike)

Per `tts/qwen3_spike.py`: run the candidate, then judge —
- natural audio AND **< 2× realtime** inference → green-light integration;
- good but 2–5× realtime → integrate, lean on progress UI;
- poor OR > 5× realtime → re-scope (GPU or defer).

Add: **commercial license cleared** is a hard gate before any integration.

---

## Recommendation

1. **Default position: keep Kokoro.** Free, CPU, commercially clean, already good. With the pronunciation/character-voice features already shipped, this is a strong baseline at ~$5/mo.
2. **Upgrade only for cloning or expressiveness** — that's the only thing CPU models can't do, and the only thing worth paying GPU for. Generic "better" isn't worth ~$900/mo.
3. **If you upgrade:** pick a commercially-licensed model (Orpheus / StyleTTS2 first; Qwen3 if license clears — **never XTTS**), host it on a **separate autostop GPU worker** woken by the jobs system, and implement the standard per-sentence event interface so the rest of the app is untouched.

## Constraints recap (house rules)
- Commercial-use + redistribution rights on every shippable voice (`voice_licenses.py`).
- Keep the per-sentence event stream + segment multi-voice + read-along offset alignment intact.
- A 2nd agent also edits this repo — push origin/main after committing; handoff context in docs/AGENT_HANDOFF.md + docs/INTEGRATION.md.
- Deploy: commit → `git pull --rebase origin main` → push → `flyctl deploy`; bump `const CACHE` in static/sw.js on any static change.
