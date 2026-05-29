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


_GITHUB_HOSTS = {
    "github.com",
    "raw.githubusercontent.com",
    "www.github.com",
}


def _rewrite_github_url(url: str) -> str:
    """Convert github.com/.../blob/branch/path URLs to raw.githubusercontent.com.

    Blob URLs return the HTML file-browser page; the raw URLs return the
    file's actual bytes. The fetcher always wants bytes, so silently
    rewrite. URLs that don't match the blob pattern (raw URLs, repo
    roots, gists, etc.) pass through unchanged.
    """
    import re
    import urllib.parse

    parsed = urllib.parse.urlparse(url)
    if parsed.hostname not in ("github.com", "www.github.com"):
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
    return f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{path}"


def fetch_and_extract_url(url: str, github_token: str | None = None) -> dict:
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
        text = extract_text(filename, raw)
        if not text.strip():
            raise ExtractionError("file is empty or unreadable")
        return {
            "filename": filename,
            "chars": len(text),
            "text": text,
            "images": [],
        }

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
    # ebooklib insists on reading from a path-ish input; give it the bytes
    # via a BytesIO-backed zipfile reader by writing to a temp buffer.
    # Easier: use the lower-level zipfile + manifest walk so we don't pay
    # ebooklib's stricter validation (some EPUBs in the wild trip it).
    from bs4 import BeautifulSoup

    parts: list[str] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # Find the OPF (package document) via META-INF/container.xml.
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", "replace")
        except KeyError as e:
            raise ExtractionError("invalid EPUB: missing container.xml") from e
        m = re.search(r'full-path="([^"]+)"', container)
        if not m:
            raise ExtractionError("invalid EPUB: no rootfile in container.xml")
        opf_path = m.group(1)
        opf_dir = PurePath(opf_path).parent.as_posix()
        opf = zf.read(opf_path).decode("utf-8", "replace")

        # Build id -> href map from the manifest.
        manifest: dict[str, str] = {}
        for item in re.finditer(
            r'<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*\bmedia-type="([^"]+)"',
            opf,
        ):
            iid, href, media = item.group(1), item.group(2), item.group(3)
            if media in ("application/xhtml+xml", "text/html"):
                manifest[iid] = href

        # Spine gives reading order.
        spine_ids = re.findall(r'<itemref\b[^>]*\bidref="([^"]+)"', opf)

        for iid in spine_ids:
            href = manifest.get(iid)
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
            text = soup.get_text("\n", strip=True)
            if text:
                parts.append(text)
    if not parts:
        raise ExtractionError("EPUB contains no readable text")
    return "\n\n".join(parts)


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
    "md": _extract_plain,
    "markdown": _extract_plain,
    "pdf": _extract_pdf,
    "epub": _extract_epub,
    "docx": _extract_docx,
}
