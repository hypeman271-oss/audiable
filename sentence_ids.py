"""Sentence ID helpers for Author-mode per-sentence storage (#810).

See SENTENCE_IDS.md for the design rationale. Two pieces live here:

  - normalize(text): the agreed-upon normalization for hashing.
                     Unicode NFC + collapse runs of whitespace to one
                     space + trim. Punctuation is preserved (a sentence
                     ending in "?" hashes differently from one ending
                     in ".", which is what authors expect).

  - hash_text(text): hex sha256 of the normalized text, truncated to 12
                     chars. 48 bits of entropy is more than enough at
                     novel scale (~10K sentences) — collision prob is
                     ~10^-9 under a birthday attack on that pop.

The TWIN of this module lives in static/sentence-ids.js. They MUST
agree on every (input, output) pair. The fixture in
tests/sentence_ids_fixture.json drives the test that proves they do.

Why a separate module: client and server BOTH need to compute hashes
(the client when it stamps a fresh hash on edit; the server when it
verifies an incoming line.hash matches the line.text). Drift between
the two implementations would break partial-renarrate detection in
Phase B (#811). Locking the normalization here makes drift a
test-failure, not a silent bug.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

_WHITESPACE_RUN = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Return the canonical form of `text` for hashing.

    Steps (in order, all required):
      1. Unicode NFC. So precomposed-é and decomposed-é hash the same.
      2. Collapse all whitespace runs (any mix of " ", tab, NBSP,
         newlines) to a single ASCII space.
      3. Trim leading and trailing whitespace.

    Punctuation, case, quotes, em-dashes, and accents are all
    preserved — they're meaningful to authors.
    """
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text))
    s = _WHITESPACE_RUN.sub(" ", s)
    return s.strip()


def hash_text(text: str) -> str:
    """SHA-256 of normalize(text), first 12 hex chars. Stable across
    machines, across runs, and (this is the load-bearing claim)
    identical to what the JS twin computes for the same input."""
    n = normalize(text)
    return hashlib.sha256(n.encode("utf-8")).hexdigest()[:12]


def mint_line_id(clip_id: int, seq: int) -> str:
    """Format the canonical line ID for a clip-local counter.

    See SENTENCE_IDS.md "Option 2 — Counter scoped to clip." Format is
    fixed at `c_{clip_id}-{seq:04d}` so IDs sort sensibly in JSON dumps
    and the 4-digit zero-pad gives us 10K sentences per clip before
    we'd need to widen the format. (A novel's worth is ~3-5K.)
    """
    return f"c_{int(clip_id)}-{int(seq):04d}"
