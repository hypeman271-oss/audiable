"""Unit tests for extract.extract_obsidian_vault.

Uses the synthetic fixture from `make_obsidian_fixture.py`. Confirms:
  - .obsidian/, .trash/, templates/, attachments/ are all skipped
  - YAML frontmatter `title:` overrides the filename-derived title
  - Wikilinks [[X]] and [[X|Y]] are stripped to plain text
  - Embeds ![[X]] are dropped entirely
  - Vault-root prefix is stripped from chapter paths
  - Notes are sorted by folder path then title

Run:  python scripts/test_obsidian_parser.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extract import extract_obsidian_vault


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


def assert_not_in(haystack, needle, label):
    if needle in haystack:
        print(f"FAIL {label}")
        print(f"  needle:   {needle!r} should NOT be in")
        print(f"  haystack: {haystack!r}")
        sys.exit(1)
    print(f"OK   {label}")


def main():
    fixture = Path(__file__).resolve().parent / "fixtures" / "TestVault.zip"
    if not fixture.exists():
        print("Fixture missing. Run: python scripts/make_obsidian_fixture.py")
        sys.exit(1)

    data = fixture.read_bytes()
    result = extract_obsidian_vault(data)

    assert_eq(result["vault_name"], "TestVault", "vault_name detected from top-level folder")

    chapters = result["chapters"]
    titles = [c["title"] for c in chapters]
    paths = [c["path"] for c in chapters]

    # Five real notes: 3 in Manuscript/, 1 in Notes/, 1 at root.
    # (.obsidian/, templates/, attachments/, .trash/ all skipped.)
    assert_eq(len(chapters), 5, "exactly 5 notes (config/template/trash skipped)")

    # ---- skip behavior ----
    assert_not_in(titles, "Note template", "templates/ skipped")
    assert_not_in(titles, "Old draft", ".trash/ skipped")
    # No .obsidian config noise (these aren't .md files, so they should
    # just not appear — sanity check)
    for t in titles:
        if "app.json" in t or "workspace" in t:
            print(f"FAIL .obsidian config leaked: {t!r}")
            sys.exit(1)
    print("OK   .obsidian/ contents do not leak")

    skipped_paths = [s["path"] for s in result["skipped"]]
    assert any("templates" in p for p in skipped_paths), \
        f"FAIL templates/ should appear in skipped, got {skipped_paths}"
    print("OK   templates/ reported in skipped")
    assert any(".trash" in p for p in skipped_paths), \
        f"FAIL .trash should appear in skipped, got {skipped_paths}"
    print("OK   .trash/ reported in skipped")

    # ---- title resolution ----
    # Chapter Two has YAML frontmatter `title: The Long Crossing`
    assert_contains(titles, "The Long Crossing", "frontmatter title overrides filename")
    # Worldbuilding has frontmatter too
    assert_contains(titles, "The Geography of It All", "frontmatter title in Notes/")
    # Chapter One has no frontmatter — title falls back to filename minus .md
    assert_contains(titles, "01 - Chapter One", "filename fallback for plain notes")

    # ---- path stripping (vault-root prefix removed) ----
    # Manuscript notes should have path "Manuscript", not "TestVault/Manuscript"
    manuscript_paths = [c["path"] for c in chapters if c["title"].startswith("01") or c["title"] == "The Long Crossing"]
    for p in manuscript_paths:
        assert_eq(p, "Manuscript", f"path stripped of vault root for {p!r}")

    # ---- wikilink + embed stripping ----
    wikilink_chapter = next(c for c in chapters if "wikilinks" in c["title"].lower())
    assert_contains(
        wikilink_chapter["text"],
        "Tom thought about Aunt Polly",
        "[[Aunt Polly]] stripped to 'Aunt Polly'",
    )
    assert_contains(
        wikilink_chapter["text"],
        "He passed the old mill on his way",
        "[[The Old Mill|the old mill]] stripped to alias 'the old mill'",
    )
    assert_not_in(
        wikilink_chapter["text"],
        "[[",
        "no [[ bracket survivors in TTS text",
    )
    assert_not_in(
        wikilink_chapter["text"],
        "map.png",
        "![[map.png]] embed dropped",
    )
    assert_not_in(
        wikilink_chapter["text"],
        "Other Note",
        "![[Other Note]] embed dropped (not converted to wikilink)",
    )

    # ---- sort order ----
    # Notes/ then Manuscript/ then root — but our sort is (path, title) so
    # empty-path roots come first lexicographically. Verify deterministic
    # order rather than asserting one specific order.
    sorted_check = sorted(
        ((c["path"], c["title"].lower()) for c in chapters),
    )
    actual_order = [(c["path"], c["title"].lower()) for c in chapters]
    assert_eq(actual_order, sorted_check, "chapters sorted by (path, title)")

    print("\nall obsidian parser tests passed.")
    print(f"\nparsed: {len(chapters)} note(s), {len(result['skipped'])} skipped")


if __name__ == "__main__":
    main()
