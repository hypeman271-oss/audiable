"""Build a synthetic Scrivener 3 `.scriv.zip` bundle for unit testing.

Scrivener's real bundle format has many fields we don't touch, but the
ones we DO touch (binder hierarchy, BinderItem Type, Title, child IDs,
Files/Docs/{ID}.rtf) are exercised by this fixture so the parser can be
developed and unit-tested without a real Scrivener install.

Once you have a real Scrivener trial + a real project, replace this
fixture with a real `.scriv.zip` and re-run the parser tests; the
synthetic data only proves the schema-level parser logic, not field-
level quirks of Scrivener's actual output.

Run:  python scripts/make_scrivener_fixture.py
Writes: scripts/fixtures/TestNovel.scriv.zip
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path


# A minimal Scrivener 3 schema. Real .scrivx files have many more
# fields per BinderItem (MetaData, Created, Modified, etc.) but the
# parser tolerates their absence.
SCRIVX = """<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="3.0" Identifier="test">
  <Binder>
    <BinderItem ID="100" Type="DraftFolder">
      <Title>Manuscript</Title>
      <Children>
        <BinderItem ID="101" Type="Folder">
          <Title>Part One</Title>
          <Children>
            <BinderItem ID="2" Type="Text">
              <Title>Chapter 1: The Beginning</Title>
            </BinderItem>
            <BinderItem ID="3" Type="Text">
              <Title>Chapter 2: The Middle</Title>
            </BinderItem>
          </Children>
        </BinderItem>
        <BinderItem ID="4" Type="Text">
          <Title>Chapter 3: The Crossing</Title>
        </BinderItem>
      </Children>
    </BinderItem>
    <BinderItem ID="200" Type="ResearchFolder">
      <Title>Research</Title>
      <Children>
        <BinderItem ID="201" Type="Text">
          <Title>Worldbuilding notes</Title>
        </BinderItem>
      </Children>
    </BinderItem>
    <BinderItem ID="300" Type="TrashFolder">
      <Title>Trash</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>
"""


def _make_rtf(text: str) -> str:
    """Wrap plain text in a minimal valid RTF document. Real Scrivener
    RTF has font tables, color tables, paragraph styles, but striprtf
    handles all of it — we only need a stripped-down version for tests."""
    body = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    body = body.replace("\n", "\\par ")
    return r"{\rtf1\ansi\ansicpg1252\cocoartf2761 " + body + r"}"


DOCS = {
    "2": "It was a dark and stormy night.\nTom looked at Huck.\nThis is chapter one.",
    "3": "The next day was different.\nThey set out together.\nThis is chapter two.",
    "4": "They crossed the river at dawn.\nThe far bank was unfamiliar.\nThis is chapter three.",
    # Research note — should NOT show up in default-imported list.
    "201": "World map: rivers run north to south. The capital is on the east bank.",
}


def main() -> None:
    out_dir = Path(__file__).resolve().parent / "fixtures"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "TestNovel.scriv.zip"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("TestNovel.scriv/TestNovel.scrivx", SCRIVX)
        for doc_id, text in DOCS.items():
            zf.writestr(
                f"TestNovel.scriv/Files/Docs/{doc_id}.rtf",
                _make_rtf(text),
            )

    out_path.write_bytes(buf.getvalue())
    print(f"Wrote: {out_path}")
    print(f"Size:  {out_path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
