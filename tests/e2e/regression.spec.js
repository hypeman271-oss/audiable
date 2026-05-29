// @ts-check
//
// Regression tests for code paths that broke at least once already and
// would silently break again. Each test names the version the bug was
// introduced/fixed in so a future failure points at the relevant commit
// without code archaeology.

const { test, expect } = require("@playwright/test");

test.describe("regression — Settings dialog", () => {
  test("feedback mailto: href has raw @ (not %40) — broke in v56-v62", async ({ page }) => {
    // v62 fix: the address in mailto: must NOT be URL-encoded. Encoding
    // the @ produces "mailto:bachatadonis%40gmail.com" which every
    // modern browser silently rejects. The button was dead for every
    // tester until the fix.
    //
    // The href is set async via _refreshFeedbackHref() (awaits
    // caches.keys()). Use toHaveAttribute with a regex so the assertion
    // auto-retries until the populate completes, instead of racing it.
    await page.goto("/");
    await page.locator("#settings-btn").click();
    const link = page.locator("#settings-feedback-link");
    await expect(link).toHaveAttribute("href", /^mailto:[^?]*@[^?]*\?/);
    await expect(link).not.toHaveAttribute("href", /%40/);
  });

  test("Gmail link points at mail.google.com compose URL — shipped in v64", async ({ page }) => {
    await page.goto("/");
    await page.locator("#settings-btn").click();
    const link = page.locator("#settings-feedback-gmail-link");
    await expect(link).toHaveAttribute(
      "href",
      /^https:\/\/mail\.google\.com\/mail\//
    );
    // Address here IS encoded (it's a query param, not a URI authority).
    await expect(link).toHaveAttribute("href", /[?&]to=[^&]*%40[^&]*/);
  });
});

test.describe("regression — Theme", () => {
  test("Light theme sets data-theme on documentElement — shipped in v46", async ({ page }) => {
    // Radio inputs in .theme-picker are visually hidden; the <label>
    // wraps them and intercepts pointer events. Click the visible
    // label by its text instead of trying to .check() the radio.
    await page.goto("/");
    await page.locator("#settings-btn").click();

    await page
      .locator(".theme-picker label")
      .filter({ hasText: "Light" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("Auto theme removes data-theme — shipped in v46", async ({ page }) => {
    // Pin prefers-color-scheme to dark so the test is deterministic
    // regardless of the host OS theme. Without this, a tester on Windows
    // Light Mode would see the page resolve Auto → light → attribute
    // stays "light" (which is correct behavior, but the wrong thing to
    // test here). The bug we're guarding against is "Auto fails to
    // clear the attribute when it should" — only meaningful when the
    // system pref is dark.
    await page.emulateMedia({ colorScheme: "dark" });

    await page.goto("/");
    await page.locator("#settings-btn").click();
    // Flip to Light first so we have something to clear, then Auto.
    await page
      .locator(".theme-picker label")
      .filter({ hasText: "Light" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page
      .locator(".theme-picker label")
      .filter({ hasText: "Auto" })
      .click();
    // With prefers-color-scheme: dark and Theme = Auto, the resolver
    // returns "dark" → applyTheme removes the attribute entirely.
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme",
      "light"
    );
  });
});

test.describe("regression — Voice browser plumbing", () => {
  test("Custom preview text uses piper: prefix when synthesizing — fixed in v57", async ({ page }) => {
    // v56 routed custom-preview through /api/synthesize but sent the
    // catalog's bare slug (en_US-amy-medium). The dispatcher matched
    // only "piper:..." so every voice fell through to SAPI's default.
    // v57 prefixed correctly. This test pins that down by inspecting
    // the outbound request payload.
    await page.goto("/");
    // <option> elements aren't "visible" to Playwright (Chromium hides
    // them outside an open dropdown), so wait for count instead.
    await expect(page.locator("#voice option")).not.toHaveCount(0, {
      timeout: 15_000,
    });
    await page.locator("#browse-voices-btn").click();
    await expect(page.locator(".catalog-voice")).not.toHaveCount(0, {
      timeout: 15_000,
    });

    await page.locator("#voice-preview-text").fill("Hello there");

    // Intercept the next /api/synthesize call so the test runs without
    // actually waiting for full synthesis.
    const requestPromise = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/synthesize") && req.method() === "POST",
      { timeout: 30_000 }
    );

    // Click ▶ on the first INSTALLED voice (synthesis only works on
    // installed voices; uninstalled rows trigger the audition-install
    // path, which is a different test).
    const installedRow = page
      .locator(".catalog-voice")
      .filter({ has: page.locator(".catalog-voice-action.installed") })
      .first();
    await installedRow.locator(".catalog-voice-preview").click();

    const req = await requestPromise;
    const body = req.postDataJSON();
    expect(body.voice_id).toMatch(/^piper:/);
  });
});

test.describe("regression — Speaker UI threshold", () => {
  // Skipped: this test needs either (a) a multi-speaker voice (LibriTTS
  // is 900 MB and not in CI) or (b) a test hook to mutate
  // _voiceSpeakerCounts from outside. The threshold logic itself is
  // simple enough (one if-statement around SPEAKER_DROPDOWN_MAX) that
  // it's covered well by manual verification on real LibriTTS. Revisit
  // if either a CI voice is added or the logic grows tendrils.
  test.skip("chip replaces native dropdown for >20-speaker voices — shipped in v71", () => {});
});
