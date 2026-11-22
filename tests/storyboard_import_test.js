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
  const r = byId(place([scene("bare", "The blue hour", { image: null, fx: null })]).rows);
  check("a scene with neither picture nor effect is reported", r.bare.status === "no-art", r.bare);
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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
