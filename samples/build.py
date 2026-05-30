"""Build the tester sample fixtures into static/samples/.

Run from the repo root:
    python samples/build.py

Each fixture is generated deterministically so checked-in outputs
stay stable across runs (no timestamps, no random ids). Re-running
this script overwrites the files in static/samples/ but doesn't
otherwise mutate anything.

Why these fixtures (and not real PDFs/EPUBs):
    - PDFs / EPUBs with real artifacts (running headers, page numbers,
      embedded images) are easier to get from Project Gutenberg than
      to fabricate — the manual links to those directly.
    - The Scrivener .scriv format is awkward to author without the
      Scrivener app; testers who want to test it bring their own.
    - Everything else here is small, plain-text-ish, and rounds out
      coverage of the parser paths that the URL/Gutenberg tests
      don't already exercise.
"""

from __future__ import annotations

import io
import os
import sys
import zipfile
from pathlib import Path

# Make python-docx importable when run from repo root or samples/.
sys.path.insert(0, str(Path(__file__).parent.parent))

OUT_DIR = Path(__file__).parent.parent / "static" / "samples"
OUT_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# 1. Plain-text chapter-marked sample for the paste → chapter-auto-split flow.
#    Three short chapters with the most common heading shapes (Chapter 1.,
#    CHAPTER II, ## Chapter 3) so the detector's all-formats path is exercised.

CHAPTERS_TXT = """\
Chapter 1. The First Light

Cassia woke to the smell of woodsmoke. The hut was cold; the fire
had collapsed to embers somewhere in the small hours. She pulled
the blanket tight and listened to the wind moving through the
pines outside. Somewhere a wolf was singing to itself, low and
patient, like a man humming through a long evening of work.

The candle on the table was burned almost flat. She watched it
shiver in the draft and decided, for the first time in many months,
that she would not get up.


CHAPTER II. THE WALK

By noon the cold had broken. Cassia found her cloak and stepped
out into a forest that smelled of melting snow. The light caught
in the branches and threw a thousand small bright coins onto the
ground; she stopped, three steps from her door, and just looked.

"You're awake, then," said the wolf from the edge of the clearing.
It was sitting on its haunches, watching her with the patient
interest of an old friend.

"I'm awake," Cassia said. "But I don't think I want to be."


## Chapter 3 — A Question

They walked together for a long time. The wolf did not speak again
until the path opened onto a wide meadow stitched with the season's
first crocuses.

"Why," the wolf said, "are you still here?"

Cassia did not answer right away. She watched a hawk drift across
the pale sky and thought about the candle she had let burn out.

"Because nothing else has asked me to leave yet," she said.

The wolf considered this. Then it lay down in the snow at her feet
and closed its eyes.
"""


# ---------------------------------------------------------------------------
# 2. Dialogue sample for Characters voice routing in Author mode.
#    Two named characters + a narrator. Covers the three detection patterns:
#      - "Quote," said Name.
#      - Name said, "Quote."
#      - "Quote." Name walked into the room.
#    Plus a pronoun-only attribution that should fall through to the narrator.

DIALOGUE_TXT = """\
"You're awake, then," said Cassia. She was crouched by the
firepit, coaxing a flame out of the morning embers with one
patient hand.

Marsh blinked at the rafters. "I'm awake, but I am not pleased
about it."

"Coffee in the kettle," Cassia said. "You'll be pleased in five
minutes."

Marsh said, "I'll be pleased when someone tells me what day it
is."

"It's the day after we agreed to never drink that whisky again,"
Cassia said. "Which means it must be Tuesday."

He laughed without opening his eyes. "Of course it does."

She brought the kettle over and set it on the stone beside him.
"How are you?" she asked. He didn't answer; she let the question
sit between them and tended the fire.

Outside, somewhere down the road, a cart rattled past — slow,
loaded heavy with something the driver did not want to spill.
Marsh listened to it pass and finally sat up.

"Better," he said. "Better than I have any right to be."
"""


# ---------------------------------------------------------------------------
# 3. Sample markdown article for the file-upload flow. Has a heading, a
#    paragraph break, a bullet list, and inline emphasis so the splitter +
#    reading-view layout get exercised.

ARTICLE_MD = """\
# The Slow Lesson of the Long Walk

There is a particular kind of writing that only happens after
your body has finished its first argument with the morning. The
coffee has worked; the dog has been let out and back in; the
inbox has been ignored on purpose. You sit down and the sentence
that you had been saving turns out to have been the wrong
sentence — but the *next* one, the one you didn't know was
underneath, is exactly right.

The trick, if there is a trick, is patience.

## Three small disciplines

These are the three I keep coming back to:

- **Walk first.** Twenty minutes is enough. Forty is better. The
  point is not exercise; the point is to give the back of your
  mind something to chew on while the front of your mind warms
  up.
- **Write the bad version.** Get the shape down, even if every
  sentence is wrong. You can't edit nothing.
- **Stop before you're empty.** Always leave the next paragraph
  half-written. It's the only way to come back to the desk
  willing.

## What the work actually is

Most of the work is showing up. The rest is sitting still long
enough to hear what wants to be written, and being honest enough
to write it instead of what you'd planned.

That last bit is harder than the showing up.
"""


# ---------------------------------------------------------------------------
# 4. Synthetic Obsidian vault. Exercises every skip rule:
#      - .obsidian/ (config dir — should be skipped)
#      - templates/ (default skip prefix)
#      - attachments/ (default skip prefix)
#      - .trash/ (dotdir skip)
#      - Two real notes at root + one in a subfolder = three importable items
#      - Wikilinks + an image embed in one of the notes, to confirm flattening
#      - YAML frontmatter with `title:` to confirm filename override

OBSIDIAN_FILES = {
    "Welcome.md": (
        "---\n"
        "title: Welcome — start here\n"
        "tags: [meta]\n"
        "---\n"
        "\n"
        "This is the **Welcome** note. The vault parser should\n"
        "pull the YAML `title:` and use it instead of the filename.\n"
        "\n"
        "There's a [[Project Brief]] note in the same folder, plus\n"
        "a [[Drafts/Chapter 1]] under the Drafts folder. Wikilinks\n"
        "are flattened to plain text on import; image embeds like\n"
        "![[cover.png]] are dropped so the audio doesn't read the\n"
        "filename aloud.\n"
    ),
    "Project Brief.md": (
        "# Project Brief\n"
        "\n"
        "This is the second top-level note. No frontmatter — the\n"
        "filename `Project Brief.md` is used as the chapter title\n"
        "verbatim.\n"
        "\n"
        "We start two weeks behind schedule and finish three weeks\n"
        "ahead. Anyone who tells you the middle was easy is lying.\n"
    ),
    "Drafts/Chapter 1.md": (
        "# Chapter 1 — The Doorway\n"
        "\n"
        "Subfolder notes still come through; their folder name shows\n"
        "in the picker as a subtitle so sister files are easy to\n"
        "spot. This one references [[Welcome]] to confirm the\n"
        "wikilink-flattening pass.\n"
    ),
    # Skip rules — none of the below should appear in the picker.
    ".obsidian/app.json": '{"alwaysUpdateLinks": true}\n',
    ".obsidian/workspace.json": '{"main": {}}\n',
    "templates/Daily Note.md": "# {{date}}\nNotes for the day.\n",
    "templates/Meeting.md": "# Meeting — {{date}}\nAttendees:\n",
    "attachments/cover.png": "PNG\x00not-really-a-png\x00\x00",  # body content irrelevant; presence + path matter
    "attachments/diagram.svg": "<svg>fake</svg>\n",
    ".trash/Old idea.md": "# Discarded\nNot for import.\n",
    ".obsidian/plugins/.gitkeep": "",
}


def _build_obsidian_vault(out_path: Path) -> None:
    """Zip the synthetic vault. Stores files at the top level (no enclosing
    folder) — matches what users typically upload after right-click → zip
    on their vault folder."""
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, content in OBSIDIAN_FILES.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            z.writestr(rel, data)


# ---------------------------------------------------------------------------
# 5. DOCX sample. python-docx is already in requirements (the extractor
#    uses it). We author a short multi-paragraph doc with a heading style so
#    the extractor's heading-preservation path runs.

def _build_docx(out_path: Path) -> None:
    from docx import Document

    doc = Document()
    doc.add_heading("The Slow Lesson of the Long Walk", level=1)
    doc.add_paragraph(
        "There is a particular kind of writing that only happens after "
        "your body has finished its first argument with the morning."
    )
    doc.add_paragraph(
        "The coffee has worked; the dog has been let out and back in; "
        "the inbox has been ignored on purpose."
    )
    doc.add_heading("Three small disciplines", level=2)
    doc.add_paragraph("Walk first. Twenty minutes is enough.", style="List Bullet")
    doc.add_paragraph("Write the bad version. You can't edit nothing.", style="List Bullet")
    doc.add_paragraph(
        "Stop before you're empty. Leave the next paragraph half-written.",
        style="List Bullet",
    )
    doc.add_heading("What the work actually is", level=2)
    doc.add_paragraph(
        "Most of the work is showing up. The rest is sitting still long "
        "enough to hear what wants to be written, and being honest enough "
        "to write it instead of what you'd planned."
    )
    doc.save(out_path)


# ---------------------------------------------------------------------------
# Drive.

def _write_text(path: Path, content: str) -> None:
    # LF endings, UTF-8, trailing newline — deterministic across platforms
    # so the checked-in fixture is reproducible.
    path.write_text(content, encoding="utf-8", newline="\n")


def main() -> int:
    _write_text(OUT_DIR / "sample-chapters.txt", CHAPTERS_TXT)
    _write_text(OUT_DIR / "sample-dialogue.txt", DIALOGUE_TXT)
    _write_text(OUT_DIR / "sample-article.md", ARTICLE_MD)
    _build_obsidian_vault(OUT_DIR / "sample-vault.zip")
    _build_docx(OUT_DIR / "sample-document.docx")

    print("Built sample fixtures into", OUT_DIR)
    for p in sorted(OUT_DIR.iterdir()):
        size = p.stat().st_size
        print(f"  {p.name:32s}  {size:>7d} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
