# Integration surface — connecting another app to Narrative

How an external app in the same ecosystem authenticates with and calls
Narrative. Source of truth for exact routes/signatures is `server.py`; this
doc is the boundary + the model. See `AGENT_HANDOFF.md` for stack orientation.

## Authentication model (read this first)

Narrative has **no user accounts** today — auth is a shared-secret header plus
a per-tenant partition.

- Every `/api/*` request needs header **`X-Narrative-Key: <bearer>`**
  (enforced by the `require_api_key` middleware in `server.py`).
- The bearer is one of:
  - **`NARRATIVE_KEY`** (env) → the **admin** tenant.
  - A **tester bearer** recorded in `/data/tenants.json` (format
    `narrative-xxxx-xxxx-xxxx-xxxx`).
- **`tenant_key = sha256(bearer)`** is the partition key. Every per-user row
  (clips, settings, gdrive_tokens, totp_enrollments, …) is scoped by it. The
  raw bearer is never stored — only its hash.
- **Local dev:** if `NARRATIVE_KEY` is unset, all requests pass as a single
  local-admin tenant (no auth). Auth only "turns on" when `NARRATIVE_KEY` is set
  (i.e. in deployment).

### Carve-outs (no `X-Narrative-Key` required)
Static files, `/api/voices/sample/*`, `/api/github/oauth/*`,
`/api/gdrive/oauth/callback`, `/api/updates/*`, and CORS `OPTIONS` preflights.

### Two-factor (TOTP) gate
If a tenant has a **confirmed** 2FA enrollment, its `/api/*` requests must also
carry **`X-Narrative-2FA: <token>`** (a server-signed, ~30-day token from
`POST /api/2fa/verify`). Without it the server returns **`401 {"detail":
"2fa_required"}`** — a calling app must handle that signal. `/api/2fa/*` itself
is exempt so a client can always enroll/verify.

### CORS / origins
CORS is configured for the Tauri shells (`tauri.localhost`, `tauri://localhost`)
and the Fly origin. An external **browser** app on a different origin would need
its origin added to the CORS allow-list in `server.py`. Server-to-server callers
aren't subject to CORS.

## API surface (categories — see `server.py` for exact shapes)
- **Voices:** `GET /api/voices`, `/api/voices/catalog`, `/api/voices/install`,
  `/api/voices/sample/*`.
- **Extraction:** `POST /api/extract` (file), `/api/extract/url`,
  `/api/extract/gdrive` — document/URL → text.
- **Synthesis (resumable jobs):** `POST /api/synth/jobs` → `{job_id}`;
  `GET /api/synth/jobs/{id}` (`?detail=1` for full params),
  `GET /api/synth/jobs/{id}/stream?from=N` (SSE), `?active=1` list,
  `DELETE` to cancel. Plus the older `POST /api/synthesize/stream`.
- **Library / sync:** `/api/library/clips/*`, `/api/library/sync/state`,
  `/api/library/presets`, `/api/library/characters`, `/api/library/maintenance`.
- **OAuth integrations (outward):** `/api/github/oauth/*`, `/api/gdrive/oauth/*`
  (+ `/api/gdrive/picker-token`, `/api/gdrive/fetch`).
- **2FA:** `/api/2fa/{status,enroll/start,enroll/confirm,verify,disable}`.
- **Health:** `GET /healthz` (and `/` for the Fly healthcheck — both
  unauthenticated).

## Reusable pattern: how Narrative integrates *outward*
For the reverse direction (Narrative calling another app, or mirroring its
approach), the GitHub/Drive OAuth flow is the template:
`gdrive_oauth.py` / `github_oauth.py` (authorize-URL + code-exchange + refresh),
server routes that set HttpOnly state/PKCE cookies, tokens stored **server-side
per tenant, encrypted at rest**. Reuse this shape rather than reinventing.

## Open questions for app-to-app (decide before building the connection)
1. **Shared identity:** do the two apps share one bearer/tenant space, or does
   each issue its own and you map between them? Today `tenant_key = sha256(bearer)`
   — a shared bearer means shared library partition across both apps.
2. **Direction & transport:** server-to-server (one app holds the other's
   `X-Narrative-Key`) vs browser/redirect (CORS + an OAuth-style handshake).
3. **What flows:** text in / audio out? clips/library sync? voices? Pick the
   minimal contract and add an endpoint only if an existing one doesn't fit.
4. **Secrets management:** the connecting app needs its own credential; keep it
   in Fly secrets, never the repo. If it's a long-lived token, store it
   encrypted (the `_seal`/`_open` pattern) under a tenant.
5. **2FA interaction:** if the calling app authenticates as a 2FA-enrolled
   tenant, it must complete `/api/2fa/verify` and send `X-Narrative-2FA`, or use
   a tenant without 2FA. Decide which.

## Coordination note (two agents, one repo)
Both agents must build on the same baseline — keep `origin/main` current
(it now is). Consider doing the integration on a **feature branch** to avoid
clobbering in-flight work on `main`, and bump the SW cache on any `static/`
change so neither agent ships stale assets to clients.
