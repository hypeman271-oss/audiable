// @ts-check
//
// v4.255: the storyboard editor (Library ▸ Storyboard), laid out like the
// game's Workshop editors: an Outliner of chapters and their scenes, the
// REAL reading card as the viewport (Lyrith's own Book view and reading
// view, lifted into the editor and put back on close, never copied), a
// transport, a lane of the chapter's sentences, and Details in categories.
// Lyrith's chapters are the master copy: every edit is written to the
// chapter at once, and Export writes the book back out as a storyboard.

const { test, expect } = require("@playwright/test");

const A_TEXT = [
  "The blue hour was the best of Keeper Bram’s day.",
  "He walked the rows of the Amber Nursery, and counted.",
  "Two hundred husks hung in the root vault.",
  "Each one held a light.",
  "At the ninth husk of the third row the note came up uneven.",
  "He waited, and it did not settle.",
  "He turned the silver key.",
  "The light went out from the feet up, unhurried, kind.",
].join(" ");
const B_TEXT = "Ava didn't wake. The heat inside her simply reached its flashpoint. She went anyway.";

async function wipe(page) {
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase("audiable"); q.onsuccess = q.onerror = q.onblocked = r; }));
}

// Two chapters. A has three scenes: a stamped picture with embers, an
// effect alone, and a picture placed by hand. B has none.
async function seed(page) {
  return page.evaluate(async ({ a, b }) => {
    const pic = async (color) => {
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 20;
      const g = c.getContext("2d");
      g.fillStyle = color;
      g.fillRect(0, 0, 32, 20);
      return new Promise((r) => c.toBlob(r, "image/png"));
    };
    await putAnimSheet("sheet_a1", await pic("#7a4a20"));
    await putAnimSheet("sheet_a3", await pic("#204a7a"));
    const base = { kind: "ebook", note: "", sentenceOffsetsSec: [], bookmarks: [], images: [], annotations: [], highlights: [], createdAt: new Date().toISOString() };
    const idA = Date.now();
    const idB = idA + 1;
    await saveClip(Object.assign({}, base, {
      id: idA, title: "01_Test_Chapter", text: a,
      animationCues: [
        { id: "anim_a1", kind: "page", effect: "page", startIdx: 0, endIdx: 0, sheetId: "sheet_a1", source: "image", frames: 1, fps: 8, fx: "embers",
          storyboard: { id: "ch01-s1", anchor: "The blue hour was the best", shot: "Wide. The nursery at blue hour.", art: "New", key: true } },
        { id: "anim_a2", kind: "page", effect: "glow", fx: "glow", startIdx: 3, endIdx: 3, storyboard: { id: "ch01-s2", anchor: "Each one held a light." } },
        { id: "anim_a3", kind: "page", effect: "page", startIdx: 6, endIdx: 6, sheetId: "sheet_a3", source: "image", frames: 1, fps: 8 },
      ],
    }));
    await saveClip(Object.assign({}, base, { id: idB, title: "02_Other_Chapter", text: b, animationCues: [] }));
    await renderLibrary();
    return { idA, idB };
  }, { a: A_TEXT, b: B_TEXT });
}

async function cues(page, id) {
  return page.evaluate(async (cid) => ((await getClip(cid)) || {}).animationCues || [], id);
}
const sheetExists = (page, sid) => page.evaluate((s) => getAnimSheet(s).then((x) => !!x), sid);
const status = (page) => page.locator("#sb-status");

test.describe("storyboard editor", () => {
  let ids;
  const errors = [];

  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await wipe(page);
    await page.reload();
    await page.waitForFunction(() => typeof saveClip === "function" && window.NS_STORYBOARD);
    ids = await seed(page);
    // Colours and the Ken-Burns drift read mid-animation otherwise.
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test("opens with the chapters, and the real reading card is its viewport", async ({ page }) => {
    const card = page.locator("section.card-text");
    const before = await card.evaluate((el) => el.parentElement && el.parentElement.className);

    await page.locator("#library-storyboard").click();
    const ed = page.locator("#sb-editor");
    await expect(ed).toBeVisible();
    // The card is moved, not copied: one card, inside the viewport.
    await expect(page.locator("section.card-text")).toHaveCount(1);
    await expect(page.locator("#sb-viewport section.card-text")).toHaveCount(1);

    const rows = page.locator("#sb-rows .sb-row[data-cue]");
    await expect(rows).toHaveCount(3);
    await expect(page.locator("#sb-rows .sb-chapter")).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("ch01-s1");
    await expect(rows.nth(0)).toContainText("★");
    await expect(rows.nth(1)).toContainText("ch01-s2");
    await expect(rows.nth(2)).toContainText("by hand");
    await expect(page.locator("#sb-count")).toContainText("3 scenes");

    // A chapter with no scenes yet is one tick away.
    await page.locator("#sb-all-chapters").check();
    await expect(page.locator("#sb-rows .sb-chapter")).toHaveCount(2);
    await expect(page.locator("#sb-rows")).toContainText("02_Other_Chapter");
    await page.locator("#sb-all-chapters").uncheck();

    // Search narrows the rows.
    await page.locator("#sb-search").fill("blue hour");
    await expect(rows).toHaveCount(1);
    await page.locator("#sb-search").fill("");

    // Picking a scene shows it on the real Book view page.
    await rows.nth(0).click();
    await expect(page.locator("#sb-viewport #book-view")).toBeVisible();
    // A Book view page shows the scene in force at its LAST sentence (what a
    // reader sees): this short chapter is one page, so that is the hand-placed
    // picture on sentence 7. The reading view shows the picked scene itself.
    const art = page.locator("#sb-viewport .book-view-page.book-page--art");
    await expect(art.first()).toBeVisible();
    await expect(page.locator("#sb-details")).toContainText("The blue hour was the best of Keeper Bram’s day.");
    await expect(page.locator("#sb-shot")).toHaveValue("Wide. The nursery at blue hour.");
    await page.screenshot({ path: "test-results/sb-editor-book.png" });

    // The reading view, same scene.
    await page.locator("#sb-view-reading").click();
    await expect(page.locator("#sb-viewport #reading-view")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/anim-page-art/);
    await expect(page.locator("#sb-viewport .anim-page-fx")).toHaveAttribute("data-fx", "embers");
    await page.screenshot({ path: "test-results/sb-editor-reading.png" });

    // Phone width narrows the viewport to a phone's page.
    await page.locator("#sb-view-phone").click();
    const w = await page.locator("#sb-viewport").evaluate((el) => el.firstElementChild.getBoundingClientRect().width);
    expect(w).toBeLessThanOrEqual(420);

    // Next / previous step through the scenes in reading order.
    await page.locator("#sb-next").click();
    await expect(rows.nth(1)).toHaveClass(/is-picked/);
    await page.locator("#sb-prev").click();
    await expect(rows.nth(0)).toHaveClass(/is-picked/);

    // No narration: Play says why instead of doing nothing.
    await expect(page.locator("#sb-play")).toBeDisabled();
    await expect(page.locator("#sb-play")).toHaveAttribute("title", /no narration/i);

    await page.locator("#sb-close").click();
    await expect(ed).toBeHidden();
    await expect(page.locator("#sb-viewport section.card-text")).toHaveCount(0);
    expect(await card.evaluate((el) => el.parentElement && el.parentElement.className)).toBe(before);
  });

  test("a scene deep in a long chapter stays in view at every width", async ({ page }) => {
    // 160 sentences: many pages, so the page shown is the scene's or wrong.
    const id = await page.evaluate(async () => {
      const text = Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of the long chapter is here.`).join(" ");
      const cid = Date.now() + 9;
      await saveClip({ id: cid, kind: "ebook", title: "03_Long_Chapter", text, note: "", sentenceOffsetsSec: [], bookmarks: [], images: [], annotations: [], highlights: [], createdAt: new Date().toISOString(),
        animationCues: [{ id: "anim_long", kind: "page", effect: "glow", fx: "glow", startIdx: 120, endIdx: 120, storyboard: { id: "ch03-s1", anchor: "Line 121 of the long chapter" } }] });
      return cid;
    });
    const visibleText = () => page.evaluate(() => {
      const r = document.getElementById("sb-viewport").getBoundingClientRect();
      return Array.from(document.querySelectorAll("#sb-viewport .book-view-page .sentence"))
        .filter((s) => { const b = s.getBoundingClientRect(); return b.width > 0 && b.left >= r.left - 1 && b.right <= r.right + 1; })
        .map((s) => s.textContent).join(" ");
    });
    await page.locator("#library-storyboard").click();
    await page.locator('#sb-rows .sb-row:has-text("ch03-s1")').click();
    await expect.poll(visibleText).toContain("Line 121 of the long chapter");
    for (const view of ["phone", "book"]) {
      await page.locator("#sb-view-" + view).click();
      // Book view re-lays out for the new width, on its ResizeObserver.
      await page.waitForTimeout(500);
      await expect.poll(visibleText, { message: view }).toContain("Line 121 of the long chapter");
    }
    // The window narrowing (still wide) re-lays it out too.
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.waitForTimeout(500);
    await expect.poll(visibleText).toContain("Line 121 of the long chapter");
    expect(id).toBeTruthy();
  });

  test("Details edit the scene and the viewport redraws it", async ({ page }) => {
    await page.locator("#library-storyboard").click();
    const rows = page.locator("#sb-rows .sb-row[data-cue]");
    await rows.nth(0).click();
    await page.locator("#sb-view-reading").click();
    const fx = page.locator("#sb-viewport .anim-page-fx");
    await expect(fx).toHaveAttribute("data-fx", "embers");

    // Effect.
    await page.locator("#sb-fx").selectOption("snow");
    await expect.poll(async () => (await cues(page, ids.idA)).find((c) => c.id === "anim_a1").fx).toBe("snow");
    await expect(fx).toHaveAttribute("data-fx", "snow");

    // Brief.
    await page.locator("#sb-shot").fill("Close. Bram's two fingers on the ninth husk.");
    await page.locator("#sb-shot").blur();
    await page.locator("#sb-key").uncheck();
    await expect.poll(async () => {
      const s = (await cues(page, ids.idA)).find((c) => c.id === "anim_a1").storyboard;
      return s.shot + "|" + !!s.key + "|" + s.id;
    }).toBe("Close. Bram's two fingers on the ninth husk.|false|ch01-s1");
    await expect(rows.nth(0)).not.toContainText("★");

    // Picture: replacing it stores the new one and deletes the old.
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 40;
      c.height = 24;
      const g = c.getContext("2d");
      g.fillStyle = "#3a7a30";
      g.fillRect(0, 0, 40, 24);
      return c.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#sb-picture-file").setInputFiles({ name: "new.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect.poll(async () => (await cues(page, ids.idA)).find((c) => c.id === "anim_a1").sheetId).not.toBe("sheet_a1");
    expect(await sheetExists(page, "sheet_a1")).toBe(false);
    const newSheet = (await cues(page, ids.idA)).find((c) => c.id === "anim_a1").sheetId;
    expect(await sheetExists(page, newSheet)).toBe(true);
    await expect(page.locator("#sb-details img.sb-thumb")).toBeVisible();

    // A picture that will not decode says so and changes nothing.
    await page.locator("#sb-picture-file").setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not a picture") });
    await expect(status(page)).toContainText("couldn't be read");
    expect((await cues(page, ids.idA)).find((c) => c.id === "anim_a1").sheetId).toBe(newSheet);

    // Clear the picture: an effect alone remains.
    await page.locator("#sb-picture-clear").click();
    await expect.poll(async () => (await cues(page, ids.idA)).find((c) => c.id === "anim_a1").sheetId || null).toBe(null);
    await expect.poll(() => sheetExists(page, newSheet)).toBe(false);
    await expect(rows.nth(0)).toContainText("snow");

    // Remove the hand-placed scene: its picture goes with it.
    await rows.nth(2).click();
    await page.locator("#sb-remove").click();
    await expect.poll(async () => (await cues(page, ids.idA)).some((c) => c.id === "anim_a3")).toBe(false);
    await expect.poll(() => sheetExists(page, "sheet_a3")).toBe(false);
    await expect(rows).toHaveCount(2);
  });

  test("the lane moves a scene, refuses a taken sentence, and adds one", async ({ page }) => {
    await page.locator("#library-storyboard").click();
    const rows = page.locator("#sb-rows .sb-row[data-cue]");
    await rows.nth(1).click(); // ch01-s2, on sentence 4
    const cells = page.locator("#sb-lane .sb-cell");
    await expect(cells).toHaveCount(8);
    const marker = page.locator('#sb-lane .sb-marker[data-cue="anim_a2"]');
    await expect(marker).toBeVisible();

    const drag = async (fromLoc, toIdx) => {
      const from = await fromLoc.boundingBox();
      const to = await cells.nth(toIdx).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
      await page.mouse.up();
    };

    // Onto a sentence another scene holds: refused, and said.
    await drag(marker, 6);
    await expect(status(page)).toContainText("already has a scene");
    expect((await cues(page, ids.idA)).find((c) => c.id === "anim_a2").startIdx).toBe(3);

    // Onto a free sentence: moved, and re-anchored on it.
    await drag(marker, 4);
    await expect.poll(async () => (await cues(page, ids.idA)).find((c) => c.id === "anim_a2").startIdx).toBe(4);
    const moved = (await cues(page, ids.idA)).find((c) => c.id === "anim_a2");
    expect(moved.storyboard.anchor).toBe("At the ninth husk of the third row the note came up uneven.");
    await expect(page.locator("#sb-details")).toContainText("Sentence 5");

    // Pick a free sentence on the lane, then add a scene there.
    await cells.nth(2).click();
    await expect(page.locator("#sb-add")).toBeEnabled();
    await expect(page.locator("#sb-add")).toContainText("sentence 3");
    await page.locator("#sb-add").click();
    await expect.poll(async () => (await cues(page, ids.idA)).filter((c) => c.startIdx === 2).length).toBe(1);
    await expect(rows).toHaveCount(4);
    await expect(page.locator("#sb-rows .sb-row.is-picked")).toContainText("Nothing yet");
    // A scene with nothing yet is the author's placeholder: readers (and the
    // viewport) still see the scene before it, the picture on sentence 1.
    await page.locator("#sb-view-reading").click();
    await expect(page.locator("body")).toHaveClass(/anim-page-art/);
    await page.locator("#sb-view-book").click();
    // A sentence that has a scene picks it rather than adding a second.
    await cells.nth(0).click();
    await expect(rows.nth(0)).toHaveClass(/is-picked/);
  });

  test("Export writes the book and its pictures, and it imports back the same", async ({ page }) => {
    // Folder access stood in by memory, so the test sees every file written.
    await page.evaluate(() => {
      window.__sbWritten = {};
      window.showDirectoryPicker = async () => ({
        name: "Book1",
        getFileHandle: async (name) => ({
          createWritable: async () => {
            const parts = [];
            return {
              write: async (d) => parts.push(d),
              close: async () => { window.__sbWritten[name] = new Blob(parts); },
            };
          },
        }),
      });
    });
    await page.locator("#library-storyboard").click();
    await page.locator("#sb-export").click();
    await expect(status(page)).toContainText("Exported 3 scenes");
    const written = await page.evaluate(async () => {
      const out = {};
      for (const [k, b] of Object.entries(window.__sbWritten)) out[k] = k.endsWith(".json") ? await b.text() : b.size;
      return out;
    });
    const jsonName = Object.keys(written).find((k) => k.endsWith(".json"));
    expect(jsonName).toBeTruthy();
    const file = JSON.parse(written[jsonName]);
    expect(file.storyboard).toBe(1);
    const scenes = file.chapters[0].scenes;
    expect(scenes.map((s) => s.id).slice(0, 2)).toEqual(["ch01-s1", "ch01-s2"]);
    expect(scenes[0]).toMatchObject({ image: "ch01-s1.png", fx: "embers", shot: "Wide. The nursery at blue hour.", art: "New", key: true });
    const pics = Object.keys(written).filter((k) => !k.endsWith(".json"));
    expect(pics.length).toBe(2);
    pics.forEach((p) => expect(written[p]).toBeGreaterThan(0));

    // Round trip: clear the chapter's scenes, import what was exported.
    await page.evaluate(async (id) => { await _mutateClipAtomic(id, (c) => { c.animationCues = []; }); }, ids.idA);
    const files = await page.evaluate(async () => {
      const out = [];
      for (const [k, b] of Object.entries(window.__sbWritten)) {
        const buf = new Uint8Array(await b.arrayBuffer());
        out.push({ name: k, data: Array.from(buf) });
      }
      return out;
    });
    await page.locator("#library-storyboard-file").setInputFiles(files.map((f) => ({
      name: f.name, mimeType: f.name.endsWith(".json") ? "application/json" : "image/png", buffer: Buffer.from(f.data),
    })));
    await expect(page.locator("#storyboard-report-summary")).toContainText("3 of 3 scenes placed");
    await page.locator("#storyboard-report-close").click();
    const after = await cues(page, ids.idA);
    expect(after.map((c) => c.startIdx).sort()).toEqual([0, 3, 6]);
    expect(after.find((c) => c.storyboard.id === "ch01-s1").storyboard).toMatchObject({ shot: "Wide. The nursery at blue hour.", art: "New", key: true });
    // The editor, still open, shows what was imported.
    await expect(page.locator("#sb-rows .sb-row[data-cue]")).toHaveCount(3);
  });

  test("it is a wide-desktop tool, and says so", async ({ page }) => {
    await page.locator("#library-storyboard").click();
    await expect(page.locator("#sb-editor")).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator("#sb-editor")).toBeHidden();
    await expect(page.locator("#status")).toContainText("wide");
    await expect(page.locator("#sb-viewport section.card-text")).toHaveCount(0);
  });
});
