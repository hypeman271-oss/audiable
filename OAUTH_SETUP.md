# GitHub OAuth setup

PAT paste works out of the box. OAuth is opt-in: enable it once and
your users (and you) never type a token again — they click **Sign in
with GitHub** in Settings, authorize on github.com, and the token
round-trips back via redirect.

This guide walks through the one-time GitHub OAuth App registration
and the env vars Narrative reads at runtime.

## 1 — Register a GitHub OAuth App

OAuth Apps live in your GitHub account (or organization) settings,
not on a per-repo basis. One app covers every Narrative instance
that shares the same callback URL.

1. Open <https://github.com/settings/developers> → **OAuth Apps** →
   **New OAuth App**. (For an organization app, replace `settings`
   with `organizations/<org>/settings`.)
2. Fill in:
   - **Application name**: something users will recognize on the
     authorize screen. `Narrative — <yourdomain>` works.
   - **Homepage URL**: wherever your Narrative is served. For
     localhost use `http://localhost:8000/`. For Fly use
     `https://your-app.fly.dev/`.
   - **Application description** (optional): "Local-first TTS web
     app — reads my chapters back to me."
   - **Authorization callback URL**: this MUST match what Narrative
     sends. Default is `http://localhost:8000/api/github/oauth/callback`.
     For deploys, replace the scheme + host but keep the path. GitHub
     allows multiple callback URLs separated by newlines — you can
     register both your localhost and your deploy here.
3. Skip "Enable Device Flow" — Narrative uses the web-application
   flow.
4. Hit **Register application**.
5. On the resulting page:
   - **Client ID** is shown in plaintext. Copy it.
   - Click **Generate a new client secret**. GitHub shows it ONCE,
     same as PAT pages do. Copy it immediately.

## 2 — Set environment variables

Narrative reads three env vars at request time (so a restart isn't
required after `export` + change, but it doesn't hurt):

```bash
export GITHUB_CLIENT_ID="Iv1.xxxxxxxxxxxxxxxx"
export GITHUB_CLIENT_SECRET="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export GITHUB_OAUTH_REDIRECT_URI="http://localhost:8000/api/github/oauth/callback"
# Optional — defaults to "repo" (private + public repo access).
# Set to "public_repo" for public-only, or "" for no repo scopes.
export GITHUB_OAUTH_SCOPES="repo"
```

For Fly (`fly secrets set`):

```bash
fly secrets set \
  GITHUB_CLIENT_ID="Iv1.xxx" \
  GITHUB_CLIENT_SECRET="ghp_xxx" \
  GITHUB_OAUTH_REDIRECT_URI="https://your-app.fly.dev/api/github/oauth/callback"
```

## 3 — Verify

Restart the server. Open Settings → GitHub section:

- If `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are set, the
  **Sign in with GitHub** button is enabled.
- Click it. GitHub asks you to authorize (only the first time per
  scope set). After authorize, you're back on Narrative with
  "✓ Signed in with GitHub — token saved." in the status bar.
- Settings → GitHub now shows **"Signed in as @yourhandle"** in
  the accent color.

If the button is disabled with a "Set GITHUB_CLIENT_ID on the server"
tooltip, double-check `env | grep GITHUB`.

## 4 — Scopes — what to ask for

GitHub OAuth scopes are coarse. Narrative needs read access to
files, and (for `Sync GitHub` to detect commit drift) read access
to repo metadata.

| Scope         | Covers                                              |
| ------------- | --------------------------------------------------- |
| `repo`        | Full read + write on public AND private repos.      |
| `public_repo` | Read-only on public repos. Useful for open books.   |
| (empty)       | Public-only via raw URLs. No private-repo features. |

The default is `repo` because that's what most writers need (they
have private drafts). If you only ever read public repos, switch
to `public_repo`. The frontend doesn't expose this choice to users
— it's an operator decision.

## 5 — Token lifecycle

OAuth tokens issued by user-flow OAuth Apps don't expire by
default. Narrative stores the access token in `localStorage` under
`narrative.githubToken` — the same key the PAT paste uses, so OAuth
and PAT are interchangeable at the storage layer.

To revoke:

- From Narrative: Settings → GitHub → clear field below.
- From GitHub: <https://github.com/settings/applications> →
  Authorized OAuth Apps → revoke. After revoke, any subsequent API
  call from Narrative will 401 and the user gets prompted to
  Sign in again.

## 6 — Security notes

- **HttpOnly state cookie**: Narrative sets a `SameSite=lax`,
  `HttpOnly` cookie for the CSRF state during the redirect. It's
  scoped to `/api/github/oauth/` and lives for 10 minutes.
- **Token transport**: GitHub's redirect returns the token to
  `/api/github/oauth/callback`. Narrative then 302s the browser to
  `/?gh_oauth=success#gh_token=<token>` — the token is in the URL
  **fragment**, which browsers do NOT send to the server. So the
  token never appears in access logs.
- **Frontend cleanup**: on boot, Narrative reads the fragment,
  calls `setGithubToken`, then `history.replaceState(...)` to
  blank the URL so the token isn't sitting in `window.location`
  for any rogue script to read.
- **No client secret on the wire**: the secret only lives in the
  server's env. Never exposed to the browser.
- **HTTPS in production**: the state cookie's `Secure` flag is
  derived from your `GITHUB_OAUTH_REDIRECT_URI` scheme. `https://`
  → `Secure` cookie. Don't use `http://` for anything but
  localhost.
