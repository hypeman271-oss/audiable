// @ts-check
//
// v4.254: text over a picture scene is light in every theme. A page scene
// darkens its picture with a fixed dark scrim (rgba(8,10,20,.45–.62)), but
// the reading view and Book view coloured their text from the theme's --fg,
// which is dark ink on the light and sepia themes: dark text on a darkened
// picture, unreadable. An effect-alone scene keeps its light scrim and the
// theme's own ink, so it must NOT flip.

const { test, expect } = require("@playwright/test");

const THEMES = [null, "light", "sepia", "midnight", "nord", "forest"];
const PAPERS = ["light", "sepia", "gray", "night"];
const TEXT =
  "The blue hour was the best of Keeper Bram’s day. He walked the rows of the Amber Nursery, and counted. " +
  "Two hundred husks hung in the root vault. Each one held a light. Nothing was out of place.";

// Relative luminance of an element's computed text colour. The browser
// reports it as rgb(), color(srgb …) or oklab() depending on how the theme
// mixed it, so a canvas does the conversion: paint one pixel, read it back.
async function luminanceOf(page, selector) {
  return page.evaluate((sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : null;
    if (!el) return null;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = getComputedStyle(el).color;
    ctx.fillRect(0, 0, 1, 1);
    const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)).map((v) => v / 255);
    const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }, selector);
}

async function setup(page, cue) {
  await page.goto("/");
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase("audiable"); q.onsuccess = q.onerror = q.onblocked = r; }));
  await page.reload();
  await page.waitForFunction(() => typeof saveClip === "function" && typeof putAnimSheet === "function");
  return page.evaluate(async ({ text, cue }) => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 40;
    const g = c.getContext("2d");
    g.fillStyle = "#d8c8a0"; // a LIGHT picture: the scrim alone must carry the contrast
    g.fillRect(0, 0, 64, 40);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await putAnimSheet("sheet_scene_text", blob);
    const id = Date.now();
    await saveClip({
      id, kind: "ebook", title: "Scene text", note: "", text,
      sentenceOffsetsSec: [], bookmarks: [], images: [], annotations: [], highlights: [],
      animationCues: [Object.assign({ id: "anim_scene", kind: "page", startIdx: 0, endIdx: 0 }, cue)],
      createdAt: new Date().toISOString(),
    });
    await loadClip(id);
    // Colours are read mid-transition otherwise (.sentence fades 0.15s).
    const st = document.createElement("style");
    st.textContent = "*, *::before, *::after { transition: none !important; }";
    document.head.appendChild(st);
    return id;
  }, { text: TEXT, cue });
}

const PICTURE = { effect: "page", sheetId: "sheet_scene_text", source: "image", frames: 1, fps: 8 };
const FX_ALONE = { effect: "glow", fx: "glow" };

function setTheme(page, theme) {
  return page.evaluate((t) => {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
}

async function showScene(page) {
  await page.evaluate(async () => {
    _animInit();
    const cue = _animCues.find((c) => c.kind === "page");
    _animPage.cueId = null;
    _animReconcilePage(cue, false);
    for (let i = 0; i < 60; i++) {
      if (document.body.classList.contains("anim-page-active")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
}

test.describe("text over a page scene", () => {
  test("reading view: light over a picture in every theme", async ({ page }) => {
    await setup(page, PICTURE);
    await showScene(page);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const lum = await luminanceOf(page, "#reading-view .sentence");
      expect(lum, `theme ${theme || "default"}`).toBeGreaterThan(0.55);
    }
  });

  test("reading view: an effect alone keeps the theme's ink", async ({ page }) => {
    await setup(page, FX_ALONE);
    await showScene(page);
    await setTheme(page, "light");
    expect(await luminanceOf(page, "#reading-view .sentence")).toBeLessThan(0.3);
    // …and showing a picture after it, then the effect again, flips and returns.
    await page.evaluate(async () => {
      _animPage.cueId = null;
      _animReconcilePage({ id: "x", kind: "page", startIdx: 0, endIdx: 0, sheetId: "sheet_scene_text", source: "image", frames: 1 }, false);
      for (let i = 0; i < 60 && !document.body.classList.contains("anim-page-art"); i++) await new Promise((r) => setTimeout(r, 50));
    });
    expect(await luminanceOf(page, "#reading-view .sentence")).toBeGreaterThan(0.55);
    await page.evaluate(() => { _animPage.cueId = null; _animReconcilePage(_animCues[0], false); });
    expect(await luminanceOf(page, "#reading-view .sentence")).toBeLessThan(0.3);
    await page.evaluate(() => _animPageHide());
    expect(await luminanceOf(page, "#reading-view .sentence")).toBeLessThan(0.3);
  });

  test("Book view: light over a picture, the theme's ink over an effect", async ({ page }) => {
    await setup(page, PICTURE);
    await setTheme(page, "light");
    await page.evaluate(() => enterBookView());
    const art = ".book-view-page.book-page--art .sentence";
    await expect(page.locator(art).first()).toBeAttached({ timeout: 10_000 });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      // Book view inks its pages from the reader's paper, not the theme.
      for (const paper of PAPERS) {
        await page.evaluate((p) => { document.getElementById("book-view").dataset.bookPaper = p; }, paper);
        expect(await luminanceOf(page, art), `theme ${theme || "default"}, paper ${paper}`).toBeGreaterThan(0.55);
      }
    }

    await setup(page, FX_ALONE);
    await setTheme(page, "light");
    await page.evaluate(() => enterBookView());
    await expect(page.locator(".book-view-page.book-page--scene").first()).toBeAttached({ timeout: 10_000 });
    expect(await page.locator(".book-page--art").count()).toBe(0);
    await page.evaluate(() => { document.getElementById("book-view").dataset.bookPaper = "light"; });
    expect(await luminanceOf(page, ".book-view-page.book-page--scene .sentence")).toBeLessThan(0.3);
  });
});
