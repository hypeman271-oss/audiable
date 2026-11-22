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
//   outlineChapter(...)  -> v4.255: a chapter's scenes as the storyboard
//                           editor lists them, in reading order
//   exportBook(...)      -> v4.255: the book's scenes as a storyboard file,
//                           proved to place back on the same sentences
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
  // Does this parsed JSON claim to be a storyboard at all? Picking a whole
  // folder brings other .json files with it (a tool's .standins.json).
  function isStoryboard(raw) {
    return !!raw && typeof raw === "object" && raw.storyboard === 1;
  }

  function parse(raw, opts) {
    const fxOk = (opts && opts.fx) || new Set();
    const errors = [];
    if (!isStoryboard(raw)) {
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
        // v4.255: the painting brief travels with the scene (the editor's
        // Details ▸ Brief). Optional; the import only stores it.
        const brief = {};
        if (typeof sc.shot === "string" && sc.shot.trim()) brief.shot = sc.shot.trim();
        if (typeof sc.art === "string" && sc.art.trim()) brief.art = sc.art.trim();
        if (sc.key === true) brief.key = true;
        scenes.push(Object.assign({ id, anchor, image, fx }, brief));
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
  //   hasSheet:  the app's answer to "does this cue carry a picture"
  //              (_animCueHasSheet); without it an earlier cue counts as art
  // Each scene may say pictureMissing: its picture was named but is not
  // here (not picked, or unreadable), so the app passed it with image null.
  // Returns { rows, keep, orphans }:
  //   rows:    one per scene { id, status, idx?, lineId?, detail? }
  //            status: placed | not-found | out-of-order | kept-yours |
  //                    same-sentence | no-art
  //   keep:    the existing cues that stay (everything this storyboard did
  //            not place earlier); placed rows are added to these by the app
  //   orphans: cues an earlier import placed whose id is no longer in the
  //            file. Kept, and listed, never deleted here.
  //
  // v4.255: a scene with neither picture nor effect (none in the file, or
  // its picture not picked yet) is PLACED, as a placeholder that holds its
  // brief; readers never see one, the scene before it holds. It is "no-art"
  // only when placing it would take art away from an earlier import's scene
  // for it, and that scene stays: the file gives no art and the earlier one
  // has some, or the file's picture is missing and the earlier one has a
  // picture.
  function placeChapter({ sentences, lineIds, scenes, cues, fileIds, hasSheet }) {
    const sents = Array.isArray(sentences) ? sentences : [];
    const ids = Array.isArray(lineIds) && lineIds.length === sents.length ? lineIds : null;
    const lineIdToIdx = ids ? new Map(ids.map((id, i) => [id, i])) : null;
    const inFile = fileIds instanceof Set ? fileIds : new Set(scenes.map((s) => s.id));
    const hasPicture = (c) => !!c && (typeof hasSheet === "function" ? hasSheet(c) : true);
    const hasArt = (c) => !!c && (!!c.fx || hasPicture(c));

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
      const prev = previous.get(sc.id);
      if ((!sc.image && !sc.fx && hasArt(prev)) || (sc.pictureMissing && hasPicture(prev))) {
        rows.push({ id: sc.id, status: "no-art", detail: "" });
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

  // v4.255: a chapter's page scenes in reading order, as the storyboard
  // editor lists them. `hasSheet(cue)` is the app's own answer to "does this
  // cue carry a picture" (_animCueHasSheet), never a copy of it.
  //   returns [{ cue, idx, until, status, id, hand, fx, anchor, sentence }]
  //     status: picture | fx | empty | lost (its sentence is gone)
  //     until:  the last sentence the scene covers (it holds until the next)
  function outlineChapter({ sentences, lineIds, cues, hasSheet }) {
    const sents = Array.isArray(sentences) ? sentences : [];
    const ids = Array.isArray(lineIds) && lineIds.length === sents.length ? lineIds : null;
    const lineIdToIdx = ids ? new Map(ids.map((id, i) => [id, i])) : null;
    const pic = typeof hasSheet === "function" ? hasSheet : () => false;
    const rows = [];
    for (const cue of Array.isArray(cues) ? cues : []) {
      if (!cue || cue.kind !== "page") continue;
      let idx = cueIndex(cue, lineIdToIdx);
      if (idx != null && (idx < 0 || idx >= sents.length)) idx = null;
      const stamp = cue.storyboard || null;
      rows.push({
        cue,
        idx,
        until: null,
        status: idx == null ? "lost" : pic(cue) ? "picture" : cue.fx ? "fx" : "empty",
        id: stamp && stamp.id ? stamp.id : null,
        hand: !(stamp && stamp.id),
        fx: cue.fx || null,
        anchor: stamp && stamp.anchor ? stamp.anchor : idx != null ? sents[idx] : "",
        sentence: idx != null ? sents[idx] : "",
      });
    }
    rows.sort((a, b) => (a.idx == null ? Infinity : a.idx) - (b.idx == null ? Infinity : b.idx));
    const placed = rows.filter((r) => r.idx != null);
    placed.forEach((r, i) => {
      r.until = i + 1 < placed.length ? Math.max(r.idx, placed[i + 1].idx - 1) : sents.length - 1;
    });
    return rows;
  }

  // v4.255: the book's scenes as a storyboard file (the editor's Export).
  //   chapters:    [{ clip, sentences, lineIds, cues }] in book order
  //   hasSheet:    as in outlineChapter
  //   pictureName: (cue, sceneId) -> the picture's file name, or null
  // Returns { file, pictures: [{ cue, name }], warnings: [string] }.
  //
  // Each scene keeps the author's stored anchor (which may run on into the
  // next sentence) as long as it still places the scene on its own sentence;
  // the import's matcher is the judge, not a guess. Where it would not (the
  // text was revised, or no anchor was stored), the sentence itself is the
  // anchor. Then the file is PLACED again against the same sentences: a
  // scene that would still come back on another sentence (one that repeats
  // earlier in the chapter) is named in the warnings, never exported wrong.
  function exportBook({ title, chapters, hasSheet, pictureName }) {
    const out = { storyboard: 1, title: title || "Storyboard", chapters: [] };
    const pictures = [];
    const warnings = [];
    const usedIds = new Set();
    for (const ch of Array.isArray(chapters) ? chapters : []) {
      const rows = outlineChapter({ sentences: ch.sentences, lineIds: ch.lineIds, cues: ch.cues, hasSheet });
      if (!rows.length) continue;
      const slug = String(ch.clip || "chapter").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "chapter";
      const scenes = [];
      const expect = new Map();
      const sentenceOf = new Map();
      for (const r of rows) {
        if (r.idx == null) {
          warnings.push(`${ch.clip}: ${r.id || "a scene placed by hand"} has lost its sentence, so it is not exported.`);
          continue;
        }
        let id = r.id || `${slug}-${String(r.cue.id || "").replace(/^anim_/, "") || scenes.length + 1}`;
        while (usedIds.has(id)) id += "-2";
        usedIds.add(id);
        const st = r.cue.storyboard || {};
        const sc = { id, anchor: foldAnchor(st.anchor || "") ? st.anchor : r.sentence };
        const name = r.status === "picture" && typeof pictureName === "function" ? pictureName(r.cue, id) : null;
        if (name) {
          sc.image = name;
          pictures.push({ cue: r.cue, name });
        } else if (st.image) {
          sc.image = st.image; // the picture it is still waiting for
        }
        if (r.fx) sc.fx = r.fx;
        if (st.shot) sc.shot = st.shot;
        if (st.art) sc.art = st.art;
        if (st.key) sc.key = true;
        scenes.push(sc);
        expect.set(id, r.idx);
        sentenceOf.set(id, r.sentence);
      }
      if (!scenes.length) continue;
      // Proof: place the exported scenes back on this chapter as it stands.
      // A stored anchor that lands elsewhere gives way to its sentence, and
      // the chapter is placed once more to judge the result.
      const prove = () => placeChapter({ sentences: ch.sentences, lineIds: ch.lineIds, scenes, cues: [] });
      let back = prove();
      let swapped = false;
      for (const row of back.rows) {
        const sc = scenes.find((s) => s.id === row.id);
        if ((row.status !== "placed" || row.idx !== expect.get(row.id)) && sc.anchor !== sentenceOf.get(row.id)) {
          sc.anchor = sentenceOf.get(row.id);
          swapped = true;
        }
      }
      if (swapped) back = prove();
      for (const row of back.rows) {
        if (row.status === "no-art") continue;
        const want = expect.get(row.id);
        if (row.status !== "placed" || row.idx !== want) {
          warnings.push(`${ch.clip}: ${row.id} would import onto ${row.idx == null ? "no sentence" : "sentence " + (row.idx + 1)} instead of ${want + 1} (${row.status}).`);
        }
      }
      out.chapters.push({ clip: ch.clip, scenes });
    }
    return { file: out, pictures, warnings };
  }

  const api = { fold, foldAnchor, isStoryboard, parse, placeChapter, outlineChapter, exportBook };
  if (typeof window !== "undefined") window.NS_STORYBOARD = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
