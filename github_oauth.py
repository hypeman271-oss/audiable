"""GitHub OAuth — authorize URL builder + code exchange.

The web server-side OAuth pattern from
https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow

Two helpers, both pure: build the URL we redirect the user to, and
trade the code GitHub sends back for an access token. State is
generated and validated by the route handlers, not here — keeping
this module dependency-free + easy to unit-test.

PAT paste remains the fallback for users who don't want to register
an OAuth App on their server (and for fine-grained tokens / GHE).
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request


GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"


class OAuthError(Exception):
    """Raised on any OAuth flow failure — bad code, network error,
    GitHub returning an error response, etc. Route handlers translate
    into HTTPException for the user-visible error path."""


def generate_state() -> str:
    """CSRF state token. 32 bytes of randomness, URL-safe base64.

    Round-trips through the auth flow as both a query parameter (to
    GitHub) and an HttpOnly cookie (back to us). The callback handler
    compares the two; mismatched means CSRF / replay / lost session.
    """
    return secrets.token_urlsafe(32)


def build_authorize_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    scopes: str | None = None,
) -> str:
    """The URL we 302 the user to after they click 'Sign in with GitHub'.

    scopes is space-separated per GitHub's spec. Default `repo` gets
    private-repo read/write; operators who only need public access
    can override via env to `public_repo` or empty.
    """
    if not client_id:
        raise OAuthError("GITHUB_CLIENT_ID not configured")
    if not redirect_uri:
        raise OAuthError("GITHUB_OAUTH_REDIRECT_URI not configured")
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "scope": (scopes or "repo").strip(),
        # allow_signup=true is GitHub's default; pass it explicitly so
        # the behavior doesn't shift if they change the default later.
        "allow_signup": "true",
    }
    return f"{GITHUB_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_code(
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> str:
    """Trade the ?code=... GitHub sent us for an access token.

    Returns the raw token string. Raises OAuthError on any failure —
    network blip, expired/replayed code, GitHub returning
    `error=bad_verification_code`, etc.

    GitHub returns either URL-encoded form data (legacy) or JSON
    when we ask for `Accept: application/json`. We ask for JSON.
    """
    if not client_id or not client_secret:
        raise OAuthError("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not configured")
    if not code:
        raise OAuthError("missing authorization code")

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
    }).encode("utf-8")

    req = urllib.request.Request(
        GITHUB_TOKEN_URL,
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
        # GitHub almost always returns 200 here — even on a bad code.
        # An HTTPError means something fundamentally wrong (network,
        # github.com down, our request malformed).
        raise OAuthError(f"GitHub token endpoint returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise OAuthError(f"could not reach GitHub: {e}") from e

    if not isinstance(payload, dict):
        raise OAuthError("unexpected response shape from GitHub")
    # On failure, GitHub returns { "error": "...", "error_description": "..." }
    # rather than HTTP non-2xx. Surface the description so the user can
    # see "the code passed is incorrect or expired" instead of a generic
    # error.
    if payload.get("error"):
        desc = payload.get("error_description") or payload["error"]
        raise OAuthError(f"GitHub OAuth error: {desc}")

    token = payload.get("access_token")
    if not token or not isinstance(token, str):
        raise OAuthError("no access_token in GitHub response")
    return token
