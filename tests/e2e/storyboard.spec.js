// @ts-check
//
// Storyboard import (v4.253): Library ▸ Storyboard reads one JSON file plus
// its pictures and places each scene as a page cue on the sentence its
// anchor quotes. The matching rules are pure and tested in Node
// (tests/storyboard_import_test.js); this file drives the app half against
// a real library: the picker, the pictures in IndexedDB, the cues written,
// the report, re-import, and a picture with an effect drawn over it.

const { test, expect } = require("@playwright/test");

// Curly quotes, as a manuscript has them; the storyboard's anchors are typed
// straight. The importer must find them anyway.
const TEXT = [
  "The blue hour was the best of Keeper Bram’s day.",
  "He walked the rows of the Amber Nursery, and counted.",
  "“Sufficient,” he said.",
  "Not «well done». Sufficient.",
  "“I know what I am now,” Jaren said.",
  // No closing quote here: SENTENCE_SPLIT only breaks after [.!?] then
  // whitespace, so a line ending .” runs on into the next one.
  "I don’t know yet what to do with it, he thought.",
  "It moved the way sleep moves over a tired child, from the feet up, unhurried, kind.",
].join(" ");

const CLIP_TITLE = "01_Storyboard_Test";

function storyboard(scenes) {
  return {
    storyboard: 1,
    title: "Test book",
    chapters: [
      { clip: CLIP_TITLE, scenes },
      { clip: "99_Not_In_Library", scenes: [{ id: "lost", anchor: "anything", image: "a.png" }] },
    ],
  };
}

const SCENES = [
  { id: "s1", anchor: "The blue hour was the best of Keeper Bram's day", image: "a.png", fx: "embers" },
  // Skips the dialogue tag between the two quotes: not text in the chapter.
  { id: "s2", anchor: "I know what I am now. I don't know yet", image: "a.png" },
  { id: "s3", anchor: "counted", fx: "glow" },
  { id: "s4", anchor: "\"Sufficient,\" he said.", image: "missing.png" },
  { id: "s5", anchor: "Not «well done»", image: "broken.png" },
  // The hand-placed scene's sentence: kept, never replaced.
  { id: "s6", anchor: "what to do with it", image: "a.png" },
  // The same picture as s1: each scene must get its own stored copy.
  { id: "s7", anchor: "…from the feet up, unhurried, kind.", image: "a.png" },
];

async function wipeLibrary(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("audiable");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

// A real picture, drawn in the page: a 64x40 gradient as PNG bytes.
async function makePng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 40;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 64, 40);
    grad.addColorStop(0, "#2a1a4a");
    grad.addColorStop(1, "#d08a3a");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 40);
    return c.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

function files(json, png, extra = []) {
  return [
    { name: "book1-storyboard.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) },
    { name: "a.png", mimeType: "image/png", buffer: png },
    { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("this is not a picture") },
    ...extra,
  ];
}

async function cuesOf(page, id) {
  return page.evaluate(async (cid) => {
    const c = await getClip(cid);
    return (c && c.animationCues) || [];
  }, id);
}

const bySb = (cues, sid) => cues.find((c) => c.storyboard && c.storyboard.id === sid);

test.describe("storyboard import", () => {
  let clipId;

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await wipeLibrary(page);
    await page.reload();
    await page.waitForFunction(() => typeof window.NS_STORYBOARD === "object" && typeof saveClip === "function");
    clipId = await page.evaluate(async ({ text, title }) => {
      const sentences = splitSentencesClient(text);
      const handIdx = sentences.findIndex((s) => s.includes("what to do with it"));
      const id = Date.now();
      await saveClip({
        id,
        kind: "ebook",
        title,
        note: "",
        text,
        sentenceOffsetsSec: [],
        bookmarks: [],
        images: [],
        annotations: [],
        highlights: [],
        // A scene the author placed by hand, with the 🎬 palette.
        animationCues: [{ id: "anim_hand", kind: "page", effect: "rain", fx: "rain", startIdx: handIdx, endIdx: handIdx }],
        createdAt: new Date().toISOString(),
      });
      await renderLibrary();
      return id;
    }, { text: TEXT, title: CLIP_TITLE });
  });

  test("places each scene, reports every one, and re-imports in place", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    const png = await makePng(page);
    await expect(page.locator("#library-storyboard")).toBeVisible();
    await page.locator("#library-storyboard-file").setInputFiles(
      files(storyboard(SCENES), png, [{ name: "extra.png", mimeType: "image/png", buffer: png }])
    );

    const report = page.locator("#storyboard-report");
    await expect(report).toBeVisible();
    await expect(page.locator("#storyboard-report-summary")).toHaveText(/3 of 8 scenes placed/);
    const body = page.locator("#storyboard-report-body");
    await expect(body).toContainText("s1: Placed (sentence 1)");
    await expect(body).toContainText("s2: Line not found in the chapter");
    await expect(body).toContainText("s3: Placed");
    await expect(body).toContainText("s4: Picture not picked. missing.png");
    await expect(body).toContainText("s5: Picture couldn't be read. broken.png");
    await expect(body).toContainText("s6: Sentence already has a scene; kept that one");
    await expect(body).toContainText("s7: Placed");
    await expect(body).toContainText("lost: Chapter not placed");
    await expect(body).toContainText("Not in your library");
    // This clip has no per-sentence lines: the author is told what that costs.
    await expect(body).toContainText("Store this clip by sentence");
    await expect(body).toContainText("extra.png");
    await page.screenshot({ path: "test-results/storyboard-report.png" });

    let cues = await cuesOf(page, clipId);
    expect(cues.length).toBe(4); // the hand scene + s1, s3, s7
    expect(cues.find((c) => c.id === "anim_hand")).toBeTruthy();
    const s1 = bySb(cues, "s1");
    const s3 = bySb(cues, "s3");
    const s7 = bySb(cues, "s7");
    expect(s1).toMatchObject({ kind: "page", fx: "embers", source: "image", startIdx: 0 });
    expect(s1.sheetId).toBeTruthy();
    expect(s3).toMatchObject({ kind: "page", fx: "glow", effect: "glow" });
    expect(s3.sheetId).toBeFalsy();
    expect(s7.sheetId).toBeTruthy();
    expect(s7.sheetId).not.toBe(s1.sheetId);
    expect(bySb(cues, "s4")).toBeFalsy();
    expect(bySb(cues, "s5")).toBeFalsy();

    // Each scene's sentence, as the reading view numbers it, holds its anchor.
    await page.locator("#storyboard-report-close").click();
    await page.evaluate((id) => loadClip(id), clipId);
    await page.waitForFunction(() => Array.isArray(sentenceSpans) && sentenceSpans.length > 0);
    const spans = await page.evaluate(
      (idxs) => idxs.map((i) => sentenceSpans[i] && sentenceSpans[i].textContent),
      [s1.startIdx, s3.startIdx, s7.startIdx]
    );
    expect(spans[0]).toContain("Keeper Bram");
    expect(spans[1]).toContain("counted");
    expect(spans[2]).toContain("from the feet up, unhurried, kind.");

    // The picture with its effect drawn over it.
    const shown = await page.evaluate(async (cue) => {
      _animInit(); // what each playback tick does first
      _animReconcilePage(cue, false);
      for (let i = 0; i < 50 && !_animPageBgEl.style.backgroundImage; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        bg: _animPageBgEl.style.backgroundImage,
        fx: _animPageFxEl.dataset.fx || null,
        fxShown: _animPageFxEl.style.display !== "none",
        lighterScrim: _animPageLayerEl.classList.contains("anim-page-layer--fx"),
      };
    }, s1);
    expect(shown.bg).toMatch(/^url\(/);
    expect(shown.fx).toBe("embers");
    expect(shown.fxShown).toBe(true);
    expect(shown.lighterScrim).toBe(false);
    await page.screenshot({ path: "test-results/storyboard-fx-over-picture.png" });

    // An effect alone still draws as before.
    const fxOnly = await page.evaluate((cue) => {
      _animReconcilePage(cue, false);
      return { bg: _animPageBgEl.style.backgroundImage, fx: _animPageFxEl.dataset.fx || null };
    }, s3);
    expect(fxOnly).toEqual({ bg: "", fx: "glow" });

    // Re-import the same file: its scenes are replaced, not doubled, and the
    // pictures of the scenes it replaced are deleted.
    await page.locator("#library-storyboard-file").setInputFiles(files(storyboard(SCENES), png));
    await expect(page.locator("#storyboard-report-summary")).toHaveText(/3 of 8 scenes placed/);
    await page.locator("#storyboard-report-close").click();
    cues = await cuesOf(page, clipId);
    expect(cues.length).toBe(4);
    const s1b = bySb(cues, "s1");
    expect(s1b.sheetId).not.toBe(s1.sheetId);
    const sheets = await page.evaluate(
      async (ids) => Promise.all(ids.map(async (i) => !!(await getAnimSheet(i)))),
      [s1.sheetId, s7.sheetId, s1b.sheetId, bySb(cues, "s7").sheetId]
    );
    expect(sheets).toEqual([false, false, true, true]);

    // Removing one of two scenes that share a picture leaves the other's.
    await page.evaluate(({ id, idx }) => _removeAnimationCue(id, idx), { id: clipId, idx: bySb(cues, "s7").startIdx });
    expect(await page.evaluate((i) => getAnimSheet(i).then((b) => !!b), s1b.sheetId)).toBe(true);

    expect(errors).toEqual([]);
  });

  test("a scene dropped from the file is kept and offered for removal", async ({ page }) => {
    const png = await makePng(page);
    await page.locator("#library-storyboard-file").setInputFiles(files(storyboard(SCENES), png));
    await expect(page.locator("#storyboard-report-summary")).toHaveText(/3 of 8 scenes placed/);
    await page.locator("#storyboard-report-close").click();

    const fewer = SCENES.filter((s) => s.id !== "s7");
    await page.locator("#library-storyboard-file").setInputFiles(files(storyboard(fewer), png));
    const body = page.locator("#storyboard-report-body");
    await expect(body).toContainText("no longer in this file, so kept: s7");
    let cues = await cuesOf(page, clipId);
    const orphanSheet = bySb(cues, "s7").sheetId;
    expect(bySb(cues, "s7")).toBeTruthy();

    await body.getByRole("button", { name: "Remove these" }).click();
    await expect(body).not.toContainText("no longer in this file");
    cues = await cuesOf(page, clipId);
    expect(bySb(cues, "s7")).toBeFalsy();
    expect(cues.length).toBe(3);
    await expect.poll(() => page.evaluate((i) => getAnimSheet(i).then((b) => !!b), orphanSheet)).toBe(false);
  });

  test("a file that isn't a storyboard says so", async ({ page }) => {
    await page.locator("#library-storyboard-file").setInputFiles([
      { name: "notes.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ chapters: [] })) },
    ]);
    await expect(page.locator("#storyboard-report")).toBeVisible();
    await expect(page.locator("#storyboard-report-body")).toContainText("storyboard");
    expect(await cuesOf(page, clipId)).toHaveLength(1);
  });

  test("the Storyboard button is a desktop tool", async ({ page }) => {
    await expect(page.locator("#library-storyboard")).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator("#library-storyboard")).toBeHidden();
  });
});
