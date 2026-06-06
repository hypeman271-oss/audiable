# Per-sentence ID derivation

Decision in front of us, blocking [#810]: when we snapshot a clip's
sentences for line-by-line storage, what does each sentence's `id`
look like?

The ID has to survive everything authors actually do while revising:

- **Edit** a sentence's text → ID stays (annotation stays)
- **Reorder** sentences → ID stays
- **Insert** a new sentence → it gets a new ID; others unchanged
- **Delete** a sentence → ID is gone; orphaned annotations get
  surfaced, not silently moved
- **Split** one sentence into two → first half keeps the ID; second
  half gets a new one
- **Merge** two sentences → one ID survives; the other is dropped
  (with an annotation migration prompt)

Three candidates.

## Option 1 — Content hash

`id = sha256(normalized_text)[:12]`

**Pros**
- Same content across clips → same ID. Find-and-replace and dedup
  are trivial.
- Splitter-deterministic: re-run the same splitter on the same blob
  and IDs reproduce. Roundtripping import/export is free.

**Cons**
- **Edits break the ID.** The first operation an author performs is
  "fix this sentence," and the annotation on that sentence is now
  orphaned. We can't ship a revision tool whose first interaction
  drops the user's notes.
- **Collisions are common in prose.** `"He nodded."`, `"Yes."`,
  `"She turned away."` will appear dozens of times in a novel; all
  collapse to one ID. An annotation on instance 7 silently applies
  to instance 1.

**Verdict:** wrong shape. Sentences are mutable records, not
immutable content-addressed blobs. Content-hash is the right tool
for git and IPFS (immutable snapshots) and the wrong tool for
"editable user data the author is going to mutate all week."

## Option 2 — Counter scoped to clip

`id = clip_id + "-" + monotonic_counter`
e.g. `c_4a7f-0001`, `c_4a7f-0002`, ..., `c_4a7f-0042` for the 42nd
sentence ever created in this clip.

The counter is **birth order**, not position. Once assigned, never
reused. Position is just the array index.

**Pros**
- Survives every author operation cleanly:
  - Edit → counter unchanged
  - Reorder → counter unchanged (position changes, ID doesn't)
  - Insert → new counter for the new one
  - Delete → counter is gone; orphaned annotation is knowable, not
    silently misapplied
  - Split → keep the counter on the first half, mint a new counter
    for the second
  - Merge → one counter survives, the other is dropped
- Stable across export/import as long as the clip ID and counter
  map travel together (they do — same clip record).
- O(1) to mint, O(1) to look up.

**Cons**
- Not portable across clips. Sentence `c_4a7f-0001` means nothing
  in a different clip. We don't actually want it to — the use case
  is editing one chapter, not deduping across the library.
- Counter has to be persisted in the clip record so we know the
  next value to mint. Trivial — single integer field next to
  `lines`.

**Verdict:** matches every real operation. Boring but correct.

## Option 3 — Content hash + first-occurrence index

`id = sha256(text)[:8] + "_" + occurrence_index`
e.g. for three appearances of `"He nodded."` → `a3f2e1b9_0`,
`a3f2e1b9_1`, `a3f2e1b9_2`.

Patches Option 1's collision flaw.

**Pros**
- Fixes the dup-text collision case in Option 1.

**Cons**
- **Still breaks on edit.** The whole point of the hash component
  is "ID = content." Change the content, you've changed the ID;
  the annotation orphans. Option 1's biggest failure mode is
  inherited verbatim.
- **Renumbering hazard on delete.** If you remove the first
  occurrence, do `_1` and `_2` slide down to `_0` and `_1`? Yes →
  annotations break. No → the ID space accumulates gaps that get
  weirder over time.

**Verdict:** strictly worse than Option 1 for the same fundamental
reason — sentences aren't content-addressable, they're records.

## The lens that decides it

> Tools that edit mutable user records assign IDs at birth and
> never re-derive them.

Google Docs, Notion, Figma, every collaborative editor uses
counter or UUID per block. The reason is exactly what Options 1
and 3 fail: the moment you derive an ID from content, the first
content edit re-IDs the record and breaks every reference to it.
Hashes are perfect for "is this the same bytes I had yesterday"
and wrong for "is this the same thing the user has been editing
all week."

## Recommendation

**Ship Option 2** (clip-local counter).

Schema for Phase A (#810):

```
clips.lines = [
  {
    id:   "c_4a7f-0001",
    text: "It is a truth universally acknowledged...",
    hash: "a3f2…"    -- sha256(text)[:12], for change detection
  },
  {
    id:   "c_4a7f-0002",
    text: "However little known the feelings...",
    hash: "8d22…"
  },
  ...
]

clips.next_line_seq = 43   -- next counter to mint
```

The **content hash** still rides on the record as a separate field
— it's how we detect "this sentence's text changed since last
synth" for partial re-narrate in Phase B (#811). But the hash is
not the identity. The identity is the counter.

## Existing-clip conversion: start fresh

When an Author flips "Enable line-by-line storage" on a clip that
already has annotations or per-sentence voice assignments, **drop
them** as part of the conversion. Don't attempt to migrate index-
based anchors to ID-based anchors.

Reasoning: the whole point of Phase A is that IDs are stable from
birth. Migration would mint IDs that *look* stable but are actually
best-effort matches against the splitter's current output. The
moment the splitter disagrees with the user's intent on a single
boundary, the migrated anchors are silently wrong — worse than
empty.

Implied UX on the toggle:

> Converting to line-by-line storage will remove the 3 annotations
> and 7 character voice assignments on this clip.
> They use position-based anchors that the new storage model
> can't carry forward.
>
> [ Export annotations first ↗ ]  [ Cancel ]  [ Convert ]

The "Export annotations first" link routes through the existing
Markdown export (#604 / v225dr) so nothing is lost — the author
walks away with a `.md` file of every flag, highlight, and note
keyed to the sentence quotes they made them on, and can re-create
the ones they care about against the new stable IDs.

What's NOT touched by conversion:
- Bookmarks (audio-time-based, splitter-agnostic).
- Notes (clip-level, no sentence anchor).
- Highlights (text-range-based, splitter-agnostic).

What IS dropped:
- Annotations (sentence-index-anchored).
- Per-sentence voice assignments (sentence-index-anchored).

## Open follow-ups (not blocking)

- **Cross-clip paste.** If someone copies sentences from one clip
  into another, the new clip mints fresh counters. Identity is
  lost across the boundary, which is correct: it's a paste, not
  a sync.
- **UUID alternative.** `uuid4()` per sentence would also work —
  slightly more bytes, no counter persistence, no birth-order
  info leakage. Counter is cheaper and the info ("which sentence
  was created first") is occasionally useful. Either is correct;
  ship counter unless we hit a reason to switch.
- **Hash normalization.** The `hash` field needs a stable
  normalization (Unicode NFC, collapse runs of whitespace, keep
  punctuation). Lock this once in a helper so client and server
  agree.
