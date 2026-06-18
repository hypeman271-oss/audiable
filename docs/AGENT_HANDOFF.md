# Agent handoff / orientation

Context for an agent (or person) picking up this repo fresh — especially one
working on connecting Narrative to another app. Written because the prior
agent's private memory does NOT transfer; the repo is the only shared source
of truth. See also `INTEGRATION.md` (the app-to-app boundary).

## Stack at a glance
- **Backend:** FastAPI + uvicorn (`server.py`), Python. TTS engines in `tts/`
  (Piper = the `en_US-*`/libritts/ljspeech voices; Kokoro = `kokoro:*`, the
  hosted default). Background synthesis is a detached-task model in
  `synth_jobs.py`.
- **Storage:** SQLite via `library_db.py` at `$NARRATIVE_DATA_DIR/narrative.db`
  (**schema v9**). Audio blobs are content-addressed on disk. Tester identities
  in `/data/tenants.json`.
- **Frontend:** vanilla JS, **no build step** — `static/app.js` is one ~35k-line
  file, `static/index.html`, `static/styles.css`, plus a service worker
  `static/sw.js`. Also a **Tauri** desktop shell (`src-tauri/`).
- **Deploy:** Fly.io app `narrative-alpha` via `fly deploy` (bakes `voices/` +
  `static/` into the image). Repo: `github.com/hypeman271-oss/audiable`, branch
  `main`.

Start with `ARCHITECTURE.md`, `SYNC.md`, `DEVICES.md`, `BACKLOG.md`, and the
`docs/*-design.md` files. This doc is the recent-changes + gotchas layer.

## Hard conventions (these bite if ignored)
- **Bump the SW cache on ANY `static/` change** — `const CACHE` in
  `static/sw.js` (currently `v225v4.115`). Clients won't get new JS/CSS until
  this changes.
- **Device tiers**: `DEVICES.md` maps which UI lives on phone / tablet /
  wide-desktop / Tauri. Consult it before UI changes and state which tiers are
  touched; default to the narrowest tier the request names.
- **Schema migrations**: bump `CURRENT_SCHEMA_VERSION` in `library_db.py` and
  add an idempotent `_apply_vN`. Migrations run at boot; they ran cleanly in
  prod through v9.
- **Deploy flow used this session**: commit → `fly deploy` → smoke-test the
  live URL → push. (Prod ran ahead of `origin` for a while — keep `origin`
  current so a second agent isn't stale.)
- **Encryption at rest**: sensitive secrets (Drive tokens, TOTP secrets) are
  Fernet-sealed in the DB via `_seal`/`_open` in `library_db.py`, keyed by
  `NARRATIVE_TOKEN_KEY` (see env vars). `cryptography` is a dependency.
- `app.js` uses lazy per-function imports and a monkey-patched `window.fetch`
  that adds `X-Narrative-Key` (and `X-Narrative-2FA`) to `/api/*` + rewrites to
  the Fly origin under Tauri. New `/api/*` calls get auth automatically.

## What changed recently (this session's commits)
- **Google Drive OAuth (Phase 2, #896)** — `gdrive_oauth.py`, `/api/gdrive/*`,
  `drive.file` scope + Google Picker. Tokens server-side per tenant, encrypted,
  PKCE, revoke-on-disconnect. Setup runbook: `GDRIVE_OAUTH_SETUP.md`. **Dormant
  until `GOOGLE_*` secrets are set.**
- **Two-step verification (TOTP, opt-in)** — `totp.py`, `/api/2fa/*`,
  `totp_enrollments` table, middleware gate (`2fa_required`). Settings → Account.
- **Synthesis hardening** — self-heal on dropped stream, **boot reattach** to a
  running job (`/api/synth/jobs?active=1`, `?detail=1`), and **resume from a
  content-keyed cache** (`synth_resume_cache`, schema v9) across restarts.
- **LJSpeech voice** added (public-domain) + license registry
  `tts/voice_licenses.py`.
- **Bookmark timestamp tap → jump to text** (all tiers).
- **Sound-effects MVP (prototype, GATED OFF)** — see "Parked work" below.

## Environment / secrets (Fly)
- `NARRATIVE_KEY` — shared-secret auth; also the HMAC signing key for 2FA
  session tokens. Unset locally = single local-admin (no auth). **Set in prod.**
- `NARRATIVE_TOKEN_KEY` — Fernet key encrypting Drive tokens + TOTP secrets at
  rest. **NOT set in prod yet** → those fall back to plaintext. Set before
  anyone relies on 2FA/Drive. (Legacy alias `GDRIVE_TOKEN_KEY` also read.)
- `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_API_KEY`,
  `GOOGLE_APP_ID` — Drive OAuth + Picker. **Unset** (feature dormant).
- `GITHUB_CLIENT_ID/SECRET`, `GITHUB_OAUTH_REDIRECT_URI` — GitHub OAuth.
- `NARRATIVE_DATA_DIR` — DB + blob location (the Fly volume `/data`).

## Parked work (not in progress)
- **Sound effects / ambience** (`docs/sound-effects-design.md`): a layered-audio
  mixer prototype is live **behind a flag** — enable with `?sfx=1` or
  `localStorage 'narrative.sfxPrototype'="1"`. Routes narration through Web
  Audio + plays a ducked ambience bed (`static/sfx/rain-ambience.mp3`, public
  domain) with an Ambience volume slider. **Flag off = player unchanged.** Not
  finished — no cue editor, persistence, or asset library yet.
- **Emotion / expressive dialogue** — explored (cloud engines: ElevenLabs v3,
  Hume Octave, Azure express-as, OpenAI gpt-4o-mini-tts), **not yet written to
  a doc, not started.** Current local engines (Piper/Kokoro) have no emotion
  control.

## Known carry-over notes (from the prior agent's memory)
- **Narrator pick: LibriTTS speaker 7** (CC BY 4.0, attribution
  "LibriTTS (Heiga Zen et al.), CC BY 4.0"). Hosted V1 default is Kokoro.
- Voice/SFX licensing is audited for commercial use — prefer CC0/CC-BY; the
  pattern is `tts/voice_licenses.py`. Bundled assets must allow redistribution
  (CC0), not just "commercial use" (Pixabay/Mixkit forbid redistributing raw
  files).
- Desktop updater `.sig` files from tauri-action are already base64 — paste
  verbatim, don't re-encode (see `scripts/verify_updater_manifest.py`).
