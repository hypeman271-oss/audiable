// @ts-check
//
// End-to-end smoke test: generate → save → load → bookmark → delete.
// The single highest-value path through the app — if this stays green
// you can probably ship without dread.
//
// Each test starts with a clean IndexedDB so a previous run's clips
// don't pollute the assertions.

const { test, expect } = require("@playwright/test");

const SHORT_TEXT = "The quick brown fox jumps over the lazy dog.";

// Wipe Narrative's IDB on every test. Runs in the page context so the
// browser owns the deletion — Playwright can't reach IDB from Node.
async function wipeLibrary(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("audiable");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

test.describe("smoke — main happy path", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Voice dropdown is populated async via /api/voices; wait for at
    // least one option before doing anything else.
    await expect(page.locator("#voice option")).not.toHaveCount(0, {
      timeout: 15_000,
    });
    await wipeLibrary(page);
    // Reload so the library list reflects the clean state (the JS
    // already populated it from the wiped DB on first load).
    await page.reload();
    await expect(page.locator("#voice option")).not.toHaveCount(0);
  });

  test("generate, save, reload, bookmark, delete", async ({ page }) => {
    // 1. Paste text + Generate. The voice dropdown's default selection
    //    is whatever the server's first voice is; we don't care which.
    await page.locator("#text").fill(SHORT_TEXT);
    await page.locator("#generate").click();

    // 2. Wait for the player card to render — that's the post-synthesis
    //    UI state. 45 sec budget to cover cold-start Piper loads.
    await expect(page.locator("#player-card")).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator("#player")).toHaveAttribute("src", /.+/, {
      timeout: 5_000,
    });

    // 3. Library should now contain exactly one clip.
    await expect(page.locator(".clip")).toHaveCount(1);

    // 4. Reload — IDB-backed library survives.
    await page.reload();
    await expect(page.locator(".clip")).toHaveCount(1);

    // 5. Click the clip body to load it. After load the player card
    //    is visible again and the audio src is populated.
    await page.locator(".clip .clip-play").click();
    await expect(page.locator("#player-card")).toBeVisible();
    await expect(page.locator("#player")).toHaveAttribute("src", /.+/);

    // 6. Drop a bookmark. The chip's label updates with "· N" once
    //    bookmarks exist.
    await page.locator("#bookmark-add-btn").click();
    await expect(page.locator(".bookmark-row")).toHaveCount(1);
    await expect(page.locator("#bookmark-add-btn")).toContainText(/· 1/);

    // 7. Delete the clip via its × button. Library returns to empty.
    await page.locator(".clip .clip-delete").click();
    await expect(page.locator(".clip")).toHaveCount(0);
  });

  test("generate twice creates two distinct clips", async ({ page }) => {
    for (const sentence of [
      "First clip about apples.",
      "Second clip about oranges.",
    ]) {
      // Each generate cycle: fill text, click Generate, wait for the
      // player card. Clear in between so the second generate creates a
      // fresh row instead of overwriting the first.
      await page.locator("#clear-btn").click();
      await page.locator("#text").fill(sentence);
      await page.locator("#generate").click();
      await expect(page.locator("#player-card")).toBeVisible({
        timeout: 45_000,
      });
    }
    await expect(page.locator(".clip")).toHaveCount(2);
  });
});
