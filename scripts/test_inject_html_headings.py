"""Unit test for extract._inject_html_headings.

Covers the v85 fix: trafilatura strips Project Gutenberg's chapter
<h2> tags during content extraction, so the chapter detector saw a
single river of prose. The injection helper re-parses the raw HTML
and puts the headings back as `## CHAPTER N` markers in front of the
matching prose. This test exercises it with synthetic HTML + matching
trafilatura-style output so it runs without network.

Run: python scripts/test_inject_html_headings.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extract import _inject_html_headings


def assert_eq(actual, expected, label):
    if actual != expected:
        print(f"FAIL {label}")
        print(f"  expected: {expected!r}")
        print(f"  actual:   {actual!r}")
        sys.exit(1)
    print(f"OK   {label}")


def assert_contains(haystack, needle, label):
    if needle not in haystack:
        print(f"FAIL {label}")
        print(f"  needle:   {needle!r}")
        print(f"  haystack first 500: {haystack[:500]!r}")
        sys.exit(1)
    print(f"OK   {label}")


def test_passthrough_when_md_already_has_headings():
    html = "<html><body><h2>X</h2><p>Body</p></body></html>"
    md = "## Pre-existing heading\n\nBody"
    result = _inject_html_headings(html, md)
    assert_eq(
        result, md, "passes through when md already has markdown headings"
    )


def test_gutenberg_style_injection():
    # Mock-up of PG Tom Sawyer structure: chapter headings in <h2>,
    # body in <p>. Imagine trafilatura's algorithm has stripped the
    # <h2> tags from its markdown output entirely.
    html = """
    <html><body>
    <h2>CHAPTER I.</h2>
    <p>"Tom!" No answer. "TOM!" No answer. "What's gone with that boy, I wonder?"</p>
    <h2>CHAPTER II.</h2>
    <p>Saturday morning was come, and all the summer world was bright and fresh.</p>
    <h2>CHAPTER III.</h2>
    <p>Tom presented himself before Aunt Polly, who was sitting by an open window.</p>
    </body></html>
    """
    md = (
        '"Tom!" No answer. "TOM!" No answer. "What\'s gone with that boy, I wonder?"\n'
        "\n"
        "Saturday morning was come, and all the summer world was bright and fresh.\n"
        "\n"
        "Tom presented himself before Aunt Polly, who was sitting by an open window."
    )
    result = _inject_html_headings(html, md)
    assert_contains(
        result, "## CHAPTER I.", "injects first chapter heading"
    )
    assert_contains(
        result, "## CHAPTER II.", "injects second chapter heading"
    )
    assert_contains(
        result, "## CHAPTER III.", "injects third chapter heading"
    )
    # The body anchor text should still be present.
    assert_contains(
        result, "Saturday morning was come", "preserves body anchor text"
    )
    # And ordering: chapter I appears before II appears before III.
    pos_i = result.index("## CHAPTER I")
    pos_ii = result.index("## CHAPTER II")
    pos_iii = result.index("## CHAPTER III")
    if not (pos_i < pos_ii < pos_iii):
        print("FAIL chapter headings inserted in correct document order")
        sys.exit(1)
    print("OK   chapter headings inserted in correct document order")


def test_skips_unmatched_anchors():
    # The h2 mentions a paragraph that ISN'T in the markdown output —
    # we should skip injection for that one rather than guess.
    html = """
    <html><body>
    <h2>CHAPTER I.</h2>
    <p>This paragraph survives extraction and appears in the markdown.</p>
    <h2>CHAPTER II.</h2>
    <p>This paragraph got stripped by trafilatura for some reason.</p>
    </body></html>
    """
    md = "This paragraph survives extraction and appears in the markdown."
    result = _inject_html_headings(html, md)
    assert_contains(
        result,
        "## CHAPTER I.",
        "still injects chapter whose anchor was matched",
    )
    # The second heading should NOT be injected since its anchor isn't
    # in the markdown — injecting it at an arbitrary spot would be
    # worse than missing it.
    if "## CHAPTER II." in result:
        print(
            "FAIL injected an unmatched heading at a guessed location"
        )
        print(f"  result: {result!r}")
        sys.exit(1)
    print("OK   skipped unmatched anchor instead of guessing")


def test_skips_oversized_heading_text():
    # PG's TOC sometimes collapses into one tag with the entire chapter
    # list pipe-separated. That would be 2000+ chars, useless as a
    # heading. Cap is 200 chars.
    long_h2 = "CHAPTER I. ... " * 50  # >> 200 chars
    html = (
        f"<html><body>"
        f"<h2>{long_h2}</h2>"
        f"<p>Real body paragraph that matches the markdown anchor below.</p>"
        f"</body></html>"
    )
    md = "Real body paragraph that matches the markdown anchor below."
    result = _inject_html_headings(html, md)
    assert_eq(
        result,
        md,
        "drops headings longer than 200 chars (TOC dumps)",
    )


if __name__ == "__main__":
    test_passthrough_when_md_already_has_headings()
    test_gutenberg_style_injection()
    test_skips_unmatched_anchors()
    test_skips_oversized_heading_text()
    print("\nall heading-injection tests passed.")
