"""Google Drive OAuth — authorize URL builder + code exchange + refresh.

The standard Google "web server" OAuth 2.0 flow:
https://developers.google.com/identity/protocols/oauth2/web-server

Mirrors github_oauth.py in shape — three pure-ish helpers (build the
authorize URL, trade the code for tokens, refresh an expired access
token), with State generated + validated by the route handlers, not
here. Kept dependency-free so it's easy to unit-test.

Two things differ from the GitHub module, both because we persist the
grant server-side rather than handing a single long-lived token to the
browser:

  * `build_authorize_url` requests `access_type=offline` + `prompt=consent`
    so Google returns a long-lived **refresh token**, not just a 1-hour
    access token.
  * `exchange_code` returns the full token payload dict (access_token,
    refresh_token, expires_in, scope) — the caller stores all of it — and
    there's a `refresh_access_token` helper the GitHub flow never needed.

Scope: default `drive.file` (only files the user picks via Google's
Picker — no app-verification gauntlet) plus `userinfo.email` so we can
show "Connected as <email>" in Settings.
"""

from __future__ import annotations

import base64
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request

import secrets


GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

# drive.file = per-file access granted via the Picker (no verification).
# userinfo.email = lets the callback read which account connected.
DEFAULT_SCOPES = (
    "https://www.googleapis.com/auth/drive.file "
    "https://www.googleapis.com/auth/userinfo.email"
)


class OAuthError(Exception):
    """Raised on any OAuth flow failure — bad code, network error, Google
    returning an error response, etc. Route handlers translate into
    HTTPException for the user-visible error path."""


def generate_state() -> str:
    """CSRF state token. 32 bytes of randomness, URL-safe base64.

    Round-trips through the auth flow as both a query parameter (to
    Google) and an HttpOnly cookie (back to us). The callback handler
    compares the two; mismatched means CSRF / replay / lost session.
    """
    return secrets.token_urlsafe(32)


def generate_pkce() -> tuple[str, str]:
    """Make a PKCE (verifier, challenge) pair (RFC 7636, S256).

    The verifier is a high-entropy secret kept server-side (in our
    HttpOnly cookie) until the token exchange; the challenge —
    base64url(sha256(verifier)) — goes to Google in the authorize URL.
    Google then refuses to mint a token unless the exchange presents the
    verifier whose hash matches, so an intercepted auth code is useless
    without it. OAuth 2.1 recommends this even for confidential clients.
    """
    verifier = secrets.token_urlsafe(64)  # ~86 chars, within 43–128 spec
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorize_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    scopes: str | None = None,
    code_challenge: str | None = None,
) -> str:
    """The URL we 302 the user to after they click 'Sign in with Google'.

    scopes is space-separated per Google's spec. `access_type=offline`
    asks for a refresh token; `prompt=consent` forces the consent screen
    even on re-auth so Google re-issues a refresh token (it only sends
    one on the *first* grant otherwise, which bites users who revoke +
    reconnect). code_challenge enables PKCE (S256) when supplied.
    """
    if not client_id:
        raise OAuthError("GOOGLE_CLIENT_ID not configured")
    if not redirect_uri:
        raise OAuthError("GOOGLE_OAUTH_REDIRECT_URI not configured")
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": (scopes or DEFAULT_SCOPES).strip(),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
        # Carry forward any scopes the user already granted so a re-auth
        # for a new scope doesn't silently drop the old ones.
        "include_granted_scopes": "true",
    }
    if code_challenge:
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
    return f"{GOOGLE_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def _post_token_endpoint(form: dict) -> dict:
    """POST x-www-form-urlencoded to Google's token endpoint, return the
    parsed JSON dict. Shared by exchange_code + refresh_access_token.

    Google returns 400 with a JSON `{error, error_description}` body on a
    bad code / expired refresh token — we read the body off the HTTPError
    so the user sees "invalid_grant" instead of a black-box 400.
    """
    body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "User-Agent": "Narrative/0.1",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        # Google puts the useful error in the response body even on 4xx.
        try:
            err = json.load(e)
            desc = err.get("error_description") or err.get("error") or ""
        except Exception:
            desc = ""
        if desc:
            raise OAuthError(f"Google OAuth error: {desc}") from e
        raise OAuthError(f"Google token endpoint returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise OAuthError(f"could not reach Google: {e}") from e

    if not isinstance(payload, dict):
        raise OAuthError("unexpected response shape from Google")
    if payload.get("error"):
        desc = payload.get("error_description") or payload["error"]
        raise OAuthError(f"Google OAuth error: {desc}")
    return payload


def exchange_code(
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
    code_verifier: str | None = None,
) -> dict:
    """Trade the ?code=... Google sent us for a token bundle.

    Returns the full payload dict: at minimum `access_token`,
    `expires_in`, `scope`, and (because we asked for offline access)
    `refresh_token`. The caller persists all of it per tenant.
    code_verifier completes the PKCE exchange when the authorize URL was
    built with a challenge.

    Raises OAuthError on any failure — network blip, expired/replayed
    code (`invalid_grant`), misconfigured client, etc.
    """
    if not client_id or not client_secret:
        raise OAuthError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured")
    if not code:
        raise OAuthError("missing authorization code")

    form = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    if code_verifier:
        form["code_verifier"] = code_verifier
    payload = _post_token_endpoint(form)

    token = payload.get("access_token")
    if not token or not isinstance(token, str):
        raise OAuthError("no access_token in Google response")
    return payload


def refresh_access_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> dict:
    """Mint a fresh access token from a stored refresh token.

    Returns the payload dict (`access_token`, `expires_in`, `scope`).
    Google does NOT return a new refresh_token here — the original keeps
    working until the user revokes it, so the caller reuses the one it
    already has.

    A revoked / expired refresh token comes back as `invalid_grant`,
    surfaced as OAuthError — the caller should treat that as "the user
    must reconnect" and clear the stored grant.
    """
    if not client_id or not client_secret:
        raise OAuthError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured")
    if not refresh_token:
        raise OAuthError("missing refresh token")

    payload = _post_token_endpoint({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    })

    token = payload.get("access_token")
    if not token or not isinstance(token, str):
        raise OAuthError("no access_token in Google refresh response")
    return payload


def revoke_token(token: str) -> bool:
    """Revoke a grant at Google so disconnecting actually kills it server-
    side, not just locally. Revoking the refresh token invalidates the
    whole grant (and any derived access tokens).

    Best-effort: returns True on success, False on failure (already
    revoked / expired / network blip). Never raises — the caller still
    drops the local row regardless, so a Google-side hiccup can't leave
    the user unable to disconnect.
    """
    if not token:
        return False
    body = urllib.parse.urlencode({"token": token}).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_REVOKE_URL,
        data=body,
        method="POST",
        headers={
            "User-Agent": "Narrative/0.1",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:
        # 400 = token already invalid (fine); network error = nothing we
        # can do here. Either way the local grant is being deleted.
        return False


# ── Write-back (v4.223): push a clip's revised text into the Drive file ──
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
GOOGLE_DOC_MIME = "application/vnd.google-apps.document"


def update_file_media(
    access_token: str,
    file_id: str,
    content: str,
    source_mime: str | None,
) -> dict:
    """Overwrite a Drive file's content with `content` (UTF-8 text).

    The `drive.file` scope permits updating files the user opened via the
    Picker (which is exactly how these clips were imported), so no broader
    grant is needed for the round-trip.

    Two cases we support:
      * **Google Doc** (`application/vnd.google-apps.document`) — upload the
        text as `text/plain`; Drive converts it back INTO the existing Doc,
        replacing its body (the file stays a Doc). Rich formatting in the
        Doc is lost — text wins, decorations don't, same tradeoff as the
        Scrivener push.
      * **text/\\*** (a `.md`/`.txt` the user uploaded to Drive, or an
        octet-stream we treat as text) — media-overwrite with the bytes.

    Binary types we can't faithfully serialize from plain text (`.docx`,
    `.pdf`, …) raise ValueError so the caller can tell the user to export a
    text/markdown copy instead — silently writing text into a .docx wrapper
    would corrupt it.

    Returns the updated Drive file resource (id, name, mimeType,
    modifiedTime). Raises ValueError (unsupported type) or
    urllib.error.HTTPError (API failure).
    """
    mime = (source_mime or "").strip().lower()
    is_doc = mime == GOOGLE_DOC_MIME
    is_texty = (
        mime.startswith("text/")
        or mime in ("", "application/octet-stream", "application/json")
    )
    if not (is_doc or is_texty):
        raise ValueError(
            f"Drive file type {source_mime!r} can't be updated as text — "
            f"export a Markdown or plain-text copy to push into instead"
        )

    params = urllib.parse.urlencode(
        {"uploadType": "media", "fields": "id,name,mimeType,modifiedTime"}
    )
    url = f"{DRIVE_UPLOAD_URL}/{urllib.parse.quote(file_id)}?{params}"
    data = content.encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PATCH")
    req.add_header("Authorization", f"Bearer {access_token}")
    # text/plain is the convertible type that makes Drive replace a Google
    # Doc's body; for a plain text file it's just the stored content-type.
    req.add_header("Content-Type", "text/plain; charset=UTF-8")
    req.add_header("User-Agent", "Narrative/0.1")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    try:
        return json.loads(raw)
    except Exception:
        return {"id": file_id}
