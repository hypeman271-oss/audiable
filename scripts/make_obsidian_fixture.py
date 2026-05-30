"""Build a synthetic Obsidian vault `.zip` for unit testing.

Real Obsidian vaults are just folders of .md files plus a `.obsidian/`
config directory. This fixture mirrors that structure with the cases
the parser needs to exercise:

  TestVault/
    .obsidian/app.json              (config — must be skipped)
    .obsidian/workspace.json        (config — must be skipped)
    templates/Note template.md      (template — must be skipped)
    attachments/cover.png           (binary — must be skipped)
    Manuscript/
      01 - Chapter One.md           (plain note)
      02 - Chapter Two.md           (with YAML frontmatter title override)
      03 - Has wikilinks.md         (wikilinks + embed cases)
    Notes/
      Worldbuilding.md              (lives outside Manuscript — still imports)
    Welcome.md                      (top-level note)
    .trash/Old draft.md             (trash — must be skipped)

Once we have a real Obsidian trial + vault, the parser tests can be
re-run against a real export to catch field-level quirks. The synthetic
fixture only proves schema-level logic.

Run:  python scripts/make_obsidian_fixture.py
Writes: scripts/fixtures/TestVault.zip
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path


VAULT_NAME = "TestVault"


FILES = {
    # Config — should never appear in chapters
    ".obsidian/app.json": '{"showLineNumber": true}',
    ".obsidian/workspace.json": '{"main": {}}',
    # Template — should be skipped
    "templates/Note template.md": (
        "# {{title}}\n\nDate: {{date}}\n\nNotes here.\n"
    ),
    # Attachment — binary, .png never matches .md filter
    "attachments/cover.png": "\x89PNG\r\n\x1a\n(fake png bytes for fixture)",
    # Trash — should be skipped
    ".trash/Old draft.md": (
        "# Old draft\n\nThis was deleted by the author.\n"
    ),
    # ---- Real notes ----
    "Manuscript/01 - Chapter One.md": (
        "# Chapter One\n\n"
        "It was a dark and stormy night when Tom met Huck.\n\n"
        "They walked along the river bank, talking of small things.\n"
    ),
    "Manuscript/02 - Chapter Two.md": (
        "---\n"
        "title: The Long Crossing\n"
        "tags: [fiction, draft]\n"
        "date: 2026-01-15\n"
        "---\n\n"
        "# Chapter Two\n\n"
        "The river was wider than Tom had remembered.\n"
    ),
    "Manuscript/03 - Has wikilinks.md": (
        "# Chapter Three\n\n"
        "Tom thought about [[Aunt Polly]] as he walked.\n\n"
        "He passed [[The Old Mill|the old mill]] on his way home.\n\n"
        "![[map.png]]\n\n"
        "![[Other Note]]\n\n"
        "Then he kept walking.\n"
    ),
    "Notes/Worldbuilding.md": (
        "---\n"
        "title: The Geography of It All\n"
        "---\n\n"
        "Rivers run north to south.\n\n"
        "The capital city is on the east bank of the great river.\n"
    ),
    "Welcome.md": (
        "# Welcome\n\n"
        "This vault is where I write my novel.\n"
    ),
}


def main() -> None:
    out_dir = Path(__file__).resolve().parent / "fixtures"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "TestVault.zip"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, content in FILES.items():
            full_path = f"{VAULT_NAME}/{rel}"
            if isinstance(content, str):
                zf.writestr(full_path, content)
            else:
                zf.writestr(full_path, content)

    out_path.write_bytes(buf.getvalue())
    print(f"Wrote: {out_path}")
    print(f"Size:  {out_path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
