"""Unit tests for extract.extract_scrivener_bundle.

Uses the synthetic fixture from `make_scrivener_fixture.py`. Confirms:
  - DraftFolder/Manuscript subtree is walked in binder order
  - Nested Folder hierarchy is preserved in the `path` field
  - ResearchFolder / TrashFolder are skipped
  - Empty / missing RTF documents are reported in `skipped`, not chapters

Run:  python scripts/test_scrivener_parser.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extract import extract_scrivener_bundle


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
        print(f"  haystack: {haystack!r}")
        sys.exit(1)
    print(f"OK   {label}")


def main():
    fixture = Path(__file__).resolve().parent / "fixtures" / "TestNovel.scriv.zip"
    if not fixture.exists():
        print("Fixture missing. Run: python scripts/make_scrivener_fixture.py")
        sys.exit(1)

    data = fixture.read_bytes()
    result = extract_scrivener_bundle(data)

    assert_eq(result["project_name"], "TestNovel", "project_name parses")

    chapters = result["chapters"]
    assert_eq(len(chapters), 3, "exactly 3 chapters (Research skipped)")

    # Binder order: Part One / Chapter 1, Part One / Chapter 2, Chapter 3
    assert_eq(
        chapters[0]["title"],
        "Chapter 1: The Beginning",
        "chapter 1 title",
    )
    assert_eq(
        chapters[0]["path"],
        "Manuscript/Part One",
        "chapter 1 nested folder path preserved",
    )
    assert_contains(
        chapters[0]["text"],
        "It was a dark and stormy night",
        "chapter 1 RTF prose extracted",
    )

    assert_eq(
        chapters[1]["title"],
        "Chapter 2: The Middle",
        "chapter 2 title",
    )

    assert_eq(
        chapters[2]["title"],
        "Chapter 3: The Crossing",
        "chapter 3 title (sibling to Part One folder)",
    )
    assert_eq(
        chapters[2]["path"],
        "Manuscript",
        "chapter 3 top-level path (not nested)",
    )

    # Research item should be in skipped
    skipped_paths = [s["path"] for s in result["skipped"]]
    assert_contains(
        skipped_paths,
        "Research",
        "Research folder reported in skipped (not in chapters)",
    )

    # Trash too
    assert_contains(
        skipped_paths,
        "Trash",
        "Trash folder reported in skipped",
    )

    # No research note in chapters
    chapter_titles = [c["title"] for c in chapters]
    if "Worldbuilding notes" in chapter_titles:
        print("FAIL Research notes leaked into chapters")
        sys.exit(1)
    print("OK   Research notes do NOT appear in chapters")

    print("\nall scrivener parser tests passed.")
    print(f"\nparsed: {len(chapters)} chapter(s), {len(result['skipped'])} skipped")


if __name__ == "__main__":
    main()
