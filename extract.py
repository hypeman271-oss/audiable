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


def fetch_and_extract_url(url: str) -> dict:
    """Fetch an article URL and return its main text + metadata.

    Returns:
        {"filename": <hostname>, "chars": int, "text": str}

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

    parsed = urllib.parse.urlparse((url or "").strip())
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

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; Narrative/0.1; +local TTS reader)"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = (resp.headers.get("Content-Type") or "").lower()
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
        raise ExtractionError(f"HTTP {e.code} fetching URL") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ExtractionError(f"could not fetch URL: {e}") from e

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

    import trafilatura

    text = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        favor_recall=True,
    )

    if not text or not text.strip():
        raise ExtractionError("no article text found at URL")

    text = _normalize(text)

    return {
        "filename": parsed.hostname or "url",
        "chars": len(text),
        "text": text,
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
