"""Cover + chapter-leading image detection for imported documents.

Lives next to extract.py — extract.py pulls out the text and (for URL
imports) the inline images that get anchored to sentences. This module
adds the missing piece: detecting the document's cover and the
"decorative chapter art" that often sits between a chapter heading and
its first paragraph, then handing both back so the frontend can apply
them as a clip cover and a richer chapter-marker UI.

The detector logic mirrors what tools like Calibre and PyMuPDF actually
do in practice (researched #v225fz9+ — see the workflow report):

  - EPUB cover detection follows Calibre's exact ranked fallback chain:
    EPUB 3 manifest property → EPUB 2 metadata cover → cover HTML page.
    The "largest image in archive" fallback was killed in adversarial
    review — Calibre does not do it and neither do we; it picks
    publisher logos and full-page interior plates as covers.

  - Image classification (decorative vs. inline figure) leans on the
    accessibility layer where it exists:
        alt=""          → decorative (W3C canonical signal)
        role="presentation" → decorative (overrides even non-empty alt)
        <figure>+<figcaption> → inline figure
    Either accessibility signal alone is enough; pairing them is best
    practice but not required.

  - PDF detection uses PyMuPDF's spatial APIs (get_text("dict") image
    blocks, get_image_rects) to spot the dominant-image-on-page-1
    cover and decorative banners that sit above the first paragraph.

  - DOCX uses python-docx + the inline-shape XML at the paragraph
    level to find images that follow Heading 1/2 paragraphs.

The public entry point is `detect_images(filename, data)` which dispatches
on file extension. Returns a {"cover": ..., "chapter_images": [...]}
shape that the /api/extract endpoint can merge into its response. All
image payloads are inline base64 data URLs so the client doesn't need
to make follow-up requests; oversized images (>1 MB raw) are dropped
with a `skipped` reason so the response stays small.
"""

from __future__ import annotations

import base64
import io
import os
import re
import tempfile
from pathlib import PurePath
from typing import Optional


# Inline-data-URL cap so a single oversize cover can't blow up the
# /api/extract response. Real-world covers are usually 50-300 KB; if a
# document carries a 5 MB lossless plate we'd rather skip it than ship
# a 7 MB JSON payload. The frontend can offer "upload your own" as a
# fallback.
_MAX_INLINE_BYTES = 1_000_000

# Raster MIME types that count as a candidate cover. Calibre uses an
# is_raster_image() helper with the same set.
_RASTER_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"}

# Calibre's COVER_TYPES set, verbatim from
# src/calibre/ebooks/oeb/polish/cover.py — the legacy Microsoft variants
# self-publishers and old converters emit. Without these we miss a
# meaningful tail of real-world EPUBs.
_EPUB_COVER_TYPES = {
    "coverimagestandard",
    "other.ms-coverimage-standard",
    "other.ms-titleimage-standard",
    "other.ms-titleimage",
    "other.ms-coverimage",
    "other.ms-thumbimage-standard",
    "other.ms-thumbimage",
    "thumbimagestandard",
    "cover",
}


# ─── Public dispatcher ────────────────────────────────────────────────


def detect_images(filename: str, data: bytes) -> dict:
    """Top-level dispatcher. Always returns a dict with both keys so
    callers can spread it into a response without branching."""
    ext = PurePath(filename).suffix.lower().lstrip(".")
    empty = {"cover": None, "chapter_images": []}
    if not data:
        return empty
    try:
        if ext == "epub":
            return _detect_epub(data)
        if ext == "pdf":
            return _detect_pdf(data)
        if ext == "docx":
            return _detect_docx(data)
    except Exception as e:
        # Detection is a best-effort enrichment — never let it break
        # the extract response. Log and move on.
        print(f"[image-detector] {ext} detection failed: {e!r}", flush=True)
    return empty


# ─── EPUB ─────────────────────────────────────────────────────────────


def _detect_epub(data: bytes) -> dict:
    """EPUB cover + chapter-leading image detection.

    Uses ebooklib for manifest + spine walking and BeautifulSoup for
    inside-page XHTML parsing. ebooklib's read_epub needs a path, so
    we round-trip through a tempfile.
    """
    from ebooklib import epub  # type: ignore

    fd, tmp_path = tempfile.mkstemp(suffix=".epub")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        book = epub.read_epub(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    cover = _epub_pick_cover(book)
    chapter_images = _epub_pick_chapter_images(book)
    return {"cover": cover, "chapter_images": chapter_images}


def _epub_pick_cover(book) -> Optional[dict]:
    """Calibre's ranked fallback chain (find_cover_image3 then
    find_cover_image2). Order matters — return on the first hit."""
    # 1. EPUB 3: manifest item with the "cover-image" property.
    # ebooklib stores manifest properties on items as a list of strings.
    for item in book.get_items():
        props = getattr(item, "properties", None) or []
        if "cover-image" in props:
            return _epub_item_to_cover(item, "epub3-cover-image-property")

    # 2. EPUB 2: package metadata <meta name="cover" content="itemid"/>.
    # ebooklib's get_metadata wants the full OPF namespace URL, and the
    # entries live under the 'meta' key (with name='cover' inside the
    # attrs dict). Verified against a Project Gutenberg EPUB on
    # 2026-06-04 — calling get_metadata("OPF", "cover") returns [].
    OPF_NS = "http://www.idpf.org/2007/opf"
    try:
        all_metas = book.get_metadata(OPF_NS, "meta")
    except Exception:
        all_metas = []
    for _, attrs in all_metas or []:
        if (attrs.get("name") or "").lower() != "cover":
            continue
        item_id = attrs.get("content")
        if not item_id:
            continue
        item = book.get_item_with_id(item_id)
        if item and item.media_type in _RASTER_MIMES:
            return _epub_item_to_cover(item, "epub2-meta-cover")

    # 3. EPUB 2: guide refs (Calibre's COVER_TYPES set). ebooklib doesn't
    # expose <guide> as a first-class collection — we'd have to re-parse
    # the OPF ourselves. Practically rare for files that didn't hit
    # steps 1 or 2; skip for v1 and revisit if real-world EPUBs need it.

    # 4. Cover HTML page: look for an xhtml item whose filename contains
    # "cover" and pull the first <img> out of it. Mirrors Calibre's
    # find_cover_page() + find_cover_image_in_page() pair.
    from bs4 import BeautifulSoup  # type: ignore

    for item in book.get_items():
        if item.media_type != "application/xhtml+xml":
            continue
        name = (item.file_name or "").lower()
        if "cover" not in name:
            continue
        try:
            soup = BeautifulSoup(item.get_content(), "html.parser")
        except Exception:
            continue
        img = soup.find("img")
        if not img:
            continue
        src = img.get("src") or img.get("xlink:href")
        if not src:
            continue
        src_path = _resolve_epub_path(item.file_name or "", src)
        target = _find_epub_item_by_path(book, src_path)
        if target and target.media_type in _RASTER_MIMES:
            return _epub_item_to_cover(target, "cover-page-img")

    return None


def _epub_item_to_cover(item, source: str) -> Optional[dict]:
    try:
        content = item.get_content()
    except Exception:
        return None
    if not content:
        return None
    if len(content) > _MAX_INLINE_BYTES:
        # Skip oversized images — see _MAX_INLINE_BYTES comment.
        return {
            "skipped": "too-large",
            "size_bytes": len(content),
            "source": source,
            "mime": item.media_type,
        }
    return {
        "src": _to_data_url(content, item.media_type),
        "mime": item.media_type,
        "size_bytes": len(content),
        "source": source,
    }


def _epub_pick_chapter_images(book) -> list[dict]:
    """For each spine item, find the first <img> that appears AFTER the
    first <h1>/<h2>. That's the chapter-leading image."""
    from bs4 import BeautifulSoup  # type: ignore

    results: list[dict] = []
    # book.spine is a list of (idref, linear_flag) tuples.
    for entry in book.spine or []:
        idref = entry[0] if isinstance(entry, (list, tuple)) else entry
        manifest_item = book.get_item_with_id(idref)
        if not manifest_item:
            continue
        if manifest_item.media_type != "application/xhtml+xml":
            continue
        try:
            soup = BeautifulSoup(manifest_item.get_content(), "html.parser")
        except Exception:
            continue
        heading = soup.find(["h1", "h2"])
        if not heading:
            continue
        img = heading.find_next("img")
        if not img:
            continue
        src = img.get("src")
        if not src:
            continue
        src_path = _resolve_epub_path(manifest_item.file_name or "", src)
        target = _find_epub_item_by_path(book, src_path)
        if not target or target.media_type not in _RASTER_MIMES:
            continue
        try:
            content = target.get_content()
        except Exception:
            continue
        if not content or len(content) > _MAX_INLINE_BYTES:
            continue
        classification = _classify_html_image(img)
        results.append({
            "src": _to_data_url(content, target.media_type),
            "alt": img.get("alt", "") or "",
            "mime": target.media_type,
            "kind": classification["kind"],
            "reason": classification["reason"],
            "chapter_heading": heading.get_text(strip=True)[:200],
            "size_bytes": len(content),
        })
    return results


# ─── Classification (HTML img tag) ────────────────────────────────────


def _classify_html_image(img_tag) -> dict:
    """Return {"kind": "decorative"|"figure", "reason": str}.

    Highest-precision signals come from the accessibility layer. After
    that, filename/class hints. Default to "figure" so the safer
    interpretation is the more conservative one (an image we're not
    sure about gets surfaced as inline content rather than hidden as
    decoration).
    """
    alt = img_tag.get("alt")  # None if missing, "" if empty
    role = (img_tag.get("role") or "").lower()

    # role="presentation" overrides everything else, even non-empty alt.
    if role in ("presentation", "none"):
        return {"kind": "decorative", "reason": "role=presentation"}

    # alt="" (canonical W3C decorative marker — note alt missing entirely
    # is NOT the same as alt="", which is why we use `is`/`==` carefully).
    if alt == "":
        return {"kind": "decorative", "reason": "alt-empty"}

    # <figure>+<figcaption> wrapper is the canonical informational
    # figure marker.
    figure = img_tag.find_parent("figure")
    if figure and figure.find("figcaption"):
        return {"kind": "figure", "reason": "figure-with-figcaption"}

    # Filename/class hints — secondary signal.
    src = (img_tag.get("src") or "").lower()
    klass = " ".join(img_tag.get("class") or []).lower()
    decorative_kw = ("ornament", "fleuron", "vignette", "divider", "decoration", "decorat", "rule", "flourish")
    figure_kw = ("fig", "diagram", "chart", "plate", "photo", "illust")
    if any(kw in src for kw in decorative_kw) or any(kw in klass for kw in decorative_kw):
        return {"kind": "decorative", "reason": "filename-or-class-hint"}
    if any(kw in src for kw in figure_kw) or any(kw in klass for kw in figure_kw):
        return {"kind": "figure", "reason": "filename-or-class-hint"}

    # Alt-text patterns ("Figure 1.2", "Plate III", "Photograph of...").
    alt_lower = (alt or "").lower().strip()
    if alt_lower.startswith(("figure ", "fig.", "fig ", "plate ", "photograph", "diagram ", "chart ")):
        return {"kind": "figure", "reason": "alt-text-pattern"}

    # Default: treat as figure (safer to show than to hide).
    return {"kind": "figure", "reason": "default"}


# ─── PDF ──────────────────────────────────────────────────────────────


def _detect_pdf(data: bytes) -> dict:
    """PDF cover + chapter image detection via PyMuPDF.

    Cover: scan the first 3 pages, pick the one whose largest image
    dominates the page (>40% area coverage). Common patterns this
    catches: cover on page 1 (most files); blank first page then cover
    on page 2 (PDF export quirk).

    Chapter images: walk text+image blocks per page, sort by y-coord;
    an image block immediately preceded by a heading-shaped text block
    is a chapter image. Classified decorative vs figure by aspect ratio
    plus position.
    """
    import fitz  # type: ignore (PyMuPDF)

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        cover = _pdf_pick_cover(doc)
        chapter_images = _pdf_pick_chapter_images(doc)
    finally:
        doc.close()
    return {"cover": cover, "chapter_images": chapter_images}


def _pdf_pick_cover(doc) -> Optional[dict]:
    """First page (of the first three) whose largest image covers >40% of
    the page area. Returns the dominant image as the cover candidate."""
    for page_num in range(min(3, doc.page_count)):
        page = doc[page_num]
        page_area = page.rect.width * page.rect.height
        if page_area <= 0:
            continue
        candidates = page.get_images(full=True)
        if not candidates:
            continue
        best_xref = None
        best_coverage = 0.0
        for img_info in candidates:
            xref = img_info[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:
                rects = []
            if not rects:
                continue
            rect = rects[0]
            coverage = (rect.width * rect.height) / page_area
            if coverage > best_coverage:
                best_coverage = coverage
                best_xref = xref
        if best_xref and best_coverage > 0.4:
            try:
                img = doc.extract_image(best_xref)
            except Exception:
                continue
            content = img.get("image")
            if not content:
                continue
            ext = img.get("ext", "jpeg")
            mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
            if len(content) > _MAX_INLINE_BYTES:
                return {
                    "skipped": "too-large",
                    "size_bytes": len(content),
                    "source": f"pdf-page{page_num + 1}-dominant",
                    "mime": mime,
                }
            return {
                "src": _to_data_url(content, mime),
                "mime": mime,
                "size_bytes": len(content),
                "source": f"pdf-page{page_num + 1}-dominant",
                "coverage": round(best_coverage, 3),
                "width": int(img.get("width") or 0),
                "height": int(img.get("height") or 0),
            }
    return None


def _pdf_pick_chapter_images(doc) -> list[dict]:
    """Per-page spatial pass:
        1. Pull blocks via page.get_text("dict")
        2. Sort by y-coord
        3. Any image block whose preceding text block looks like a
           chapter heading → emit as a chapter image.

    Caveats from research: get_text("dict") occasionally misses image
    blocks (PyMuPDF #4183) and get_image_rects can return wrong bboxes
    for transformed/clipped images (#4850). Detector should be tolerant
    of either failure mode — we degrade gracefully to empty results.
    """
    results: list[dict] = []
    for page_num in range(doc.page_count):
        page = doc[page_num]
        try:
            blocks = page.get_text("dict").get("blocks", [])
        except Exception:
            continue
        # Sort by y0 so we can step through top-to-bottom.
        blocks.sort(key=lambda b: (b.get("bbox") or [0, 0, 0, 0])[1])
        page_width = page.rect.width or 1.0
        for i, block in enumerate(blocks):
            if block.get("type") != 1:  # 1 = image block
                continue
            # Find the nearest preceding text block.
            prev_text_block = None
            for j in range(i - 1, -1, -1):
                if blocks[j].get("type") == 0:
                    prev_text_block = blocks[j]
                    break
            if not prev_text_block:
                continue
            heading_text = _pdf_block_text(prev_text_block).strip()
            if not _looks_like_pdf_heading(heading_text):
                continue
            img_bytes = block.get("image")
            if not img_bytes:
                continue
            if len(img_bytes) > _MAX_INLINE_BYTES:
                continue
            ext = block.get("ext", "jpeg")
            mime = f"image/{'jpeg' if ext == 'jpg' else ext}"
            bbox = block.get("bbox") or [0, 0, 0, 0]
            width = max(0, bbox[2] - bbox[0])
            height = max(0, bbox[3] - bbox[1])
            kind, reason = _pdf_classify_chapter_image(width, height, page_width)
            results.append({
                "src": _to_data_url(img_bytes, mime),
                "alt": "",
                "mime": mime,
                "kind": kind,
                "reason": reason,
                "chapter_heading": heading_text[:200],
                "page": page_num + 1,
                "size_bytes": len(img_bytes),
            })
    return results


def _pdf_block_text(block) -> str:
    parts: list[str] = []
    for line in block.get("lines") or []:
        for span in line.get("spans") or []:
            t = span.get("text")
            if t:
                parts.append(t)
    return " ".join(parts)


_CHAPTER_HEADING_RE = re.compile(
    r"^(chapter|book|part|section|prologue|epilogue|interlude)\b",
    re.IGNORECASE,
)


def _looks_like_pdf_heading(text: str) -> bool:
    """Heading heuristic: short, no terminating period, contains a
    chapter-like keyword OR is title-cased / all-caps."""
    if not text:
        return False
    t = text.strip()
    if not t or len(t) > 120:
        return False
    if t.endswith("."):
        # "Chapter 1." with a period is still a heading — only treat
        # full-sentence terminators as disqualifying.
        if t.count(".") > 1 or len(t) > 80:
            return False
    if _CHAPTER_HEADING_RE.match(t):
        return True
    if t.isupper() and len(t) <= 80:
        return True
    return _is_title_case(t)


def _is_title_case(text: str) -> bool:
    words = [w for w in text.split() if w]
    if len(words) < 2 or len(words) > 12:
        return False
    cap_count = sum(1 for w in words if w[0].isupper())
    return (cap_count / len(words)) > 0.6


def _pdf_classify_chapter_image(width: float, height: float, page_width: float) -> tuple[str, str]:
    """Aspect ratio + page-width coverage as a proxy for decorative vs figure.

    Wide-and-short banners (aspect > 3) under 80% page width are the
    classic decorative chapter ornament. Square-ish or tall images are
    almost always figures (diagrams, photographs, plates).
    """
    if height <= 0 or page_width <= 0:
        return "figure", "default"
    aspect = width / height
    coverage = width / page_width
    if aspect >= 3 and coverage <= 0.85:
        return "decorative", "wide-banner-aspect"
    if aspect <= 1.5:
        return "figure", "tall-or-square"
    return "decorative", "default-chapter-position"


# ─── DOCX ─────────────────────────────────────────────────────────────


_DRAWINGML_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_OFFICEREL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _detect_docx(data: bytes) -> dict:
    """DOCX has no explicit cover convention. We use:
        cover = first image in word/media/ (alphabetical by filename;
                Word numbers them image1, image2, ... in document order
                so the first one is usually the first one inserted)
        chapter images = images in paragraphs that follow Heading 1/2
                paragraphs
    """
    cover = _docx_pick_cover(data)
    chapter_images = _docx_pick_chapter_images(data)
    return {"cover": cover, "chapter_images": chapter_images}


def _docx_pick_cover(data: bytes) -> Optional[dict]:
    """First image in word/media/, by ascending filename. Word's default
    naming (image1, image2, ...) reflects document insertion order, so
    image1 is typically the title page or first inserted image."""
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            media = [n for n in zf.namelist() if n.startswith("word/media/")]
            if not media:
                return None
            media.sort(key=_docx_image_sort_key)
            first = media[0]
            content = zf.read(first)
    except (zipfile.BadZipFile, KeyError):
        return None
    if not content:
        return None
    mime = _ext_to_mime(first.rsplit(".", 1)[-1].lower())
    if mime not in _RASTER_MIMES:
        return None
    if len(content) > _MAX_INLINE_BYTES:
        return {
            "skipped": "too-large",
            "size_bytes": len(content),
            "source": f"docx-{first}",
            "mime": mime,
        }
    return {
        "src": _to_data_url(content, mime),
        "mime": mime,
        "size_bytes": len(content),
        "source": f"docx-{first}",
    }


def _docx_image_sort_key(path: str):
    """image1.png, image2.png, ..., image10.png — natural sort so image2
    beats image10."""
    name = path.rsplit("/", 1)[-1]
    m = re.match(r"image(\d+)\.", name, re.IGNORECASE)
    if m:
        return (0, int(m.group(1)), name)
    return (1, 0, name)


def _docx_pick_chapter_images(data: bytes) -> list[dict]:
    """Walk paragraphs. For each Heading 1/2 paragraph, look at the next
    one or two paragraphs for an inline image (a:blip with r:embed). If
    found, resolve the relationship to the image part and surface it."""
    from docx import Document  # type: ignore

    try:
        doc = Document(io.BytesIO(data))
    except Exception:
        return []

    results: list[dict] = []
    paragraphs = list(doc.paragraphs)
    related = doc.part.related_parts

    for i, paragraph in enumerate(paragraphs):
        style_name = (paragraph.style.name or "").lower() if paragraph.style else ""
        if not style_name.startswith("heading"):
            continue
        heading_text = (paragraph.text or "").strip()
        if not heading_text:
            continue
        # Heading 1/2 only — "Heading 3" and below are usually section
        # subheadings inside a chapter, not chapter starts.
        if not (style_name.startswith("heading 1") or style_name.startswith("heading 2")):
            continue

        # Look at the next 2 paragraphs for an inline image.
        for j in range(i + 1, min(i + 3, len(paragraphs))):
            next_p = paragraphs[j]
            blips = next_p._element.findall(f".//{_DRAWINGML_NS}blip")
            if not blips:
                continue
            embed_id = blips[0].get(f"{_OFFICEREL_NS}embed")
            if not embed_id or embed_id not in related:
                continue
            image_part = related[embed_id]
            content = getattr(image_part, "blob", None)
            if not content:
                continue
            if len(content) > _MAX_INLINE_BYTES:
                break
            mime = getattr(image_part, "content_type", "image/jpeg")
            if mime not in _RASTER_MIMES:
                break
            # Heuristic: an image immediately following a heading is
            # almost always either a decorative chapter banner or a
            # figure. Use the same aspect-ratio rule of thumb as PDF,
            # but we don't have intrinsic dimensions from python-docx
            # without an extra Pillow round-trip. Default decorative
            # (matches the most common "chapter art under the heading"
            # case) and let the user override.
            results.append({
                "src": _to_data_url(content, mime),
                "alt": "",
                "mime": mime,
                "kind": "decorative",
                "reason": "post-heading-paragraph",
                "chapter_heading": heading_text[:200],
                "size_bytes": len(content),
            })
            break  # one chapter image per heading

    return results


# ─── Helpers ──────────────────────────────────────────────────────────


def _to_data_url(content: bytes, mime: str) -> str:
    """Inline base64 data URL — usable by the browser directly without
    a follow-up fetch."""
    b64 = base64.b64encode(content).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _resolve_epub_path(item_path: str, ref: str) -> str:
    """Resolve an in-EPUB reference (relative path) against the spine
    item that referenced it."""
    from posixpath import dirname, normpath, join as pjoin

    base = dirname(item_path or "")
    joined = pjoin(base, ref) if base else ref
    return normpath(joined).replace("\\", "/")


def _find_epub_item_by_path(book, path: str):
    """Linear scan — EPUBs typically have <100 manifest items so this is
    cheap. Could be cached if it ever shows up in profiles."""
    target = (path or "").replace("\\", "/")
    for item in book.get_items():
        if (item.file_name or "").replace("\\", "/") == target:
            return item
    return None


def _ext_to_mime(ext: str) -> str:
    """Filename extension → MIME. Only handles what we'd see embedded in
    a document; falls back to image/jpeg if unrecognized."""
    e = ext.lower()
    if e == "jpg":
        e = "jpeg"
    if e in ("jpeg", "png", "gif", "webp", "bmp"):
        return f"image/{e}"
    return "image/jpeg"
