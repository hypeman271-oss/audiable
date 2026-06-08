"""File-format dispatcher for converting uploaded documents into plain text.

extract_text(filename, file_bytes) -> str

Supported extensions:
    .txt, .md, .markdown    Decoded straight from UTF-8 (with BOM handling).
    .pdf                    PyMuPDF (fitz) — handles columns and most layouts.
    .epub                   ebooklib + BeautifulSoup — reads document items in
                            spine order so chapters come out sequentially.
    .docx                   python-docx — paragraphs in document order.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import PurePath


class UnsupportedFormatError(ValueError):
    pass


class ExtractionError(RuntimeError):
    pass


MAX_URL_FETCH_BYTES = 5 * 1024 * 1024  # 5 MB cap on fetched HTML


# File extensions the repo browser surfaces in its file list. Keep in
# sync with the upload-file accepted types and the fetch_and_extract_url
# file-URL branch — these are what the existing extract_text dispatcher
# knows how to parse.
GITHUB_BROWSE_EXTENSIONS = {
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".docx",
    ".pdf",
    ".epub",
}


def _parse_gist_id(url: str) -> str | None:
    """Pull the Gist id out of a gist.github.com URL.

    Accepts these shapes (per GitHub's URL scheme):
        https://gist.github.com/<id>
        https://gist.github.com/<user>/<id>
        https://gist.github.com/<user>/<id>#file-foo-md
        https://gist.github.com/<user>/<id>/raw/<sha>/<file>

    The id is the alphanumeric path segment (typically 32 hex chars,
    but can be shorter for older Gists). Returns None if the URL is
    not a Gist or the id doesn't look like one.
    """
    import re
    import urllib.parse

    parsed = urllib.parse.urlparse((url or "").strip())
    if parsed.hostname not in ("gist.github.com",):
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if not parts:
        return None
    # Last "/<32 hex>" segment in /<user>/<id> form, or the only
    # segment in /<id> form. Older Gists used decimal-ish ids; new
    # ones are 32 hex. Accept anything alphanumeric of length >= 7.
    candidate = None
    for p in parts:
        if re.fullmatch(r"[A-Za-z0-9]{7,40}", p):
            candidate = p
    return candidate


def fetch_gist_meta(
    gist_id: str,
    github_token: str | None = None,
) -> dict:
    """Look up a Gist's metadata + file list via the GitHub API.

    Returns:
        {"id": str, "owner": str | None, "description": str,
         "files": [{"filename": str, "size": int, "language": str,
                    "raw_url": str, "type": str}, ...]}

    Raises ExtractionError on any failure. Gist API has a generous
    public rate limit + works without a token for public gists, so
    github_token is optional. Private gists require a token.
    """
    import json
    import urllib.error
    import urllib.request

    if not gist_id:
        raise ExtractionError("missing gist id")

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Narrative/0.1",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    url = f"https://api.github.com/gists/{gist_id}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        hint = (
            " — gist may be private; set a Personal Access Token"
            if e.code == 404
            else ""
        )
        raise ExtractionError(
            f"GitHub Gist fetch failed: HTTP {e.code}{hint}"
        ) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ExtractionError(f"could not reach GitHub: {e}") from e

    files_obj = data.get("files") or {}
    files: list[dict] = []
    for fname, info in files_obj.items():
        if not isinstance(info, dict):
            continue
        files.append({
            "filename": info.get("filename") or fname,
            "size": int(info.get("size") or 0),
            "language": info.get("language") or "",
            "raw_url": info.get("raw_url") or "",
            "type": info.get("type") or "",
        })
    files.sort(key=lambda f: f["filename"].lower())

    owner_obj = data.get("owner") or {}
    return {
        "id": data.get("id") or gist_id,
        "owner": owner_obj.get("login") if isinstance(owner_obj, dict) else None,
        "description": data.get("description") or "",
        "files": files,
    }


def _parse_github_repo_url(url: str) -> tuple[str | None, str | None]:
    """Pull (owner, repo) out of a github.com or GHE URL. Accepts repo
    roots (`<host>/owner/repo`), nested paths (any subpath under it),
    and `.git` suffix. Returns (None, None) for anything else.

    v181: also accepts any host listed in the GITHUB_ENTERPRISE_HOSTS
    env var — same path shape, GHE just lives at a different hostname.
    The host itself is exposed via _parse_github_repo_url_host so
    callers that need to build API URLs can route to the right base.
    """
    import urllib.parse

    parsed = urllib.parse.urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if host not in ("github.com", "www.github.com") and host not in _get_enterprise_hosts():
        return None, None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        return None, None
    owner = parts[0]
    repo = parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    return owner, repo


def _parse_github_repo_url_host(url: str) -> str | None:
    """Return the host portion of a repo URL (lowercased) so callers
    can build host-aware API URLs. Returns None for non-GitHub URLs."""
    import urllib.parse
    parsed = urllib.parse.urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if host in ("github.com", "www.github.com"):
        return "github.com"
    if host in _get_enterprise_hosts():
        return host
    return None


def fetch_github_tree(
    owner: str,
    repo: str,
    branch: str | None = None,
    github_token: str | None = None,
    host: str | None = None,
) -> dict:
    """List the text-format files in a GitHub repo.

    Calls the GitHub REST API directly with the user's PAT (so private
    repos work). Filters to extensions the file-upload dispatcher can
    handle. Returns:
        {"owner": str, "repo": str, "branch": str, "files": [{path, size}],
         "truncated": bool}

    Raises ExtractionError on API failures so the route handler maps
    them to a 422 with the message preserved (same pattern as the URL
    extractor).
    """
    import json
    import urllib.error
    import urllib.request

    if not owner or not repo:
        raise ExtractionError("invalid GitHub owner/repo")

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Narrative/0.1",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    api_base = _github_api_base(host)
    # Look up the default branch when one wasn't supplied. Saves the
    # user from having to guess between main/master/develop/&c.
    if not branch:
        meta_url = f"{api_base}/repos/{owner}/{repo}"
        try:
            req = urllib.request.Request(meta_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                meta = json.load(resp)
            branch = meta.get("default_branch") or "main"
        except urllib.error.HTTPError as e:
            hint = (
                " — set a Personal Access Token in Settings → GitHub"
                if e.code in (401, 403, 404)
                else ""
            )
            raise ExtractionError(
                f"GitHub repo lookup failed: HTTP {e.code}{hint}"
            ) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ExtractionError(f"could not reach GitHub: {e}") from e

    tree_url = (
        f"{api_base}/repos/{owner}/{repo}"
        f"/git/trees/{branch}?recursive=1"
    )
    try:
        req = urllib.request.Request(tree_url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        raise ExtractionError(f"GitHub tree fetch failed: HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ExtractionError(f"could not reach GitHub: {e}") from e

    files: list[dict] = []
    for entry in data.get("tree", []) or []:
        if entry.get("type") != "blob":
            continue
        path = entry.get("path") or ""
        if not path:
            continue
        ext = PurePath(path).suffix.lower()
        if ext not in GITHUB_BROWSE_EXTENSIONS:
            continue
        files.append({
            "path": path,
            "size": int(entry.get("size") or 0),
            # SHA travels back to the frontend so it can store gitRef on
            # the saved clip; the sync-check endpoint compares against
            # this SHA later to detect commits.
            "sha": entry.get("sha") or "",
        })
    files.sort(key=lambda f: f["path"].lower())

    return {
        "owner": owner,
        "repo": repo,
        "branch": branch,
        "files": files,
        "truncated": bool(data.get("truncated")),
    }


def fetch_github_branches(
    owner: str,
    repo: str,
    github_token: str | None = None,
    host: str | None = None,
) -> dict:
    """List the branches in a GitHub repo + the default branch name.

    Backs the v179 branch dropdown in the picker. The user might be on
    a feature branch (`drafts/chapter-10`) while the default branch
    still points at the last release — we surface both so they can
    flip between them without re-typing the URL.

    Returns:
        {"owner": str, "repo": str,
         "default_branch": str,
         "branches": [str, ...]}  # sorted, default branch first

    Paginates if the repo has >100 branches (GitHub API max page size).
    Capped at 5 pages (500 branches) so a runaway monorepo doesn't
    stall the picker — far more than any manuscript repo needs.

    Raises ExtractionError on API failures; the route handler maps to
    HTTP 422 with the message preserved (same pattern as fetch_github_tree).
    """
    import json
    import urllib.error
    import urllib.request

    if not owner or not repo:
        raise ExtractionError("invalid GitHub owner/repo")

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Narrative/0.1",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    api_base = _github_api_base(host)
    # Default branch name first (so we can sort it to the top of the
    # branch list). Reusing the same /repos endpoint fetch_github_tree
    # uses when no branch is supplied.
    meta_url = f"{api_base}/repos/{owner}/{repo}"
    try:
        req = urllib.request.Request(meta_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            meta = json.load(resp)
        default_branch = meta.get("default_branch") or "main"
    except urllib.error.HTTPError as e:
        hint = (
            " — set a Personal Access Token in Settings → GitHub"
            if e.code in (401, 403, 404)
            else ""
        )
        raise ExtractionError(
            f"GitHub repo lookup failed: HTTP {e.code}{hint}"
        ) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ExtractionError(f"could not reach GitHub: {e}") from e

    # Paginate the /branches endpoint. per_page=100 is the max GitHub
    # allows; the 5-page cap covers 500 branches — far more than any
    # manuscript repo would have.
    branches: list[str] = []
    for page in range(1, 6):
        page_url = (
            f"{api_base}/repos/{owner}/{repo}"
            f"/branches?per_page=100&page={page}"
        )
        try:
            req = urllib.request.Request(page_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                page_data = json.load(resp)
        except urllib.error.HTTPError as e:
            raise ExtractionError(
                f"GitHub branches fetch failed: HTTP {e.code}"
            ) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ExtractionError(f"could not reach GitHub: {e}") from e

        if not isinstance(page_data, list) or not page_data:
            break
        for entry in page_data:
            name = entry.get("name") if isinstance(entry, dict) else None
            if name and isinstance(name, str):
                branches.append(name)
        # Short page = last page, stop paginating.
        if len(page_data) < 100:
            break

    # Sort: default branch first, then alphabetical. Stable ordering so
    # the dropdown reads predictably across calls.
    branches_set = sorted(set(branches), key=lambda s: s.lower())
    if default_branch in branches_set:
        branches_set.remove(default_branch)
    ordered = [default_branch] + branches_set

    return {
        "owner": owner,
        "repo": repo,
        "default_branch": default_branch,
        "branches": ordered,
    }


def _parse_github_raw_url(url: str) -> tuple[str | None, str | None, str | None, str | None]:
    """Pull (owner, repo, branch, path) out of either a raw URL or a
    github.com (or GHE) blob URL. Returns all-None for anything else.

    v181: GHE hosts are recognized at any of the same paths github.com
    uses. They don't have a separate raw-URL host (the raw bytes live
    on the same hostname under /<owner>/<repo>/raw/<branch>/<path>).
    """
    import urllib.parse

    parsed = urllib.parse.urlparse((url or "").strip())
    parts = [p for p in parsed.path.split("/") if p]
    host = (parsed.hostname or "").lower()
    if host == "raw.githubusercontent.com":
        # /owner/repo/branch/path/to/file.md
        if len(parts) < 4:
            return None, None, None, None
        return parts[0], parts[1], parts[2], "/".join(parts[3:])
    if host in ("github.com", "www.github.com") or host in _get_enterprise_hosts():
        # /owner/repo/blob/branch/path/to/file.md
        # /owner/repo/raw/branch/path/to/file.md
        if len(parts) < 5 or parts[2] not in ("blob", "raw"):
            return None, None, None, None
        return parts[0], parts[1], parts[3], "/".join(parts[4:])
    return None, None, None, None


def fetch_github_file_sha(
    owner: str,
    repo: str,
    branch: str,
    path: str,
    github_token: str | None = None,
    host: str | None = None,
) -> str:
    """Look up the current SHA for a single file via the GitHub contents
    API. Used by the sync-check path when the caller didn't pre-supply a
    SHA (e.g., a Level-1 single-file URL paste).

    Returns the SHA string, or empty string if the lookup fails — caller
    treats empty as "couldn't check" rather than "no change."
    """
    import json
    import urllib.error
    import urllib.parse
    import urllib.request

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Narrative/0.1",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    api_url = (
        f"{_github_api_base(host)}/repos/{owner}/{repo}/contents/"
        f"{urllib.parse.quote(path)}?ref={urllib.parse.quote(branch)}"
    )
    try:
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        return data.get("sha") or ""
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return ""


_GITHUB_HOSTS = {
    "github.com",
    "raw.githubusercontent.com",
    "www.github.com",
    # v181: Gist raw file URLs come from a distinct subdomain (it's the
    # CDN that fronts the gist file contents). Without this, the
    # authenticated fetch path drops the Bearer token for private gist
    # raw URLs and the fetch 404s.
    "gist.github.com",
    "gist.githubusercontent.com",
}


# v181: GitHub Enterprise support. The operator opts in via env var
# GITHUB_ENTERPRISE_HOSTS = "git.mycompany.com,git.other.com" — comma
# separated list of GHE hostnames. When set, those hosts:
#   - get treated like github.com for URL parsing (owner/repo
#     extraction, raw-URL rewriting, SSRF allowlist)
#   - route API calls to /api/v3 instead of api.github.com
# Reading at call time so a restart isn't required after `export`.
def _get_enterprise_hosts() -> set[str]:
    import os
    raw = os.environ.get("GITHUB_ENTERPRISE_HOSTS", "")
    out: set[str] = set()
    for part in raw.split(","):
        part = part.strip().lower()
        if part:
            out.add(part)
    return out


def _is_github_host(host: str | None) -> bool:
    """github.com / www.github.com / known raw hosts / any GHE host."""
    if not host:
        return False
    h = host.lower()
    if h in _GITHUB_HOSTS:
        return True
    return h in _get_enterprise_hosts()


def _github_api_base(host: str | None) -> str:
    """API base URL for the given host.

    github.com → https://api.github.com (the public REST API).
    Any GHE host → https://<host>/api/v3 (GitHub Enterprise convention).
    Returns the public api.github.com as a safe default for unknown hosts.
    """
    if not host:
        return "https://api.github.com"
    h = host.lower()
    if h in ("github.com", "www.github.com"):
        return "https://api.github.com"
    if h in _get_enterprise_hosts():
        return f"https://{h}/api/v3"
    return "https://api.github.com"


def _github_raw_base(host: str | None, owner: str, repo: str, branch: str, path: str) -> str:
    """Build the raw-file URL for a host/owner/repo/branch/path.

    github.com → raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
    GHE host → <host>/<owner>/<repo>/raw/<branch>/<path>
    """
    if host and host.lower() in _get_enterprise_hosts():
        return f"https://{host}/{owner}/{repo}/raw/{branch}/{path}"
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"


def _github_host_for_token(host: str | None) -> bool:
    """Should we forward the user's PAT/OAuth token to requests for
    this host? Public github.com + raw + gist + every configured GHE
    host all qualify."""
    return _is_github_host(host)


def _rewrite_github_url(url: str) -> str:
    """Convert github.com / GHE blob URLs to their raw equivalents.

    Blob URLs return the HTML file-browser page; the raw URLs return
    the file's actual bytes. The fetcher always wants bytes, so
    silently rewrite. URLs that don't match the blob pattern (raw
    URLs already, repo roots, gists, etc.) pass through unchanged.

    v181: GHE uses the same path layout — only the raw host differs.
    For github.com → raw.githubusercontent.com. For GHE we use the
    host's own /raw path (`<host>/<owner>/<repo>/raw/<branch>/<path>`).
    """
    import re
    import urllib.parse

    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    is_dot_com = host in ("github.com", "www.github.com")
    is_ghe = host in _get_enterprise_hosts()
    if not (is_dot_com or is_ghe):
        return url
    # /user/repo/blob/branch/path/to/file.md
    # /user/repo/raw/branch/path/to/file.md
    m = re.match(
        r"^/([^/]+)/([^/]+)/(?:blob|raw)/([^/]+)/(.+)$",
        parsed.path,
    )
    if not m:
        return url
    user, repo, branch, path = m.groups()
    return _github_raw_base(host, user, repo, branch, path)


def fetch_and_extract_url(
    url: str,
    github_token: str | None = None,
    git_sha: str | None = None,
) -> dict:
    """Fetch an article URL and return its main text + metadata.

    Args:
        url: any http(s) URL. GitHub blob URLs are auto-rewritten to
            their raw form so the fetcher sees the file bytes, not the
            file-browser HTML.
        github_token: optional Personal Access Token for private GitHub
            repos. Sent as `Authorization: Bearer <token>` ONLY when the
            URL points at github.com / raw.githubusercontent.com — never
            leaked to other hosts.

    Returns:
        {"filename": <hostname or filename>, "chars": int, "text": str,
         "images": list[dict]}

    Raises:
        ValueError for bad URLs / SSRF-suspicious targets (the endpoint
            maps these to HTTP 400 so they don't look like server bugs).
        ExtractionError for fetch failures, unsupported content types,
            and pages with no extractable article text.
    """
    import ipaddress
    import socket
    import urllib.error
    import urllib.parse
    import urllib.request

    url = _rewrite_github_url((url or "").strip())

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL must start with http:// or https://")
    if not parsed.hostname:
        raise ValueError("invalid URL")

    # SSRF guard: resolve the hostname now and refuse anything that resolves
    # to a private / loopback / link-local / reserved / multicast address.
    # Not bulletproof (DNS could rebind between this check and the actual
    # HTTP connection), but covers the obvious attacks for a personal app.
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addrs = socket.getaddrinfo(parsed.hostname, port)
    except socket.gaierror:
        raise ValueError(f"could not resolve {parsed.hostname}")

    # v181: if the host is an operator-configured GHE endpoint (set via
    # GITHUB_ENTERPRISE_HOSTS), allow private IPs. Most enterprise
    # deployments live on a corporate intranet, and the operator
    # opted in by listing the host. github.com / public hosts still
    # go through the full guard.
    ghe_bypass = (parsed.hostname or "").lower() in _get_enterprise_hosts()
    for ai in addrs:
        ip_str = ai[4][0]
        # IPv4-mapped IPv6 like ::ffff:127.0.0.1 — unmap and recheck below.
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_unspecified
            or ip.is_reserved
            or ip.is_multicast
        ):
            if ghe_bypass:
                continue
            raise ValueError(
                f"refusing to fetch non-public address: {ip_str}"
            )

    # Detect known-file URLs (raw markdown, plain text, docx, pdf, epub
    # served directly). These skip trafilatura and go through the same
    # extract_text dispatcher that the file-upload path uses.
    file_ext = PurePath(parsed.path).suffix.lower().lstrip(".")
    is_file_url = file_ext in _HANDLERS

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; Narrative/0.1; +local TTS reader)"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }
    # Broaden Accept for raw-file URLs so servers that content-negotiate
    # (GitHub raw, S3 with content-type sniffing) don't refuse to return
    # the bytes we want.
    if is_file_url:
        headers["Accept"] = "*/*"
    else:
        headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    # GitHub PAT auth — ONLY attached when both:
    #   a) the caller supplied a token, AND
    #   b) the target host is GitHub (post-rewrite).
    # The host check matters: never leak the token to a third-party
    # site, including a redirect target. urllib's default redirect
    # handler does carry headers through, so the explicit host check
    # here is the only line of defense.
    if github_token and parsed.hostname in _GITHUB_HOSTS:
        headers["Authorization"] = f"Bearer {github_token}"

    req = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = (resp.headers.get("Content-Type") or "").lower()
            # Loosened MIME check for file URLs (raw markdown is text/plain;
            # docx is application/vnd.openxmlformats...; pdf is application/pdf).
            if not is_file_url:
                if "html" not in content_type and "xml" not in content_type and "text" not in content_type:
                    raise ExtractionError(
                        f"unsupported content type for URL: {content_type or '(none)'}"
                    )
            # Cap on response size so a 1 GB page doesn't OOM us.
            raw = resp.read(MAX_URL_FETCH_BYTES + 1)
            if len(raw) > MAX_URL_FETCH_BYTES:
                raise ExtractionError(
                    f"page too large (> {MAX_URL_FETCH_BYTES // (1024 * 1024)} MB)"
                )
    except urllib.error.HTTPError as e:
        # Friendly hint for the common case: 404 on a github.com URL
        # often means the token is missing or doesn't have repo scope.
        hint = ""
        if parsed.hostname in _GITHUB_HOSTS and e.code in (401, 403, 404):
            hint = (
                " — if this is a private repo, paste a Personal Access "
                "Token in Settings &rarr; GitHub"
            )
        raise ExtractionError(f"HTTP {e.code} fetching URL{hint}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ExtractionError(f"could not fetch URL: {e}") from e

    # File-URL branch: skip trafilatura, route through the shared
    # extract_text dispatcher (same code the upload path uses). Returns
    # plain text and no images — the chapter detector in the frontend
    # handles markdown headings on its own.
    if is_file_url:
        filename = PurePath(parsed.path).name or parsed.hostname or "url"
        # v4.80 (#849): for markdown files we split the frontmatter out
        # ourselves so we can hand it back to the client and let it ride
        # back to GitHub on the next push. Other file types
        # (PDF/DOCX/EPUB/TXT) go through the regular dispatcher — they
        # don't have a YAML-frontmatter equivalent we need to preserve.
        frontmatter_block = ""
        if file_ext in ("md", "markdown"):
            decoded = _extract_plain(raw)
            frontmatter_block, body = _split_yaml_frontmatter(decoded)
            text = body
        else:
            text = extract_text(filename, raw)
        if not text.strip():
            raise ExtractionError("file is empty or unreadable")
        result = {
            "filename": filename,
            "chars": len(text),
            "text": text,
            "images": [],
        }
        # If this is a GitHub raw URL, attach a gitRef so the frontend
        # can store it on the saved clip. Lets the update-checker know
        # which repo+branch+path to compare against later.
        owner_, repo_, branch_, path_ = _parse_github_raw_url(url)
        if owner_ and repo_:
            # v181: derive the canonical "human" host from the URL so
            # GHE clips get a repoUrl pointing at their GHE host, not
            # github.com. raw.githubusercontent.com always maps back
            # to github.com (that's where the user would browse the
            # repo); GHE raw paths live on the same host.
            import urllib.parse as _up
            raw_host = (_up.urlparse(url).hostname or "").lower()
            if raw_host == "raw.githubusercontent.com":
                canonical_host = "github.com"
            elif raw_host in _get_enterprise_hosts():
                canonical_host = raw_host
            else:
                canonical_host = "github.com"
            sha = git_sha or fetch_github_file_sha(
                owner_, repo_, branch_, path_,
                github_token=github_token,
                host=canonical_host,
            )
            result["gitRef"] = {
                "repoUrl": f"https://{canonical_host}/{owner_}/{repo_}",
                "branch": branch_,
                "path": path_,
                "sha": sha,
                # v181: host is opaque to old clients (they ignored
                # unknown gitRef fields) but lets the future
                # sync-check path route to GHE's API. Optional.
                "host": canonical_host,
            }
        return result

    # Decode using the response charset (Content-Type) when present;
    # fall back to UTF-8, then latin-1, so a stray encoding doesn't crash us.
    encoding = ""
    if "charset=" in content_type:
        encoding = content_type.split("charset=", 1)[1].split(";")[0].strip()
    html = ""
    for enc in (encoding, "utf-8", "latin-1"):
        if not enc:
            continue
        try:
            html = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if not html:
        html = raw.decode("utf-8", errors="replace")

    import re
    import urllib.parse as _urlparse
    import trafilatura

    # Markdown output preserves image references as standard ![alt](src)
    # syntax so we can pull them out with a regex. include_images=True
    # tells trafilatura not to drop <img> tags during extraction.
    md = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        favor_recall=True,
        include_images=True,
        output_format="markdown",
    )

    if not md or not md.strip():
        raise ExtractionError("no article text found at URL")

    # Trafilatura's body extraction strips <h1>-<h3> tags on some sources
    # (notably Project Gutenberg's text-page format) — it identifies the
    # chapter headings as boilerplate and drops them entirely, leaving
    # the body as one continuous river of prose with blank-line gaps
    # where the chapter boundaries used to be. The frontend's chapter
    # auto-split can't see those gaps. Re-inject the headings from a
    # direct BS4 pass on the raw HTML so `## CHAPTER I` ends up in the
    # markdown the client receives. No-op when trafilatura already
    # preserved the headings (Standard Ebooks, most blog posts).
    md = _inject_html_headings(html, md)
    # Same root cause for images: trafilatura also drops <img> tags from
    # body content it considers boilerplate. Without injection, every PG
    # illustrated book (Wizard of Oz, Alice, Peter Pan, &c.) extracts as
    # text-only. Re-inject `![alt](src)` markdown so the IMG_RE loop
    # below picks them up. No-op when trafilatura already preserved.
    md = _inject_html_images(html, md, url)

    # Pull images out of the markdown into a structured list with a
    # rough "after sentence N" position; strip the markers from the text
    # so synthesis stays clean. Sentence-counting is approximate (just
    # ., !, ? followed by whitespace or EOL) — image positioning will
    # be in the right neighborhood, not frame-accurate.
    IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)")
    SENT_END_RE = re.compile(r"[.!?](?=\s|$)")

    images = []
    clean_lines = []
    sentence_cursor = 0

    for raw_line in md.split("\n"):
        # Record any images in this line FIRST so they anchor at the
        # current sentence boundary, then strip them.
        for m in IMG_RE.finditer(raw_line):
            src = m.group(2)
            # Resolve relative URLs against the page URL so <img src="img/foo.jpg">
            # on en.wikipedia.org becomes the absolute en.wikipedia.org/.../foo.jpg.
            try:
                src = _urlparse.urljoin(url, src)
            except Exception:
                pass
            images.append({
                "sentence_index": sentence_cursor,
                "src": src,
                "alt": m.group(1).strip(),
            })
        line = IMG_RE.sub("", raw_line).strip()
        if line:
            sentence_cursor += max(1, len(SENT_END_RE.findall(line)))
        clean_lines.append(line)

    text = "\n".join(clean_lines)
    text = _normalize(text)

    if not text.strip():
        raise ExtractionError("no article text found at URL")

    # v225v3.73 (#806): index-page guard. The original bug a user hit
    # — pasting https://freeread.de/@RGLibrary/Unknown/Unknown.html
    # into Import URL — surfaced a class of failure where the page is
    # a directory listing (alphabetised table of story titles + nav
    # chrome) with no article prose. Trafilatura dutifully returned
    # the table cells, and the app saved 9 KB of "Authors | Authors |
    # Roy Glashan's Library |…" to the user's library. They expected a
    # story; they got nav.
    #
    # Heuristic signals (page must be substantive enough to bother
    # measuring — the floor is 500 chars):
    #
    #   - Sentence density: terminal punctuation per char. Real prose
    #     runs 1.5–2.5%; index pages run <0.5% because rows are just
    #     "Title | Author | Year | HTML | EPUB". Threshold 0.005 (~1
    #     sentence per 200 chars) catches the freeread.de case at
    #     0.0024 with margin and never trips on normal articles.
    #
    #   - Pipe density: `|` characters as a fraction of text. Pipes
    #     are the markdown-table delimiter trafilatura emits. The RGL
    #     index runs >10% pipes; the threshold is 5%. Wikipedia
    #     infobox tables come in at <2% because the body prose
    #     dominates the page.
    #
    # Either signal alone trips the guard — both happen together for
    # real indexes, but a one-signal trip is still informative and
    # better than saving chrome to the library.
    n_sentences = len(SENT_END_RE.findall(text))
    n_chars = len(text)
    n_pipes = text.count("|")
    if n_chars >= 500:
        sentence_density = n_sentences / n_chars
        pipe_density = n_pipes / n_chars
        if sentence_density < 0.005 or pipe_density > 0.05:
            raise ExtractionError(
                "this URL looks like a directory/index page, not an "
                "article — try a specific story or chapter URL instead "
                f"(sentence density {sentence_density:.3f}, pipe "
                f"density {pipe_density:.3f})"
            )

    return {
        "filename": parsed.hostname or "url",
        "chars": len(text),
        "text": text,
        "images": images,
    }


def extract_text(filename: str, data: bytes) -> str:
    if not data:
        raise ExtractionError("empty file")
    ext = PurePath(filename).suffix.lower().lstrip(".")
    handler = _HANDLERS.get(ext)
    if not handler:
        raise UnsupportedFormatError(f"unsupported file type: .{ext or '(none)'}")
    try:
        text = handler(data)
    except (UnsupportedFormatError, ExtractionError):
        raise
    except Exception as e:
        raise ExtractionError(f"could not extract text: {e}") from e
    return _normalize(text)


# ---- per-format handlers -------------------------------------------------


def _extract_plain(data: bytes) -> str:
    # Try UTF-8 (with optional BOM) first; fall back to latin-1 so we never
    # crash on a stray encoding — TTS will still read most chars sensibly.
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# Match `---` on its own line (allowing trailing whitespace), which
# is how YAML/Jekyll frontmatter fences itself.
_FRONTMATTER_FENCE_RE = re.compile(r"(?m)^---\s*$")


def _split_yaml_frontmatter(text: str) -> tuple[str, str]:
    """Split a Markdown doc into (frontmatter_block, body).

    The frontmatter_block, if present, includes the opening `---\\n`,
    the YAML body, and the closing `---\\n` — i.e. it's the verbatim
    prefix that can be prepended to a revised body to round-trip the
    file on GitHub push-back without losing metadata.

    Recognized shapes:
      - Opens with `---` on the first line (LF or CRLF).
      - Closes with `---` on its own line later.
    Returns ``("", text)`` for anything not matching — including the
    "`---` used as a horizontal-rule chapter break" case (no closer
    found within the document), so the original v220as guard still
    holds.

    v4.80 (#849): split out from _strip_yaml_frontmatter so the push-back
    path can preserve the frontmatter alongside the body. _strip_…
    keeps its old return shape (just the body).
    """
    if not text:
        return "", text
    if not (text.startswith("---\n") or text.startswith("---\r\n")):
        return "", text
    fence = _FRONTMATTER_FENCE_RE.search(text[3:])
    if not fence:
        # Opener with no closer — likely a horizontal rule used as
        # a chapter break ("---"), not frontmatter. Leave it.
        return "", text
    # End of the closing `---` line, measured from the start of the
    # full text. Include the trailing newline(s) so the caller can
    # paste this verbatim back at the top of the file.
    fence_end = 3 + fence.end()
    # Walk forward past the newline(s) immediately after the closer so
    # the frontmatter_block ends cleanly on a line boundary.
    while fence_end < len(text) and text[fence_end] in ("\r", "\n"):
        fence_end += 1
    frontmatter_block = text[:fence_end]
    body = text[fence_end:]
    return frontmatter_block, body


def _strip_yaml_frontmatter(text: str) -> str:
    """Drop a leading YAML / Jekyll-style frontmatter block, if any.

    GitHub's markdown renderer hides this block — so authors writing
    chapters with metadata like::

        ---
        current_word_count: 1290
        summary: Ilea Vann [POV]
        ---
        # Chapter 0

    see only the chapter on github.com. The raw `.md` bytes include
    the fence, though, and without this strip TTS happily reads
    "current word count 1290 summary Ilea Vann POV" out loud.

    See _split_yaml_frontmatter for the fence-detection rules;
    this is a thin "discard the metadata, keep the body" wrapper.
    """
    _, body = _split_yaml_frontmatter(text)
    return body


def _extract_markdown(data: bytes) -> str:
    """Plain decode + frontmatter strip.

    Used for `.md` / `.markdown` file uploads AND for raw markdown URLs
    fetched via /api/extract/url (e.g. raw.githubusercontent.com files
    routed through this dispatcher). `.txt` keeps the unstripped path
    in case a non-markdown text file legitimately starts with `---`.
    """
    return _strip_yaml_frontmatter(_extract_plain(data))


def _extract_pdf(data: bytes) -> str:
    """Extract reading text from a PDF, stripping common boilerplate.

    Three things would otherwise make their way into the TTS output and
    ruin long-form listening:
        1. Running headers/footers (book title, chapter name) repeated
           on every page.
        2. Bare page numbers ("47", "Page 47 of 320", "47 of 320").
        3. Footnote markers shown as small superscripts mid-paragraph.

    We use PyMuPDF's structured extraction (page.get_text("dict")) to see
    each line's bbox and font size, detect lines that repeat across pages
    within the same header/footer zone, drop pure-pagination lines, and
    stitch sentences that span page breaks (so the splitter doesn't cut
    'the cat sat on the | mat.' into two sentences).
    """
    import fitz  # PyMuPDF

    pages_data: list[dict] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            lines = _pdf_collect_lines(page)
            # If structured extraction yielded nothing (scanned PDFs without
            # OCR, image-only pages), keep raw text so the page isn't lost.
            fallback = page.get_text("text").strip() if not lines else ""
            pages_data.append({
                "lines": lines,
                "height": page.rect.height,
                "fallback": fallback,
            })

    structured = [p for p in pages_data if p["lines"]]
    headers, footers = _pdf_detect_boilerplate(
        [p["lines"] for p in structured],
        [p["height"] for p in structured],
    )

    page_texts: list[str] = []
    for p in pages_data:
        if p["lines"]:
            kept = [
                ln["text"]
                for ln in p["lines"]
                if ln["text"] not in headers
                and ln["text"] not in footers
                and not _is_page_number(ln["text"])
            ]
            page_texts.append("\n".join(kept).strip())
        else:
            page_texts.append(p["fallback"])

    return _pdf_join_pages(page_texts)


def _pdf_collect_lines(page) -> list[dict]:
    """Per-line text with bbox y-range + median font size. Drops tiny-font
    "digit-only" spans (likely footnote markers in body of page)."""
    d = page.get_text("dict")
    lines: list[dict] = []
    font_sizes: list[float] = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue  # 0 = text block; 1 = image, etc.
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = " ".join((s.get("text") or "") for s in spans).strip()
            if not text:
                continue
            sizes = [s.get("size", 0) for s in spans if s.get("size")]
            size = sum(sizes) / len(sizes) if sizes else 0
            bbox = line.get("bbox", (0, 0, 0, 0))
            font_sizes.append(size)
            lines.append({
                "text": text,
                "y_top": bbox[1],
                "y_bot": bbox[3],
                "font_size": size,
            })

    if not lines:
        return lines

    # Filter footnote markers: short digit-only lines rendered noticeably
    # smaller than the page's median body text.
    median_size = sorted(font_sizes)[len(font_sizes) // 2]
    small_threshold = median_size * 0.7

    return [
        ln for ln in lines
        if not (
            ln["font_size"] > 0
            and ln["font_size"] < small_threshold
            and re.fullmatch(r"\d{1,3}", ln["text"])
        )
    ]


def _pdf_detect_boilerplate(
    pages_lines: list[list[dict]], page_heights: list[float]
) -> tuple[set[str], set[str]]:
    """Find lines that appear in the same header/footer zone on most pages.

    Header zone = top 15% of the page; footer zone = bottom 15%. A line
    qualifies as boilerplate when it shows up in that zone on > 50% of
    pages. Needs ≥ 2 pages to fire — single-page documents have no
    cross-page repetition to look at.
    """
    from collections import Counter

    n = len(pages_lines)
    if n < 2:
        return set(), set()

    headers: Counter = Counter()
    footers: Counter = Counter()
    for lines, ph in zip(pages_lines, page_heights):
        if ph <= 0:
            continue
        for ln in lines:
            if ln["y_top"] < ph * 0.15:
                headers[ln["text"]] += 1
            elif ln["y_bot"] > ph * 0.85:
                footers[ln["text"]] += 1

    # "More than half the pages" — strictly > 50% so a 4-page doc needs
    # at least 3 hits, not just 2.
    threshold = (n // 2) + 1
    return (
        {t for t, c in headers.items() if c >= threshold},
        {t for t, c in footers.items() if c >= threshold},
    )


# Page-number patterns. Anchored with fullmatch so we don't strip lines
# that *contain* a number but are real prose ("There were 47 of them.").
_PAGE_NUM_BARE = re.compile(r"[-–—\s]*\d{1,4}\.?[-–—\s]*")
_PAGE_NUM_LABELED = re.compile(
    r"(?:page|pg|p\.)\s*\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?",
    re.IGNORECASE,
)
_PAGE_NUM_OF = re.compile(r"\d{1,4}\s*(?:of|/)\s*\d{1,4}", re.IGNORECASE)


def _is_page_number(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    return bool(
        _PAGE_NUM_BARE.fullmatch(t)
        or _PAGE_NUM_LABELED.fullmatch(t)
        or _PAGE_NUM_OF.fullmatch(t)
    )


def _pdf_join_pages(page_texts: list[str]) -> str:
    """Join pages — paragraph break when the previous page ended at a
    sentence terminator, single space otherwise (so cross-page sentences
    survive the sentence splitter)."""
    parts = [p.strip() for p in page_texts if p.strip()]
    if not parts:
        return ""
    out = parts[0]
    for pt in parts[1:]:
        tail = out.rstrip()
        # Look past closing quotes / parens to find the actual terminator.
        end_char = ""
        for ch in reversed(tail):
            if ch in '"\')]}' or ch.isspace():
                continue
            end_char = ch
            break
        if end_char in ".!?":
            out = tail + "\n\n" + pt
        else:
            out = tail + " " + pt
    return out


def _extract_epub(data: bytes) -> str:
    """Text-only EPUB extraction. For the structured shape with inline
    images, callers use _extract_epub_with_images directly. This thin
    wrapper preserves the str → str contract for the existing dispatcher
    table (_HANDLERS)."""
    return _extract_epub_with_images(data)["text"]


# v225fz13 (#687): max inline image size for the EPUB extractor. Mirrors
# image_detector's _MAX_INLINE_BYTES so a 5 MB plate doesn't blow up the
# /api/extract response. Skipped images are dropped silently — the
# reading view still gets the text, just without that figure.
_EPUB_INLINE_IMG_MAX_BYTES = 1_000_000


def _extract_epub_with_images(data: bytes) -> dict:
    """EPUB extraction that captures inline images alongside text.

    Returns ``{"text": str, "images": [{"sentence_index": int, "src": str,
    "alt": str}, ...]}``. The src is a base64 data URL so the client can
    render the image without a follow-up fetch — EPUB images live inside
    the zip, not on the public web. sentence_index is the count of
    sentence-ending punctuation seen BEFORE the image's position, so the
    reading view inserts it above sentence ``index`` (matches the URL
    fetch convention from extract_url).

    Why this exists: ``_extract_epub`` collapses each spine item via
    ``soup.get_text()``, which silently drops every ``<img>`` tag. URL
    fetch carries images through; EPUB upload never did. The user who
    uploaded an RGL-built short story expected the RGL cover-replay and
    Ex Libris plate to land in the reading view; they didn't, because
    the text walker discarded them mid-extraction.
    """
    import base64
    from bs4 import BeautifulSoup, NavigableString, Tag

    parts: list[str] = []
    images: list[dict] = []
    sentence_cursor = 0
    SENT_END_RE = re.compile(r"[.!?](?=\s|$)")

    # v225v3.71 (#802): a BadZipFile escaping here surfaces as an
    # uncaught 500 in /api/extract — the corpus runner hit this on a
    # Standard Ebooks download that came back as HTML (redirect / WAF /
    # rate-limit). Catch it and surface a clear 422 instead so the
    # client and the corpus harness both get a meaningful reason.
    try:
        zf_ctx = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ExtractionError(
            "invalid EPUB: file is not a zip archive (download may have "
            "returned an HTML error page instead of the .epub bytes)"
        ) from e
    with zf_ctx as zf:
        # Find the OPF (package document) via META-INF/container.xml.
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", "replace")
        except KeyError as e:
            raise ExtractionError("invalid EPUB: missing container.xml") from e
        m = re.search(r'full-path="([^"]+)"', container)
        if not m:
            raise ExtractionError("invalid EPUB: no rootfile in container.xml")
        opf_path = m.group(1)
        # v225fz12e: PurePath("file.opf").parent.as_posix() returns "."
        # for an OPF at the archive root — not "". Without this guard
        # we'd build doc_path = "./titlepage.xhtml" and zipfile.read()
        # raises KeyError because the member is stored as
        # "titlepage.xhtml" (no leading "./"). Real symptom: EPUBs
        # built by Calibre with no enclosing OEBPS folder fail with
        # "EPUB contains no readable text" even though the spine is
        # full of prose.
        opf_dir = PurePath(opf_path).parent.as_posix()
        if opf_dir == ".":
            opf_dir = ""
        opf = zf.read(opf_path).decode("utf-8", "replace")

        # Two manifest views: spine HTML (id -> href) and images
        # (href -> mime, relative to opf_dir).
        #
        # v225v3.71 (#802): the original version pinned attribute order
        # to id → href → media-type, which Gutenberg's EPUB3 violates
        # (often emits href first, with properties=cover-image
        # interleaved). That silently dropped every spine item and the
        # response came back as 422 "EPUB contains no readable text".
        # Parse <item ...> attributes order-agnostically.
        #
        # v225v3.72 (#802): first v3.71 attempt was `<item\b([^/>]*)/?>`
        # to stop the body at the self-closing slash — but media-type
        # values like image/jpeg, text/css, application/xhtml+xml ALL
        # contain `/`, so the character class bailed mid-attribute and
        # the whole item failed to match. Drop the `/?>` dance and let
        # ATTR_RE skip the trailing slash naturally (it isn't a
        # name="value" pair). Inspect Gutenberg's Alice EPUB confirmed
        # the bug: 21 items in OPF, 0 matched, 0/15 spine items resolved.
        manifest_html: dict[str, str] = {}
        manifest_images: dict[str, str] = {}
        ATTR_RE = re.compile(r'\b(\w[\w:-]*)\s*=\s*"([^"]*)"')
        for item in re.finditer(r"<item\b([^>]*)>", opf):
            attrs = dict(ATTR_RE.findall(item.group(1)))
            iid = attrs.get("id")
            href = attrs.get("href")
            media = attrs.get("media-type", "")
            if not iid or not href:
                continue
            if media in ("application/xhtml+xml", "text/html"):
                manifest_html[iid] = href
            elif media.startswith("image/"):
                manifest_images[href] = media

        # Spine gives reading order.
        spine_ids = re.findall(r'<itemref\b[^>]*\bidref="([^"]+)"', opf)

        for iid in spine_ids:
            href = manifest_html.get(iid)
            if not href:
                continue
            doc_path = f"{opf_dir}/{href}" if opf_dir else href
            try:
                raw = zf.read(doc_path)
            except KeyError:
                continue
            soup = BeautifulSoup(raw, "lxml")
            # Drop nav/script/style chrome.
            for tag in soup(["script", "style", "nav"]):
                tag.decompose()
            # Ensure headings end with sentence-terminating punctuation so
            # the TTS sentence-splitter (regex (?<=[.!?])\s+) won't run
            # them into the next paragraph.
            for htag in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
                t = htag.get_text(strip=True)
                if t and t[-1] not in ".!?":
                    htag.clear()
                    htag.append(t + ".")

            # The doc may live in a subdirectory (e.g. OEBPS/text/foo.xhtml).
            # <img src="...rel..."> resolves against the doc's directory.
            doc_dir = PurePath(doc_path).parent.as_posix()
            if doc_dir == ".":
                doc_dir = ""

            # Walk descendants in document order. Track text via
            # NavigableString chunks (matches what get_text() would
            # produce); record <img> at the current sentence_cursor so
            # the client knows which sentence the figure precedes.
            text_chunks: list[str] = []
            root = soup.body or soup
            for node in root.descendants:
                if isinstance(node, NavigableString):
                    s = str(node).strip()
                    if not s:
                        continue
                    text_chunks.append(s)
                    sentence_cursor += len(SENT_END_RE.findall(s))
                elif isinstance(node, Tag) and node.name == "img":
                    src = node.get("src") or node.get("xlink:href") or ""
                    if not src:
                        continue
                    # Resolve relative path against the doc's directory.
                    img_path = _resolve_epub_doc_path(doc_dir, src)
                    img_data = None
                    img_mime = None
                    # Try direct zip member first.
                    try:
                        img_data = zf.read(img_path)
                    except KeyError:
                        # Some EPUBs reference images relative to OPF
                        # instead of relative to the doc. Try that as a
                        # fallback. Then try the bare src as a last
                        # resort (archives that store everything at root).
                        alt_path = f"{opf_dir}/{src}" if opf_dir else src
                        try:
                            img_data = zf.read(alt_path)
                            img_path = alt_path
                        except KeyError:
                            try:
                                img_data = zf.read(src)
                                img_path = src
                            except KeyError:
                                continue
                    if not img_data:
                        continue
                    if len(img_data) > _EPUB_INLINE_IMG_MAX_BYTES:
                        # Skip oversize plates. The user can re-upload
                        # a smaller variant or upload a manual cover.
                        continue
                    # Resolve mime: prefer manifest declaration; fall
                    # back to extension-based guess.
                    rel = img_path
                    if opf_dir and rel.startswith(opf_dir + "/"):
                        rel = rel[len(opf_dir) + 1:]
                    img_mime = manifest_images.get(rel) or manifest_images.get(src) or _guess_image_mime(img_path)
                    if not img_mime:
                        continue
                    b64 = base64.b64encode(img_data).decode("ascii")
                    data_url = f"data:{img_mime};base64,{b64}"
                    images.append({
                        "sentence_index": sentence_cursor,
                        "src": data_url,
                        "alt": (node.get("alt") or "").strip(),
                    })

            spine_text = "\n".join(text_chunks)
            if spine_text:
                parts.append(spine_text)

    if not parts:
        raise ExtractionError("EPUB contains no readable text")
    return {"text": "\n\n".join(parts), "images": images}


def _resolve_epub_doc_path(doc_dir: str, src: str) -> str:
    """Resolve an <img src> relative to the document's directory.

    Mirrors what a browser would do, but inside the EPUB zip. Strips
    fragment / query strings just in case. Returns a posix-style path
    suitable for zipfile.read()."""
    src = src.split("#", 1)[0].split("?", 1)[0]
    if not src:
        return ""
    # Already absolute (within the archive) → just normalize.
    if src.startswith("/"):
        return src.lstrip("/")
    if doc_dir:
        combined = (PurePath(doc_dir) / src).as_posix()
    else:
        combined = src
    # Resolve `..` segments without touching the filesystem.
    out: list[str] = []
    for part in combined.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            if out:
                out.pop()
            continue
        out.append(part)
    return "/".join(out)


def _guess_image_mime(path: str) -> str:
    ext = PurePath(path).suffix.lower().lstrip(".")
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "bmp": "image/bmp",
    }.get(ext, "")


def extract_scrivener_bundle(data: bytes) -> dict:
    """Parse a Scrivener .scriv.zip bundle and return a chapter list.

    Scrivener stores each scene/chapter as a separate RTF file inside
    `Files/Docs/{BinderItem ID}.rtf`. The `.scrivx` XML at the top
    describes the binder hierarchy — folders nest within folders, leaf
    items of `Type="Text"` carry the prose. We walk the DraftFolder /
    Manuscript subtree, read each Text item's RTF in binder order, strip
    formatting via `striprtf`, and return a flat ordered list with the
    folder path preserved as a hint (Author can see which Scrivener
    folder a chapter came from in the browser dialog).

    Skips Research / Trash folders by default; the Research folder is
    usually notes and worldbuilding, not prose the author wants to hear.

    Returns:
        {
          "project_name": str (from .scrivx filename),
          "chapters": [
            {"id": str, "title": str, "path": "Manuscript/Part One",
             "text": str, "chars": int},
            ...
          ],
          "skipped": [{"path", "reason"}, ...]   # for UI hints
        }

    Raises ExtractionError for malformed bundles.
    """
    import io
    import zipfile
    from xml.etree import ElementTree as ET

    try:
        from striprtf.striprtf import rtf_to_text
    except ImportError as e:
        raise ExtractionError(
            "Scrivener parser needs the `striprtf` package "
            "(pip install striprtf)"
        ) from e

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ExtractionError(f"not a valid zip file: {e}") from e

    with zf:
        # Find the .scrivx file (the project root). Real bundles always
        # have it at `<projectname>.scriv/<projectname>.scrivx`.
        names = zf.namelist()
        scrivx_name = next(
            (n for n in names if n.lower().endswith(".scrivx")),
            None,
        )
        if not scrivx_name:
            raise ExtractionError(
                "not a Scrivener bundle (no .scrivx file inside the zip)"
            )

        # Project name = the directory containing the scrivx, minus .scriv.
        project_name = PurePath(scrivx_name).stem
        bundle_root = str(PurePath(scrivx_name).parent).rstrip("/")

        # Parse the binder XML.
        try:
            with zf.open(scrivx_name) as f:
                tree = ET.parse(f)
        except ET.ParseError as e:
            raise ExtractionError(f"malformed .scrivx XML: {e}") from e

        root = tree.getroot()
        binder = root.find("Binder")
        if binder is None:
            raise ExtractionError(".scrivx has no <Binder> element")

        # Walk the binder, collecting Text items under DraftFolder /
        # Folder (skipping Research/Trash). Folders contribute to the
        # path display, not to clips themselves.
        chapters: list[dict] = []
        skipped: list[dict] = []

        def _walk(node, current_path: list[str], in_manuscript: bool):
            for item in node.findall("BinderItem"):
                item_type = item.get("Type") or ""
                item_id = item.get("ID") or ""
                title_el = item.find("Title")
                title = (title_el.text or "").strip() if title_el is not None else ""
                if not title:
                    title = f"Untitled {item_id}"

                # Type-based routing. Real Scrivener 3 types we know:
                # DraftFolder, Folder, Text, ResearchFolder, TrashFolder,
                # PdfFile, ImageFile, OtherFile. The last three aren't
                # prose so we drop them quietly.
                if item_type in ("ResearchFolder", "TrashFolder"):
                    skipped.append({
                        "path": "/".join(current_path + [title]),
                        "reason": item_type,
                    })
                    continue

                children = item.find("Children")
                if item_type == "DraftFolder":
                    new_path = current_path + [title]
                    if children is not None:
                        _walk(children, new_path, in_manuscript=True)
                elif item_type == "Folder":
                    new_path = current_path + [title]
                    if children is not None:
                        _walk(children, new_path, in_manuscript=in_manuscript)
                elif item_type == "Text":
                    if not in_manuscript:
                        continue
                    rtf_path = f"{bundle_root}/Files/Docs/{item_id}.rtf"
                    if rtf_path not in names:
                        # Real bundles sometimes omit the RTF for empty
                        # documents — skip them so the import doesn't
                        # fail outright.
                        skipped.append({
                            "path": "/".join(current_path + [title]),
                            "reason": "no RTF file",
                        })
                        continue
                    try:
                        rtf_bytes = zf.read(rtf_path)
                        rtf_str = rtf_bytes.decode("utf-8", errors="replace")
                        text = rtf_to_text(rtf_str).strip()
                    except Exception as e:
                        skipped.append({
                            "path": "/".join(current_path + [title]),
                            "reason": f"RTF parse failed: {e}",
                        })
                        continue
                    if not text:
                        skipped.append({
                            "path": "/".join(current_path + [title]),
                            "reason": "empty document",
                        })
                        continue
                    chapters.append({
                        "id": item_id,
                        "title": title,
                        "path": "/".join(current_path),
                        "text": _normalize(text),
                        "chars": len(text),
                    })

        _walk(binder, [], in_manuscript=False)

        if not chapters:
            raise ExtractionError(
                "Scrivener bundle has no readable chapters under the "
                "Manuscript / Draft folder."
            )

        return {
            "project_name": project_name,
            "chapters": chapters,
            "skipped": skipped,
        }


# Obsidian-specific folder names we never want to import. Mostly config
# (.obsidian/), trash (.trash/), template scaffolds, and attachment dirs
# that don't hold prose. Lowercased for case-insensitive match.
_OBSIDIAN_SKIP_DIRS = {
    ".obsidian", ".trash", ".git", ".vscode", ".idea",
    "templates", "_templates", "template",
    "attachments", "_attachments", "assets", "media", "files",
    "images", "img",
}

# Wikilinks survive Obsidian export but are noise for TTS: a literal
# "[[Other Note]]" read aloud sounds nonsensical. Strip the brackets
# (and pipe-alias) so just the human-facing text remains. Embeds
# (![[image.png]] or ![[Other Note]]) drop entirely.
_OBSIDIAN_WIKILINK_ALIASED = re.compile(r"\[\[([^\]|]+)\|([^\]]+)\]\]")
_OBSIDIAN_WIKILINK_PLAIN = re.compile(r"\[\[([^\]]+)\]\]")
_OBSIDIAN_EMBED = re.compile(r"!\[\[[^\]]+\]\]")


def _obsidian_strip_frontmatter(md: str) -> tuple[str | None, str]:
    """Return (title, body) for a possibly-frontmatter'd Markdown doc.

    Shares its fence-detection with _strip_yaml_frontmatter (above);
    the difference is this one also surfaces the YAML's `title:` field
    so the Obsidian vault picker can label the note. Returns (None, md)
    unchanged when no frontmatter is present.
    """
    if not (md.startswith("---\n") or md.startswith("---\r\n")):
        return None, md
    fence = _FRONTMATTER_FENCE_RE.search(md[3:])
    if not fence:
        return None, md
    yaml_block = md[3:3 + fence.start()]
    body = md[3 + fence.end():].lstrip("\r\n")
    title = None
    for line in yaml_block.splitlines():
        # Only the title field — we don't need a full YAML parser.
        m = re.match(r"\s*title\s*:\s*(.*)$", line, re.IGNORECASE)
        if m:
            t = m.group(1).strip()
            # Strip a single layer of matching quotes if present.
            if len(t) >= 2 and t[0] == t[-1] and t[0] in ("'", '"'):
                t = t[1:-1]
            if t:
                title = t
            break
    return title, body


def extract_obsidian_vault(data: bytes) -> dict:
    """Parse an Obsidian vault zip and return a notes list.

    Obsidian stores notes as plain `.md` files in a folder hierarchy
    chosen by the author. There's no "manuscript" abstraction — every
    note looks the same on disk — so the user picks which notes to
    import via the shared document picker after this parser surfaces
    the candidates.

    Filtering rules (default Obsidian conventions):
      - skip `.obsidian/`, `.trash/`, any dotdir at any depth
      - skip `templates/`, `attachments/`, `assets/`, `media/`, etc.
      - skip non-.md files entirely
      - parse YAML frontmatter for an optional `title:` override
      - strip wikilinks ([[X]], [[X|Y]]) → human text
      - drop embeds (![[X]]) — they're images or nested notes, neither
        useful in a TTS context
      - drop notes with empty body after stripping

    Returns:
        {
          "vault_name": str,
          "chapters": [
            {"id": str, "title": str, "path": "Manuscript/Part One",
             "text": str, "chars": int},
            ...
          ],
          "skipped": [{"path", "reason"}, ...]
        }

    Raises ExtractionError if the zip is malformed or contains no
    importable notes.
    """
    import io
    import zipfile

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ExtractionError(f"not a valid zip file: {e}") from e

    chapters: list[dict] = []
    skipped: list[dict] = []

    with zf:
        names = zf.namelist()

        # Vault name: the single top-level folder, if there is one.
        # Authors usually zip the vault folder itself, but some zip the
        # contents instead — handle both gracefully.
        roots = {n.split("/")[0] for n in names if "/" in n}
        folder_roots = {
            r for r in roots
            if r and not r.lower().endswith((".md", ".markdown"))
        }
        if len(folder_roots) == 1:
            vault_name = next(iter(folder_roots))
        else:
            vault_name = "Obsidian vault"

        for name in names:
            if name.endswith("/"):
                continue
            if not name.lower().endswith((".md", ".markdown")):
                continue

            parts = name.split("/")
            # Drop the vault-root prefix from the display path so
            # "MyVault/Manuscript/Ch1.md" surfaces as "Manuscript".
            display_parts = (
                parts[1:] if vault_name != "Obsidian vault"
                and parts[0] == vault_name
                else parts
            )

            # Skip anything sitting under a skip-dir or hidden dotdir
            # at any depth (check parent dirs only, not the filename).
            skip_reason = None
            for p in display_parts[:-1]:
                if p.startswith("."):
                    skip_reason = f"hidden folder ({p})"
                    break
                if p.lower() in _OBSIDIAN_SKIP_DIRS:
                    skip_reason = f"in {p}/"
                    break
            if skip_reason:
                skipped.append({"path": name, "reason": skip_reason})
                continue

            try:
                md_bytes = zf.read(name)
                md_str = md_bytes.decode("utf-8", errors="replace")
            except Exception as e:
                skipped.append({"path": name, "reason": f"read failed: {e}"})
                continue

            title, body = _obsidian_strip_frontmatter(md_str)
            if not title:
                # Filename minus the .md/.markdown extension. We strip
                # only the final extension so notes named "v2.0.md" keep
                # the "v2.0" part.
                fname = display_parts[-1] if display_parts else parts[-1]
                title = re.sub(r"\.(md|markdown)$", "", fname, flags=re.IGNORECASE)

            # Order matters: drop embeds FIRST, then strip wikilinks.
            # ![[map.png]] looks like a wikilink to the plain regex —
            # if we strip wikilinks first, the leading `!` is left
            # orphaned ("!map.png") because the embed regex no longer
            # matches.
            body = _OBSIDIAN_EMBED.sub("", body)
            body = _OBSIDIAN_WIKILINK_ALIASED.sub(r"\2", body)
            body = _OBSIDIAN_WIKILINK_PLAIN.sub(r"\1", body)
            body = body.strip()
            if not body:
                skipped.append({"path": name, "reason": "empty after stripping"})
                continue

            display_path = "/".join(display_parts[:-1])
            chapters.append({
                "id": name,
                "title": title,
                "path": display_path,
                "text": _normalize(body),
                "chars": len(body),
            })

    if not chapters:
        raise ExtractionError(
            "Obsidian vault has no readable Markdown notes "
            "(or all notes were in skipped folders like .obsidian/ or "
            "templates/)."
        )

    # Sort chapters by folder path then title — authors who use "01 -",
    # "02 -" filename prefixes get their intended order, and folder
    # groupings stay together.
    chapters.sort(key=lambda c: (c["path"], c["title"].lower()))

    return {
        "vault_name": vault_name,
        "chapters": chapters,
        "skipped": skipped,
    }


def _extract_docx(data: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(data))
    paragraphs = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
    return "\n\n".join(paragraphs)


# ---- post-processing -----------------------------------------------------


def _inject_html_headings(html: str, md: str) -> str:
    """Re-insert chapter-like HTML headings into a trafilatura markdown
    extraction that's missing them.

    Trafilatura's content-extraction algorithm sometimes identifies
    `<h2>CHAPTER I.</h2>`-style tags as boilerplate (notably on Project
    Gutenberg's text-page format, where chapter headings are wrapped in
    `<a>` anchors with `class="chapter"` and the algorithm strips them).
    Without those headings the frontend's chapter auto-split has nothing
    to grab onto — the entire novel comes out as one clip.

    Strategy: BeautifulSoup the raw HTML for h1-h3 tags. For each one,
    grab the FIRST PARAGRAPH that follows (its next text-bearing sibling)
    as an anchor — that paragraph will be in trafilatura's output since
    it's the body content trafilatura kept. Find the anchor in `md`,
    insert a `## HEADING` line before it.

    Returns the augmented markdown, or `md` unchanged if:
        - trafilatura already preserved headings (we trust those)
        - BeautifulSoup is unavailable or the parse fails
        - no h1-h3 tags found
        - none of the anchors locate cleanly in `md`
    """
    # Already has headings? Trust trafilatura. The fast-path check uses
    # MULTILINE so a # at the start of any line counts.
    if re.search(r"^#{1,3}\s+\S", md, re.MULTILINE):
        return md

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return md

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return md

    # Drop chrome that BS4 would otherwise scan through. The headings
    # we want are inside the article body, not nav menus.
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    anchors: list[tuple[int, str, str]] = []  # (level, heading_text, anchor_snippet)
    for h in soup.find_all(["h1", "h2", "h3"]):
        try:
            level = int(h.name[1])
        except (TypeError, ValueError):
            level = 2
        h_text = h.get_text(" ", strip=True)
        if not h_text:
            continue
        # Skip very long heading text (likely a TOC dump like
        # "CHAPTER I. ... CHAPTER II. ..." that the source flattened
        # into a single tag — injecting that as a marker would be worse
        # than no marker).
        if len(h_text) > 200:
            continue

        # Find the first downstream text-bearing element that survives
        # trafilatura's extraction. Prefer <p>; fall back to <div>.
        anchor_snippet = None
        for sib in h.find_all_next(["p", "div"]):
            txt = sib.get_text(" ", strip=True)
            if len(txt) >= 30:
                # 60-80 chars is enough to disambiguate; longer makes
                # matching brittle against whitespace differences.
                anchor_snippet = txt[:60]
                break
        if not anchor_snippet:
            continue

        anchors.append((min(level, 3), h_text, anchor_snippet))

    if not anchors:
        return md

    # Walk anchors in document order, injecting heading lines before
    # the matching prose. Each search starts from the previous insert
    # point so we don't keep re-finding the same passage.
    out_parts: list[str] = []
    cursor = 0
    inserted = 0
    for level, h_text, anchor in anchors:
        # Trafilatura output may normalize whitespace differently than
        # BS4. Try the full snippet first, then progressively shorter
        # prefixes, then a whitespace-collapsed match.
        idx = -1
        for probe_len in (60, 40, 25):
            probe = anchor[:probe_len].strip()
            if not probe:
                continue
            idx = md.find(probe, cursor)
            if idx >= 0:
                break
        if idx < 0:
            # Try fuzzy: collapse internal whitespace in both sides.
            md_tail = md[cursor:]
            md_norm = re.sub(r"\s+", " ", md_tail)
            anchor_norm = re.sub(r"\s+", " ", anchor[:40]).strip()
            if anchor_norm and anchor_norm in md_norm:
                # We know it's in there but our index math doesn't survive
                # the normalization. Skip — better to miss a chapter than
                # to insert the heading at the wrong place.
                pass
            continue

        # Find the start of the paragraph containing the anchor (the
        # line after the previous blank-line boundary).
        para_start = md.rfind("\n\n", 0, idx)
        if para_start < 0:
            para_start = 0
        else:
            para_start += 2  # skip past the "\n\n"

        prefix = "#" * level
        marker = f"{prefix} {h_text}\n\n"
        out_parts.append(md[cursor:para_start])
        out_parts.append(marker)
        cursor = para_start
        inserted += 1

    if inserted == 0:
        return md
    out_parts.append(md[cursor:])
    return "".join(out_parts)


def _inject_html_images(html: str, md: str, base_url: str) -> str:
    """Re-insert `<img>` tags into a trafilatura markdown extraction
    that's missing them.

    Mirror of `_inject_html_headings` for images. Project Gutenberg's
    illustrated editions (Wizard of Oz, Alice, Peter Pan, etc.) host
    pictures with `<img src="images/p001.jpg" alt="Dorothy" />` inside
    paragraph context, but trafilatura's content extractor strips them
    along with the rest of the page chrome. The downstream image-finder
    regex sees nothing to extract; the reading view shows text only.

    Strategy: BS4 the raw HTML for img tags. For each img, grab the
    first ~60 chars of its next text-bearing sibling as an anchor. Find
    that anchor in `md` and insert `![alt](src)` (resolved to absolute
    URL) before it. The downstream `IMG_RE.finditer` loop in
    `fetch_and_extract_url` then pulls these into the structured
    `images` array and strips the markers from the text the
    synthesizer sees.

    Returns the augmented markdown, or `md` unchanged when:
        - trafilatura already preserved images (markdown has `![...](...)`)
        - BS4 / lxml unavailable
        - no img tags found
        - no anchors locate cleanly
    """
    import re
    import urllib.parse as _urlparse

    # Already has images? Trust trafilatura.
    if re.search(r"!\[[^\]]*\]\([^)]+\)", md):
        return md

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return md

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return md

    # Drop chrome — same rationale as the heading injection.
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    anchors: list[tuple[str, str, str]] = []  # (src_abs, alt, anchor_snippet)
    for img in soup.find_all("img"):
        src = img.get("src", "").strip()
        if not src:
            continue
        # Project Gutenberg uses tiny inline navigation/decoration sprites
        # (transparent.png, line-break SVGs, etc.). Skip anything that
        # looks like a 1-bit decoration so the reading view doesn't get
        # littered with corner ornaments. Heuristic: <100px wide AND
        # filename hints at decoration.
        try:
            width = int(img.get("width", "999"))
        except (ValueError, TypeError):
            width = 999
        low = src.lower()
        if width < 100 and any(s in low for s in (
            "ornament", "divider", "line", "rule", "spacer", "blank", "transparent",
        )):
            continue

        alt = (img.get("alt") or "").strip()
        # Skip if both src looks decorative AND alt is empty / one-char.
        # Real illustrations have meaningful alt text in PG.

        try:
            src_abs = _urlparse.urljoin(base_url, src)
        except Exception:
            src_abs = src

        # Find an anchor — the first text-bearing element after this img
        # that survived trafilatura's extraction. <p> is the canonical
        # surviving block; <div> as fallback.
        anchor_snippet = None
        for sib in img.find_all_next(["p", "div"]):
            txt = sib.get_text(" ", strip=True)
            if len(txt) >= 30:
                anchor_snippet = txt[:60]
                break
        if not anchor_snippet:
            # No anchor below — try ABOVE (some PG editions put the
            # caption-bearing paragraph before the figure).
            for sib in img.find_all_previous(["p", "div"]):
                txt = sib.get_text(" ", strip=True)
                if len(txt) >= 30:
                    anchor_snippet = txt[:60]
                    break

        if not anchor_snippet:
            continue
        anchors.append((src_abs, alt, anchor_snippet))

    if not anchors:
        return md

    # Walk anchors in document order, injecting `![alt](src)` markers
    # before each matching prose paragraph. Each search starts from the
    # previous insert point so consecutive images near the same anchor
    # don't all glob onto the same line.
    out_parts: list[str] = []
    cursor = 0
    inserted = 0
    for src_abs, alt, anchor in anchors:
        # Try progressively shorter probes — long-prefix first.
        idx = -1
        for probe_len in (60, 40, 25):
            probe = anchor[:probe_len].strip()
            if not probe:
                continue
            idx = md.find(probe, cursor)
            if idx >= 0:
                break
        if idx < 0:
            continue

        # Insert at the start of the paragraph containing the anchor.
        para_start = md.rfind("\n\n", 0, idx)
        if para_start < 0:
            para_start = 0
        else:
            para_start += 2

        # Escape any ) inside the URL since markdown ![](url) would end
        # the link at the first unescaped paren.
        safe_src = src_abs.replace(")", "%29")
        safe_alt = alt.replace("]", "")
        marker = f"![{safe_alt}]({safe_src})\n\n"
        out_parts.append(md[cursor:para_start])
        out_parts.append(marker)
        cursor = para_start
        inserted += 1

    if inserted == 0:
        return md
    out_parts.append(md[cursor:])
    return "".join(out_parts)


def _normalize(text: str) -> str:
    if not text:
        return ""
    # Collapse Windows / Mac line endings.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Glue hyphenated line-breaks ("inter-\nesting" -> "interesting") which are
    # common in PDF extraction.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    # Collapse single newlines inside paragraphs to spaces; preserve blank
    # lines so paragraphs stay visually separated.
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    # Squeeze runs of whitespace.
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_HANDLERS = {
    "txt": _extract_plain,
    # v220as: `.md` / `.markdown` go through _extract_markdown so the
    # YAML frontmatter block doesn't end up read aloud by Piper/Kokoro.
    "md": _extract_markdown,
    "markdown": _extract_markdown,
    "pdf": _extract_pdf,
    "epub": _extract_epub,
    "docx": _extract_docx,
}
