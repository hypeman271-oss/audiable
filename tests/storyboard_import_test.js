// Storyboard import: the matching rules (static/storyboard-import.js).
//
// Run: node tests/storyboard_import_test.js
//
// Exits 0 when every case passes, 1 on any failure. Pure Node: the module
// has no DOM or IndexedDB half, so this needs no server. The app half
// (pictures, writing cues, the report) is covered in the browser.

const path = require("path");
const sb = require(path.join(__dirname, "..", "static", "storyboard-import.js"));

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail) : ""));
  }
}

const FX = new Set(["rain", "snow", "embers", "fog", "dust", "glow"]);

// The chapter as the reading view splits it. Curly quotes, as the
// manuscript has them; the storyboard's anchors are typed straight.
const SENTENCES = [
  "The blue hour was the best of Keeper Bram’s day.",
  "He walked the rows of the Amber Nursery, and counted.",
  "“Sufficient,” he said.",
  "Not «well done». Sufficient.",
  "“I know what I am now,” Jaren said.",
  "“I don’t know yet what to do with it.”",
  "It moved the way sleep moves over a tired child, from the feet up, unhurried, kind.",
];
const scene = (id, anchor, extra) => Object.assign({ id, anchor, image: id + ".webp", fx: null }, extra || {});
const place = (scenes, cues, lineIds, fileIds) =>
  sb.placeChapter({ sentences: SENTENCES, lineIds: lineIds || null, scenes, cues: cues || [], fileIds });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

console.log("fold");
check("curly quotes match straight", sb.fold("Bram’s “day”") === "Bram's \"day\"");
check("ellipsis character is three dots", sb.fold("kind…") === "kind...");
check("whitespace collapses", sb.fold("  a \n\t b  ") === "a b");
check("guillemets are kept", sb.fold("«Hold your note.»") === "«Hold your note.»");
check("an anchor's ellipses are trimmed", sb.foldAnchor("…from the feet up, unhurried, kind.") === "from the feet up, unhurried, kind.");

console.log("parse");
{
  const bad = sb.parse({ chapters: [] }, { fx: FX });
  check("a file without storyboard:1 is refused", !bad.ok && bad.errors.length === 1);
  const p = sb.parse({
    storyboard: 1,
    chapters: [
      { clip: "01_The_Cull", scenes: [
        { id: "a", anchor: "The blue hour", image: "a.webp" },
        { id: "a", anchor: "again", image: "x.webp" },
        { id: "b", anchor: "   ", image: "b.webp" },
        { id: "c", anchor: "counted", fx: "lightning" },
        { id: "d", anchor: "counted", fx: "glow" },
      ] },
      { clip: "01_The_Cull", scenes: [] },
    ],
  }, { fx: FX });
  check("a valid file parses", p.ok);
  check("a duplicate id is an error, not a second scene", p.errors.some((e) => e.includes('"a" is used twice')));
  check("an empty anchor is an error", p.errors.some((e) => e.includes("(b) has no \"anchor\"")));
  check("an unknown effect is named and dropped", p.errors.some((e) => e.includes('"lightning"')) && p.chapters[0].scenes.find((s) => s.id === "c").fx === null);
  check("a known effect is kept", p.chapters[0].scenes.find((s) => s.id === "d").fx === "glow");
  check("a chapter listed twice is an error", p.errors.some((e) => e.includes("listed twice")) && p.chapters.length === 1);
}

console.log("placeChapter: finding the sentence");
{
  const r = byId(place([
    scene("s1", "The blue hour was the best of Keeper Bram's day"),
    scene("s2", "…from the feet up, unhurried, kind."),
  ]).rows);
  check("a straight-quoted anchor finds a curly sentence", r.s1.status === "placed" && r.s1.idx === 0, r.s1);
  check("a mid-sentence excerpt lands on its sentence", r.s2.status === "placed" && r.s2.idx === 6, r.s2);
}
{
  // The two anchors the Book 1 dry run caught: a quote that skips a
  // dialogue tag is not text in the chapter, and must say so.
  const r = byId(place([scene("j", "I know what I am now. I don't know yet what to do with it.")]).rows);
  check("an anchor that skips a dialogue tag is not-found", r.j.status === "not-found", r.j);
}
{
  // "Sufficient" appears in two sentences; searching forward from the
  // previous scene's line picks the one after it, not the first.
  const r = byId(place([
    scene("a", "\"Sufficient,\" he said."),
    scene("b", "Sufficient"),
  ]).rows);
  check("a repeated word resolves forward from the previous scene", r.a.idx === 2 && r.b.idx === 3, [r.a, r.b]);
}
{
  const r = byId(place([
    scene("late", "Jaren said"),
    scene("early", "Keeper Bram"),
  ]).rows);
  check("a scene whose line comes before the previous one is out-of-order", r.early.status === "out-of-order" && r.late.status === "placed", r);
}
{
  const r = byId(place([
    scene("one", "The blue hour"),
    scene("two", "best of Keeper"),
  ]).rows);
  check("two scenes on one sentence: the second is reported", r.one.status === "placed" && r.two.status === "same-sentence", r);
}
{
  // v4.255: a scene with nothing to show yet is placed, as a placeholder
  // that holds its brief, so the editor and Export carry every scene.
  const r = byId(place([scene("bare", "The blue hour", { image: null, fx: null })]).rows);
  check("a scene with neither picture nor effect is placed (a placeholder)", r.bare.status === "placed" && r.bare.idx === 0, r.bare);
  // …but never in place of art: an earlier import's scene for it that has
  // a picture or an effect stays.
  const hasSheet = (c) => !!c.sheetId;
  const earlier = [{ id: "anim_e", kind: "page", startIdx: 3, sheetId: "pic", storyboard: { id: "bare", anchor: "x" } }];
  const k = place([scene("bare", "The blue hour", { image: null, fx: null })], earlier);
  check("an earlier scene with a picture stays, where it was", byId(k.rows).bare.status === "no-art" && k.keep.includes(earlier[0]), k);
  const fxEarlier = [{ id: "anim_f", kind: "page", startIdx: 3, fx: "glow", storyboard: { id: "bare", anchor: "x" } }];
  const kf = sb.placeChapter({ sentences: SENTENCES, scenes: [scene("bare", "The blue hour", { image: null, fx: null })], cues: fxEarlier, hasSheet });
  check("an earlier scene with an effect stays", byId(kf.rows).bare.status === "no-art" && kf.keep.includes(fxEarlier[0]), kf.rows);
  // A picture not picked never replaces one already stored, even when the
  // file gives the scene an effect too; over an effect alone, it places.
  const pic = [{ id: "anim_p", kind: "page", startIdx: 3, sheetId: "pic", storyboard: { id: "bare", anchor: "x" } }];
  const kp = sb.placeChapter({ sentences: SENTENCES, scenes: [scene("bare", "The blue hour", { image: null, fx: "glow", pictureMissing: true })], cues: pic, hasSheet });
  check("a missing picture keeps the stored one", byId(kp.rows).bare.status === "no-art" && kp.keep.includes(pic[0]), kp.rows);
  const kq = sb.placeChapter({ sentences: SENTENCES, scenes: [scene("bare", "The blue hour", { image: null, fx: "glow", pictureMissing: true })], cues: fxEarlier, hasSheet });
  check("a missing picture over an effect alone places", byId(kq.rows).bare.status === "placed", kq.rows);
  // An earlier placeholder is replaced: the file's brief and anchor win.
  const blank = [{ id: "anim_g", kind: "page", startIdx: 3, storyboard: { id: "bare", anchor: "x" } }];
  const kb = sb.placeChapter({ sentences: SENTENCES, scenes: [scene("bare", "The blue hour", { image: null, fx: null })], cues: blank, hasSheet });
  check("an earlier placeholder is placed again", byId(kb.rows).bare.status === "placed" && !kb.keep.includes(blank[0]), kb);
}
{
  const r = byId(place([scene("fx", "The blue hour", { image: null, fx: "glow" })]).rows);
  check("an effect alone is placed (a placeholder)", r.fx.status === "placed", r.fx);
}
{
  const lineIds = SENTENCES.map((_, i) => "L" + i);
  const r = byId(place([scene("s", "counted.")], [], lineIds).rows);
  check("the line id is carried when lines match sentences", r.s.lineId === "L1", r.s);
  const r2 = byId(place([scene("s", "counted.")], [], ["only-one"]).rows);
  check("no line id when lines and sentences disagree (the reading view's rule)", r2.s.lineId === null, r2.s);
}

console.log("placeChapter: what is already there");
{
  const hand = { id: "h", kind: "page", startIdx: 1 };
  const out = place([scene("s", "counted.")], [hand]);
  const r = byId(out.rows);
  check("a hand-placed scene on the sentence is kept, not replaced", r.s.status === "kept-yours" && out.keep.includes(hand), r.s);
}
{
  const old = { id: "old", kind: "page", startIdx: 0, storyboard: { id: "s" } };
  const out = place([scene("s", "counted.")], [old]);
  const r = byId(out.rows);
  check("re-import replaces its own scene, even when it moved", r.s.status === "placed" && r.s.idx === 1 && !out.keep.includes(old), out);
}
{
  const old = { id: "old", kind: "page", startIdx: 4, storyboard: { id: "s" } };
  const out = place([scene("s", "a line that was revised away")], [old]);
  const r = byId(out.rows);
  check("a re-imported scene that no longer matches keeps its earlier placement", r.s.status === "not-found" && r.s.previous === "kept" && out.keep.includes(old), out);
}
{
  const gone = { id: "gone", kind: "page", startIdx: 5, storyboard: { id: "deleted-row" } };
  const out = place([scene("s", "counted.")], [gone]);
  check("a scene whose row left the file is kept and listed as an orphan", out.keep.includes(gone) && out.orphans.includes(gone), out);
}
{
  // A scene may move to another chapter between versions of the file:
  // fileIds holds every id in the file, so the old chapter drops it.
  const moved = { id: "m", kind: "page", startIdx: 0, storyboard: { id: "moved" } };
  const out = place([], [moved], null, new Set(["moved"]));
  check("a scene that moved chapters is dropped from the old chapter", !out.keep.includes(moved) && out.orphans.length === 0, out);
}
{
  const lineIds = SENTENCES.map((_, i) => "L" + i);
  // The hand-placed cue was stored at index 1, then a sentence was added
  // above it: its line id now says index 2. The line id wins, as in
  // _animResolveRange.
  const hand = { id: "h", kind: "page", startIdx: 1, startLineId: "L2" };
  const r = byId(place([scene("s", "counted.")], [hand], lineIds).rows);
  check("an existing cue is found by its line id before its index", r.s.status === "placed", r.s);
}

console.log("parse: the brief (v4.255)");
{
  const p = sb.parse({ storyboard: 1, chapters: [{ clip: "c", scenes: [
    { id: "a", anchor: "x", fx: "glow", shot: "Wide. The nursery.", art: "New", key: true },
    { id: "b", anchor: "y", fx: "glow", key: "yes" },
  ] }] }, { fx: FX });
  const [a, b] = p.chapters[0].scenes;
  check("shot, art and key are kept", a.shot === "Wide. The nursery." && a.art === "New" && a.key === true, a);
  check("key is only ever true, never a string", b.key === undefined, b);
}

console.log("outlineChapter (v4.255)");
const hasSheet = (c) => !!c.sheetId;
{
  const cues = [
    { id: "late", kind: "page", startIdx: 5, fx: "glow" },
    { id: "pic", kind: "page", startIdx: 1, sheetId: "s1", storyboard: { id: "ch-s1", anchor: "counted." } },
    { id: "blank", kind: "page", startIdx: 3 },
    { id: "gone", kind: "page", startIdx: 40 },
    { id: "badge", kind: "badge", startIdx: 2 },
  ];
  const rows = sb.outlineChapter({ sentences: SENTENCES, lineIds: null, cues, hasSheet });
  check("only page cues, in reading order, lost ones last", rows.map((r) => r.cue.id).join() === "pic,blank,late,gone", rows.map((r) => r.cue.id));
  check("status says picture / empty / fx / lost", rows.map((r) => r.status).join() === "picture,empty,fx,lost", rows.map((r) => r.status));
  check("a scene holds until the next one", rows[0].until === 2 && rows[1].until === 4 && rows[2].until === SENTENCES.length - 1, rows.map((r) => r.until));
  check("a stamped scene keeps its id and anchor", rows[0].id === "ch-s1" && rows[0].anchor === "counted." && !rows[0].hand);
  check("a hand-placed scene's anchor is its sentence", rows[1].hand && rows[1].anchor === SENTENCES[3]);
  const byLine = sb.outlineChapter({ sentences: SENTENCES, lineIds: SENTENCES.map((_, i) => "L" + i),
    cues: [{ id: "m", kind: "page", startIdx: 0, startLineId: "L4", fx: "rain" }], hasSheet });
  check("the line id places it before the index", byLine[0].idx === 4, byLine[0]);
}

console.log("exportBook (v4.255)");
{
  const cues = [
    // Stamped, and its anchor still reads in its sentence.
    { id: "anim_a", kind: "page", startIdx: 0, sheetId: "s1", fx: "embers",
      storyboard: { id: "ch01-s1", anchor: "The blue hour was the best", shot: "Wide.", art: "New", key: true } },
    // Stamped, but moved in the editor to sentence 6: its old anchor no
    // longer reads there, so the sentence itself becomes the anchor.
    { id: "anim_b", kind: "page", startIdx: 6, fx: "glow", storyboard: { id: "ch01-s2", anchor: "counted." } },
    // Placed by hand with the palette.
    { id: "anim_c", kind: "page", startIdx: 4, sheetId: "s2" },
    // No picture and no effect yet.
    { id: "anim_d", kind: "page", startIdx: 5, storyboard: { id: "ch01-s9", anchor: "x", shot: "Later." } },
  ];
  const { file, pictures, warnings } = sb.exportBook({
    title: "Book 1",
    chapters: [{ clip: "01_The_Cull", sentences: SENTENCES, lineIds: null, cues }],
    hasSheet,
    pictureName: (c, id) => id + ".webp",
  });
  const sc = Object.fromEntries(file.chapters[0].scenes.map((s) => [s.id, s]));
  check("the file is a storyboard the import reads", sb.parse(file, { fx: FX }).ok && file.title === "Book 1");
  check("a stamped scene keeps its id, anchor, brief and picture", sc["ch01-s1"].anchor === "The blue hour was the best" &&
    sc["ch01-s1"].shot === "Wide." && sc["ch01-s1"].art === "New" && sc["ch01-s1"].key === true && sc["ch01-s1"].image === "ch01-s1.webp" && sc["ch01-s1"].fx === "embers", sc["ch01-s1"]);
  check("a moved scene is anchored on its new sentence", sc["ch01-s2"].anchor === SENTENCES[6], sc["ch01-s2"]);
  // An author's anchor that runs on into the next sentence still places
  // its scene, so it is kept word for word (Book 1 has 13 of these).
  {
    const run = { id: "anim_r", kind: "page", startIdx: 1, fx: "glow", storyboard: { id: "r", anchor: "and counted. “Sufficient,” he said." } };
    const out = sb.exportBook({ chapters: [{ clip: "x", sentences: SENTENCES, lineIds: null, cues: [run] }], hasSheet });
    check("an anchor spanning two sentences is kept", out.file.chapters[0].scenes[0].anchor === run.storyboard.anchor && !out.warnings.length, out);
  }
  const hand = file.chapters[0].scenes.find((s) => s.id.startsWith("01-the-cull-"));
  check("a hand-placed scene gets an id and its sentence", !!hand && hand.anchor === SENTENCES[4] && hand.image === hand.id + ".webp", hand);
  check("each picture is listed once with its scene's name", pictures.length === 2 && pictures.every((p) => p.name.endsWith(".webp")), pictures.map((p) => p.name));
  check("a scene with nothing yet is exported with its brief, no warning (it imports as a placeholder)",
    !!sc["ch01-s9"] && sc["ch01-s9"].shot === "Later." && !sc["ch01-s9"].image && !sc["ch01-s9"].fx && !warnings.some((w) => w.includes("ch01-s9")), warnings);
  // The round trip: import the export into an empty copy of the chapter.
  const parsed = sb.parse(file, { fx: FX });
  const back = sb.placeChapter({ sentences: SENTENCES, lineIds: null, scenes: parsed.chapters[0].scenes, cues: [] });
  const at = Object.fromEntries(back.rows.map((r) => [r.id, r.idx]));
  check("every exported scene places back on its own sentence", at["ch01-s1"] === 0 && at["ch01-s2"] === 6 && at[hand.id] === 4 && at["ch01-s9"] === 5, back.rows);
  check("a clean export has no warnings", warnings.length === 0, warnings);
}
{
  // A scene on the SECOND "Sufficient." line, moved there in the editor:
  // as a bare sentence it would import onto the first one. Said, not hidden.
  const sents = ["Sufficient.", "He nodded.", "Sufficient."];
  const { warnings } = sb.exportBook({
    chapters: [{ clip: "13", sentences: sents, lineIds: null, cues: [{ id: "anim_x", kind: "page", startIdx: 2, fx: "glow" }] }],
    hasSheet,
  });
  check("an anchor that would land elsewhere is named", warnings.some((w) => w.includes("instead of 3")), warnings);
}
{
  // v4.255: a placeholder still waiting for its painting keeps the file
  // name the storyboard gave it, so the export names it again (and writes
  // no picture for it), and an import with the painting attaches it.
  const cue = { id: "anim_w", kind: "page", startIdx: 0, storyboard: { id: "ch02-s1", anchor: "The blue hour", image: "ch02-s1.webp", shot: "A husk." } };
  const { file, pictures } = sb.exportBook({
    chapters: [{ clip: "02", sentences: SENTENCES, lineIds: null, cues: [cue] }],
    hasSheet,
    pictureName: (c, id) => (hasSheet(c) ? id + ".webp" : null),
  });
  const s = file.chapters[0].scenes[0];
  check("a waiting placeholder exports the picture it waits for", s.image === "ch02-s1.webp" && pictures.length === 0, { s, pictures });
  const back = place([sb.parse(file, { fx: FX }).chapters[0].scenes[0]], [cue], null, new Set(["ch02-s1"]));
  check("…and an import with that picture replaces the placeholder", byId(back.rows)["ch02-s1"].status === "placed" && !back.keep.includes(cue), back);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
