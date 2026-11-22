// Storyboard import: the pure half (v4.253).
//
// A storyboard is a whole book's scenes in one JSON file: for each chapter
// (a clip, named by its library title), the scenes in reading order, each
// anchored to a run of the chapter's own text. This module answers the two
// questions the import asks, with no DOM, no IndexedDB and no network, so
// tests/storyboard_import_test.js can run it in plain Node:
//
//   parse(raw, { fx })   -> is this a storyboard, and what does it hold?
//   placeChapter(...)    -> which sentence does each scene sit on, and why
//                           not, for each one that cannot be placed?
//
// The app half (app.js, "Storyboard import") stores the pictures, writes the
// cues through _mutateClipAtomic and shows the report. Every row comes back
// with a status: nothing a storyboard names is dropped without a line saying
// why, because a scene that silently fails to appear looks exactly like a
// scene that was never authored.
//
// Sentence numbering is NOT decided here. The caller hands in the sentences
// exactly as the reading view numbers them (splitSentencesClient(clip.text))
// and the line ids it stamps (clip.lines, only when the counts agree), so a
// scene lands on the sentence the reader sees it on.

(() => {
  "use strict";

  // Fold a string for comparison: NFC, curly quotes and apostrophes to
  // straight ones, the ellipsis character to three dots, whitespace runs to
  // one space. Guillemets are kept: «telepathy» is real text in the books.
  // Applied to both sides, so it only decides what counts as "the same".
  const QUOTE_FOLD = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "…": "...",
  };
  function fold(text) {
    if (text == null) return "";
    let s = String(text).normalize("NFC");
    s = s.replace(/[‘’‚‛“”„‟…]/g, (c) => QUOTE_FOLD[c]);
    return s.replace(/\s+/g, " ").trim();
  }

  // An anchor as written in a storyboard may open or close with an ellipsis
  // ("...from the feet up, unhurried, kind."). Those mark an excerpt, not
  // text to match.
  function foldAnchor(anchor) {
    return fold(anchor).replace(/^(\.\.\.\s*)+/, "").replace(/(\s*\.\.\.)+$/, "").trim();
  }

  // Validate a parsed storyboard. Returns { ok, title, chapters, errors }.
  // `opts.fx` is the app's set of built-in effects (_ANIM_FX): the app owns
  // that list, this module never keeps a copy of it.
  function parse(raw, opts) {
    const fxOk = (opts && opts.fx) || new Set();
    const errors = [];
    if (!raw || typeof raw !== "object" || raw.storyboard !== 1) {
      return { ok: false, title: "", chapters: [], errors: ['Not a storyboard file (it needs "storyboard": 1).'] };
    }
    if (!Array.isArray(raw.chapters) || raw.chapters.length === 0) {
      return { ok: false, title: "", chapters: [], errors: ["The storyboard lists no chapters."] };
    }
    const seenIds = new Set();
    const seenClips = new Set();
    const chapters = [];
    raw.chapters.forEach((ch, ci) => {
      const clip = ch && typeof ch.clip === "string" ? ch.clip.trim() : "";
      if (!clip) {
        errors.push(`Chapter ${ci + 1} has no "clip" title.`);
        return;
      }
      if (seenClips.has(clip)) {
        errors.push(`"${clip}" is listed twice.`);
        return;
      }
      seenClips.add(clip);
      const scenes = [];
      (Array.isArray(ch.scenes) ? ch.scenes : []).forEach((sc, si) => {
        const where = `${clip}, scene ${si + 1}`;
        const id = sc && typeof sc.id === "string" ? sc.id.trim() : "";
        if (!id) { errors.push(`${where} has no "id".`); return; }
        if (seenIds.has(id)) { errors.push(`${where}: the id "${id}" is used twice.`); return; }
        seenIds.add(id);
        const anchor = typeof sc.anchor === "string" ? sc.anchor : "";
        if (!foldAnchor(anchor)) { errors.push(`${where} (${id}) has no "anchor" text.`); return; }
        const image = typeof sc.image === "string" && sc.image.trim() ? sc.image.trim() : null;
        let fx = typeof sc.fx === "string" && sc.fx.trim() ? sc.fx.trim() : null;
        if (fx && !fxOk.has(fx)) {
          errors.push(`${where} (${id}): "${fx}" is not an effect Lyrith has (${[...fxOk].join(", ")}).`);
          fx = null;
        }
        scenes.push({ id, anchor, image, fx });
      });
      chapters.push({ clip, scenes });
    });
    return { ok: true, title: typeof raw.title === "string" ? raw.title : "", chapters, errors };
  }

  // Where an existing cue sits now: its line id when the chapter stamps
  // them, else its stored index. Mirrors app.js _animResolveRange.
  function cueIndex(cue, lineIdToIdx) {
    if (lineIdToIdx && cue.startLineId != null && lineIdToIdx.has(cue.startLineId)) {
      return lineIdToIdx.get(cue.startLineId);
    }
    return typeof cue.startIdx === "number" ? cue.startIdx : null;
  }

  // Place one chapter's scenes.
  //   sentences: string[]       the chapter as the reading view splits it
  //   lineIds:   string[]|null  stable ids, only when lines match sentences
  //   scenes:    parsed scenes for this chapter, in reading order
  //   cues:      the clip's current animationCues
  //   fileIds:   every scene id in the whole storyboard (a scene may move
  //              chapters between versions of the file)
  // Returns { rows, keep, orphans }:
  //   rows:    one per scene { id, status, idx?, lineId?, detail? }
  //            status: placed | not-found | out-of-order | kept-yours |
  //                    same-sentence | no-art
  //   keep:    the existing cues that stay (everything this storyboard did
  //            not place earlier); placed rows are added to these by the app
  //   orphans: cues an earlier import placed whose id is no longer in the
  //            file. Kept, and listed, never deleted here.
  function placeChapter({ sentences, lineIds, scenes, cues, fileIds }) {
    const sents = Array.isArray(sentences) ? sentences : [];
    const ids = Array.isArray(lineIds) && lineIds.length === sents.length ? lineIds : null;
    const lineIdToIdx = ids ? new Map(ids.map((id, i) => [id, i])) : null;
    const inFile = fileIds instanceof Set ? fileIds : new Set(scenes.map((s) => s.id));

    // The chapter as one folded string, with where each sentence starts.
    const starts = [];
    let joined = "";
    sents.forEach((s, i) => {
      if (i) joined += " ";
      starts.push(joined.length);
      joined += fold(s);
    });
    const sentenceAt = (pos) => {
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    // Earlier imports' scenes that this file still names are replaced:
    // drop them now and place them again below. Anything else stays.
    const existing = Array.isArray(cues) ? cues : [];
    const keep = [];
    const orphans = [];
    const previous = new Map(); // scene id -> the cue an earlier import placed
    for (const c of existing) {
      const sid = c && c.storyboard && c.storyboard.id;
      if (sid && inFile.has(sid)) {
        previous.set(sid, c);
        continue;
      }
      keep.push(c);
      if (sid) orphans.push(c);
    }
    // One cue per sentence (the palette's rule): a sentence that still holds
    // a cue after the drop above is someone else's, and is left alone.
    const taken = new Map();
    for (const c of keep) {
      const i = cueIndex(c, lineIdToIdx);
      if (i != null) taken.set(i, c);
    }

    const rows = [];
    const usedHere = new Set();
    let cursor = 0;
    for (const sc of scenes) {
      if (!sc.image && !sc.fx) {
        rows.push({ id: sc.id, status: "no-art", detail: "No picture and no effect." });
        continue;
      }
      const needle = foldAnchor(sc.anchor);
      let pos = joined.indexOf(needle, cursor);
      if (pos < 0) {
        const earlier = joined.indexOf(needle);
        if (earlier >= 0) {
          rows.push({ id: sc.id, status: "out-of-order", idx: sentenceAt(earlier),
            detail: "Found only before the previous scene's line." });
        } else {
          rows.push({ id: sc.id, status: "not-found", detail: sc.anchor });
        }
        continue;
      }
      cursor = pos + needle.length;
      const idx = sentenceAt(pos);
      if (usedHere.has(idx)) {
        rows.push({ id: sc.id, status: "same-sentence", idx,
          detail: "Another scene in this file is already on that sentence." });
        continue;
      }
      const blocker = taken.get(idx);
      if (blocker) {
        rows.push({ id: sc.id, status: "kept-yours", idx,
          detail: blocker.storyboard && blocker.storyboard.id
            ? `An earlier storyboard scene (${blocker.storyboard.id}) is on that sentence.`
            : "A scene you placed by hand is on that sentence." });
        continue;
      }
      usedHere.add(idx);
      rows.push({ id: sc.id, status: "placed", idx, lineId: ids ? ids[idx] : null });
    }
    // A scene an earlier import placed, whose row could not be placed this
    // time (its line was revised away, say), stays where it was rather than
    // vanishing: the row says so. Unless a scene placed now took its sentence.
    for (const row of rows) {
      if (row.status === "placed") continue;
      const prev = previous.get(row.id);
      if (!prev) continue;
      const at = cueIndex(prev, lineIdToIdx);
      if (at != null && usedHere.has(at)) {
        row.previous = "removed";
        row.detail = (row.detail ? row.detail + " " : "") +
          "Its earlier scene was on a sentence another scene now takes, so it was removed.";
      } else {
        keep.push(prev);
        row.previous = "kept";
        row.detail = (row.detail ? row.detail + " " : "") +
          `Its earlier scene stays on sentence ${at == null ? "?" : at + 1}.`;
      }
    }
    return { rows, keep, orphans };
  }

  const api = { fold, foldAnchor, parse, placeChapter };
  if (typeof window !== "undefined") window.NS_STORYBOARD = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
