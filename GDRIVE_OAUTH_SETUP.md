# Google Drive OAuth setup

Public Drive **share links** work out of the box (paste any "Anyone with
the link" URL into Import → Google Drive). OAuth is opt-in and unlocks
importing a user's **private** Drive files: they click **Sign in with
Google** in Settings, authorize on accounts.google.com, then pick files
through Google's hosted Picker.

Unlike the GitHub flow, Drive tokens are stored **server-side per tenant**
— the long-lived refresh token never reaches the browser. This guide is
for the operator (you). It is **not** an end-user runbook.

## Why `drive.file` (and why that makes setup easy)

Narrative requests the **`drive.file`** scope: it grants access only to
files the user explicitly picks via the Google Picker, never their whole
Drive. The payoff:

- **No Google app verification.** `drive.file` is a non-sensitive,
  non-restricted scope, so you skip Google's weeks-long verification
  review and the annual third-party (CASA) security assessment that
  `drive.readonly` and other restricted scopes require.
- **Free, polished file browser.** The Picker handles browse / search /
  recent files — we don't build or maintain a Drive tree view.

## 1 — Create a Google Cloud project + enable the Drive API

1. Go to <https://console.cloud.google.com/> and create a project (or
   reuse one). Note the **project number** (Dashboard → "Project number")
   — that's the `GOOGLE_APP_ID` the Picker needs later.
2. **APIs & Services → Library** → enable both:
   - **Google Drive API**
   - **Google Picker API**

## 2 — Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen.**
2. User type **External** (unless everyone is in your Google Workspace,
   in which case **Internal** skips the tester list entirely).
3. Fill app name, support email, developer contact. A logo / homepage is
   optional while unpublished.
4. **Scopes**: add `.../auth/drive.file` and `.../auth/userinfo.email`.
   Both are non-sensitive, so no verification is triggered.
5. **Test users**: while the app is in **Testing** mode, only Google
   accounts you add here can sign in (up to 100). Add yourself + your
   alpha testers. (Publishing to **Production** with only `drive.file` +
   `userinfo.email` does *not* require verification, so you can publish
   when you outgrow 100 testers.)

## 3 — Create OAuth credentials + a Picker API key

1. **APIs & Services → Credentials → Create credentials → OAuth client
   ID** → application type **Web application**.
2. **Authorized redirect URIs** — add every shell you run. Keep the path
   `/api/gdrive/oauth/callback`, vary scheme + host:
   - `http://localhost:8000/api/gdrive/oauth/callback` (local dev)
   - `https://narrative-alpha.fly.dev/api/gdrive/oauth/callback` (Fly)
   - `http://tauri.localhost/api/gdrive/oauth/callback` (Windows desktop
     shell — the Tauri app routes API calls to the Fly origin, but
     register it if you test against a local server)
3. Create → copy the **Client ID** and **Client secret**.
4. **Create credentials → API key** (this is the Picker's
   `developerKey`). Restrict it: **Application restrictions → HTTP
   referrers**, allow your origins (`https://narrative-alpha.fly.dev/*`,
   `http://localhost:8000/*`); **API restrictions →** restrict to the
   **Google Picker API**. This key is sent to the browser by design —
   the referrer restriction is what keeps it safe.

## 4 — Set environment variables

Narrative reads these at request time (no restart required after a
change, but it doesn't hurt):

```bash
export GOOGLE_CLIENT_ID="xxxxxxxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxxxxxxxxxxxxxxx"
export GOOGLE_OAUTH_REDIRECT_URI="http://localhost:8000/api/gdrive/oauth/callback"
# Public Picker config — safe to expose to the browser.
export GOOGLE_API_KEY="AIzaSyxxxxxxxxxxxxxxxxxxxx"
export GOOGLE_APP_ID="123456789012"   # the GCP project NUMBER
# Encryption-at-rest key for stored Drive tokens (Fernet). REQUIRED in
# production — without it tokens fall back to plaintext in the DB.
# Generate once:  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
export GDRIVE_TOKEN_KEY="paste-the-generated-44-char-key="
# Optional — defaults to "drive.file + userinfo.email". Leave unset.
# export GOOGLE_OAUTH_SCOPES="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email"
```

> **Keep `GDRIVE_TOKEN_KEY` stable and secret.** Rotating or losing it
> makes existing stored grants undecryptable — Narrative then treats
> those users as disconnected and they simply sign in again (no crash,
> no data loss beyond the grant). Store it in Fly secrets, never in the
> repo.

For Fly:

```bash
fly secrets set \
  GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="GOCSPX-xxx" \
  GOOGLE_OAUTH_REDIRECT_URI="https://narrative-alpha.fly.dev/api/gdrive/oauth/callback" \
  GOOGLE_API_KEY="AIzaSyxxx" \
  GOOGLE_APP_ID="123456789012"
```

## 5 — Verify

Restart the server. Open **Settings → Account → Google Drive**:

- With `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` set, **Sign in with
  Google** is enabled.
- Click it → authorize on Google → you land back on Narrative with
  "✓ Connected Google Drive." in the status bar, and the section reads
  **"Connected as you@example.com."**
- **Import ▾ → Google Drive** now opens the Picker. Pick a private Doc or
  PDF → its text lands in the textarea.
- **Disconnect** drops the server-side grant; the Drive import falls back
  to the public share-link row.

If the button is disabled, check `env | grep GOOGLE`. If the Picker
errors on "developer key", confirm `GOOGLE_API_KEY` / `GOOGLE_APP_ID` and
the key's referrer + API restrictions.

## 6 — How tokens are stored (security notes)

- **Server-side per tenant.** The grant lives in the `gdrive_tokens`
  table (schema v7), keyed by `tenant_key` (sha256 of the bearer — never
  the raw key). One Google account per tenant; reconnecting overwrites.
- **Encrypted at rest.** Access + refresh tokens are sealed with Fernet
  (AES-128-CBC + HMAC) under `GDRIVE_TOKEN_KEY` before they hit SQLite —
  a leaked DB file / backup / volume snapshot yields ciphertext, not a
  usable grant. (Defends against at-rest exposure; not against full host
  compromise, where the key is in env on the same machine.)
- **PKCE (S256).** The authorize flow sends a `code_challenge` and the
  callback proves possession of the matching verifier (held in an
  HttpOnly cookie), so an intercepted auth code can't be redeemed by an
  attacker. OAuth 2.1 best practice, on top of the client secret.
- **Revoked on disconnect.** Disconnecting calls Google's `/revoke`
  endpoint to kill the grant at Google, then deletes the local row —
  not just a local forget.
- **Refresh token never leaves the server.** The OAuth callback persists
  `access_token` + `refresh_token` + `expires_at`. When the access token
  nears expiry, the server refreshes it using the stored refresh token.
- **The Picker gets only an ephemeral access token.** `drive.file`
  requires a client-side Picker, which needs an OAuth token. The browser
  fetches a short-lived (~1h) access token from
  `/api/gdrive/picker-token`; the refresh token is never exposed.
- **No token in any URL.** The callback redirects to
  `/?gdrive_oauth=success` — no fragment, no token. (Contrast the GitHub
  flow, which returns its token in the URL fragment to `localStorage`.)
- **HttpOnly cookies for the round-trip.** `/start` sets two
  `SameSite=lax`, `HttpOnly` cookies (CSRF state + the tenant key),
  scoped to `/api/gdrive/oauth/`, 10-minute TTL. `Secure` is derived from
  the redirect URI scheme — use `https://` for anything but localhost.
- **`prompt=consent` + `access_type=offline`** guarantee Google returns a
  refresh token even on reconnect, so a user who revokes + reconnects
  doesn't end up with a half grant.

## 7 — Revoking

- From Narrative: **Settings → Account → Google Drive → Disconnect** —
  revokes the grant at Google (best-effort) and deletes the server-side
  row.
- From Google: <https://myaccount.google.com/permissions> → remove
  Narrative. The next refresh attempt then fails as `invalid_grant`;
  Narrative clears the stale grant and the user is prompted to reconnect.

## 8 — What's NOT supported

- **Sheets / Slides**: rejected with a friendly "export to DOCX or PDF"
  message — TTS has no useful read of those.
- **Shared Drives / org-wide browse**: `drive.file` is per-picked-file by
  design. A broader scope (`drive.readonly`) would unlock a native
  browser but pulls you into Google's verification gauntlet — out of
  scope for this build.
