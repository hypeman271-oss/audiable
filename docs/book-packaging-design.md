# Book packaging — chapters → one complete book

**Vision.** An author works **chapter by chapter** (each chapter is a clip they
synthesize + animate). When the book is ready, they **package** those chapters
into one complete book — title, author name, cover art, ordered chapters — and
publish it as a single shareable work a consumer reads cover-to-cover.

Today there is no "book" entity: clips are a flat list, and publishing
(Phase 2) shares one clip. This doc specs the grouping layer + how it rides on
the publish foundation already built.

---

## 1. Current state (verified)

- **Clips are flat chapters.** Each chapter = one clip (its own text, audio,
  cover, animation cues). A library order list exists (`/api/library/order`,
  drag-to-reorder), but it's a flat ordering, not a grouping.
- **Cover art is per-clip** (`clip.cover` = `{src,alt}` or data URL, syncs
  inline on the clip).
- **Publishing is single-clip** (Phase 2): `POST /clips/{id}/publish` →
  one-chapter bundle → `/?book=<token>` reader.
- A background **chapter queue** batch-synthesizes multiple clips, but they
  stay separate clips with no "these belong to one book" link.

**Gap:** no entity that says "these N chapters, in this order, with this cover
and title, are one book."

---

## 2. The book entity

A **book** is a persistent collection the author assembles over time:

```
book = {
  id, title, author, description,
  coverSha,            // content-addressed (reuse the anim-sheet/audio store)
  chapterClipIds: [],  // ordered clip ids
  createdAt, updatedAt
}
```

- **Persistent + incremental** — the author adds chapters as they write them
  (not assembled only at publish time), reorders, swaps the cover, edits the
  title, then publishes when ready. Re-opening shows the book in progress.
- **Chapters stay normal clips** — a clip can exist standalone AND be a chapter
  in a book; the book just references clip ids in order. No data duplication.
- **Server**: a `books` table (schema bump) mirroring the clip-sync LWW model
  (`books_json` per tenant or a real table), synced like clips. Cover art goes
  in the content-addressed store (`coverSha`) so it travels (same as Phase 1
  sheets) instead of bloating the row.

## 3. Authoring UX

- **Library → "New book"**: create a book (title + author), then **add
  chapters** by picking existing clips (multi-select from the library) and
  drag-to-order them. A clip's card shows a "📖 part of «Title»" hint.
- **Book cover**: upload art (or reuse a chapter's cover / auto-generate from
  the title). Stored content-addressed.
- **Book shelf**: the library groups a book's chapters under a book header
  (collapsible), or a separate "Books" tab. (Decision below.)

## 4. Packaging + publish (extends Phase 2)

- **`POST /api/library/books/{id}/publish`** snapshots the whole book: book
  metadata + cover sha + an **ordered array of chapter bundles** (each chapter's
  text + audioSha + cues + sheet shas — the same per-chapter snapshot Phase 2
  already builds). One unguessable token → one `/?book=<token>` link for the
  complete work.
- Public reads reuse the Phase 2 surface: `GET /api/published/{token}` returns
  the multi-chapter bundle; `/audio.mp3` becomes per-chapter
  (`/{token}/chapter/{n}/audio.mp3`); sheet reads stay sha-gated against the
  whole book's bundle.
- Snapshot-at-publish (stable link); revocable; re-publish behaviour TBD
  (same-link update is a follow-up, consistent with Phase 2).

## 5. Consumer reading (the payoff)

- The link opens a **cover page** (art + title + author), then the reader.
- **Chapter navigation**: a TOC (chapter list) + next/previous-chapter controls;
  finishing a chapter advances to the next. Each chapter loads its text + audio
  + animations exactly as authored (reusing the Phase 2c consumer loader,
  iterated per chapter).
- Reading position can persist per book (local) so a consumer resumes.

## 6. Phasing

1. **Book model + authoring** — books table + sync; create book, add/order
   chapters, set title/author/cover. (No publish yet — author can assemble.)
2. **Publish a book** — multi-chapter bundle + token (extends Phase 2 server).
3. **Consumer multi-chapter reader** — cover page + TOC + cross-chapter nav
   (extends Phase 2c).
4. **Polish** — book shelf grouping in the library, per-book resume, re-publish
   same link, export bundle (option C).

Each phase is independently shippable; Phase 1 (the model) unblocks the rest.

---

## 7. Decisions to confirm

- **Book entity: persistent (assemble over time) vs publish-time selection.**
  Recommend persistent — matches "works chapter by chapter, then packages."
- **Cover: dedicated book cover vs reuse first chapter's.** Recommend a
  dedicated book cover (uploadable), falling back to the first chapter's.
- **Library presentation: group chapters under a book header in the existing
  library, vs a separate "Books" view.** Affects authoring UX scope.
- **Build order: full thing, or model-first then publish then reader.**
  Recommend incremental (Phase 1 → 2 → 3) so each step is verifiable.
