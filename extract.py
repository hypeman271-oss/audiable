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
    import fitz  # PyMuPDF

    parts: list[str] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            # "text" preserves reading order well enough for most PDFs; for
            # multi-column papers the default heuristic groups columns
            # left-to-right, which is what a reader expects.
            parts.append(page.get_text("text"))
    return "\n\n".join(parts)


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
