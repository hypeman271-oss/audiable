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

test.describe("regression — Chapter detection on URL fetch", () => {
  test("35-chapter novel triggers banner with promoted Roman titles — fixed in v84", async ({ page }) => {
    // v83 → v84: MAX_AUTO_DETECT was 30, which silently swallowed
    // Tom Sawyer's 35 chapters (extracted as ## I, ## II, … from
    // Standard Ebooks markdown). The banner just never appeared.
    // Also: bare-numeral titles like "I" / "II" were unreadable in
    // the library — v84 promotes them to "Chapter I" / "Chapter II".
    //
    // We stub /api/extract/url so this test (a) doesn't depend on
    // standardebooks.org being reachable and (b) runs in <1s instead
    // of the 5-15s the real fetch + trafilatura parse would take.
    // The stub returns 35 chapter headings in the same `## I` / `## II`
    // form Standard Ebooks produces, which is the actual format that
    // exposed the original bug.

    const ROMAN = [
      "I","II","III","IV","V","VI","VII","VIII","IX","X",
      "XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX","XX",
      "XXI","XXII","XXIII","XXIV","XXV","XXVI","XXVII","XXVIII","XXIX","XXX",
      "XXXI","XXXII","XXXIII","XXXIV","XXXV",
    ];
    const stubText = ROMAN
      .map(
        (r, i) =>
          `## ${r}\n\nThis is the body of chapter ${i + 1}. It needs at least one sentence so the splitter sees a real chapter and doesn't drop it as empty.`
      )
      .join("\n\n");

    await page.route("**/api/extract/url", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          filename: "example.com",
          chars: stubText.length,
          text: stubText,
          images: [],
        }),
      })
    );

    await page.goto("/");
    await page.locator("#paste-url-btn").click();
    await expect(page.locator("#url-row")).toBeVisible();

    await page.locator("#url-input").fill("https://example.com/book");
    await page.locator("#url-fetch-btn").click();

    const banner = page.locator("#chapter-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });

    // Exactly 35 chapters in the stub.
    await expect(page.locator("#chapter-banner-count")).toHaveText(
      /35 chapters/
    );
  });

  test("31-chapter doc still surfaces (regression for MAX_AUTO_DETECT=30 cap) — fixed in v84", async ({ page }) => {
    // Belt-and-suspenders test for the off-by-one risk: anything that
    // detects 31+ chapters used to be silently dropped. Stub a 31-chapter
    // doc and confirm the banner appears.
    const text = Array.from(
      { length: 31 },
      (_, i) => `# Chapter ${i + 1}\n\nBody paragraph for chapter ${i + 1}.`
    ).join("\n\n");

    await page.route("**/api/extract/url", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          filename: "example.com",
          chars: text.length,
          text,
          images: [],
        }),
      })
    );

    await page.goto("/");
    await page.locator("#paste-url-btn").click();
    await page.locator("#url-input").fill("https://example.com/book2");
    await page.locator("#url-fetch-btn").click();

    await expect(page.locator("#chapter-banner")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("#chapter-banner-count")).toHaveText(
      /31 chapters/
    );
  });
});

test.describe("regression — hidden attribute respected by CSS", () => {
  test("placeholder-text elements stay hidden on first load — fixed in v86", async ({ page }) => {
    // Pre-v86: 9 elements (.chapter-queue, .chapter-banner, .url-row,
    // .mini-player, .bookmarks-list, .filler-counts, .presets-list,
    // .speaker-chip, .whats-new-badge) had class-level `display: flex`
    // rules that overrode the browser's UA `display: none` for
    // `[hidden]`. They became visible on every fresh page load,
    // showing their literal placeholder HTML text — including a stale
    // "Chapter 1 of 1" queue pill and a "0 chapters detected" banner.
    // Same class of bug as the v79 Settings dialog regression. Fixed
    // by a global `[hidden] { display: none !important }` rule.
    await page.goto("/");

    // These elements all start with the `hidden` attribute in
    // index.html. None should be visible to the user on a fresh load.
    const expectedHidden = [
      "#chapter-banner",
      "#chapter-queue",
      "#url-row",
      "#mini-player",
      "#bookmarks-list",
      "#filler-counts",
      "#presets-list",
    ];
    for (const sel of expectedHidden) {
      await expect(page.locator(sel), `${sel} should be hidden`).toBeHidden();
    }
  });

  test("hidden attribute on a known offender hides it post-load — fixed in v86", async ({ page }) => {
    // Belt-and-suspenders: directly verify the CSS rule wins for
    // .chapter-queue specifically. If a future CSS edit re-introduces
    // a high-specificity display rule for one of these classes that
    // somehow beats the !important global, this test catches it.
    await page.goto("/");
    const queue = page.locator("#chapter-queue");
    // Initially hidden.
    await expect(queue).toBeHidden();
    // Force-show via JS then re-hide. The toBeHidden() assertion after
    // hiding proves the [hidden] rule still wins.
    await page.evaluate(() => {
      document.getElementById("chapter-queue").hidden = false;
    });
    await expect(queue).toBeVisible();
    await page.evaluate(() => {
      document.getElementById("chapter-queue").hidden = true;
    });
    await expect(queue).toBeHidden();
  });
});

test.describe("regression — Cold-start cascade hardening", () => {
  test("Generate with no voice selected fails fast — fixed in v88", async ({ page }) => {
    // Pre-v88: empty voice_id routed to SAPI fallback, produced a bad
    // WAV, and surfaced "mp3 encode failed" — the worst error message
    // in the app. Now generate() guards on voiceEl.value first.
    //
    // Stub /api/voices to return zero voices so the dropdown stays empty
    // (matches what /api/voices 503 would land on, without depending on
    // a real cold-start scenario).
    await page.route("**/api/voices", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ voices: [] }),
      })
    );

    await page.goto("/");
    await page.locator("#text").fill("Some text the user wants to synthesize.");
    await page.locator("#generate").click();

    // Status line shows the actionable error, NOT "mp3 encode failed".
    await expect(page.locator("#status")).toContainText(
      /Pick a voice first|waking up/i,
      { timeout: 5_000 }
    );
    // Crucially, the synthesis endpoint was never hit — fail-fast worked.
    // (If a /api/synthesize/stream request happens after this, the
    // assertion above could still pass with a race. We pin the negative
    // case explicitly.)
    let synthHit = false;
    page.on("request", (req) => {
      if (req.url().includes("/api/synthesize")) synthHit = true;
    });
    await page.waitForTimeout(500);
    expect(synthHit).toBe(false);
  });

  test("voice catalog 503 shows waking-up status — fixed in v88", async ({ page }) => {
    // Stub /api/voices to return 503 on first hit, simulating Fly.io
    // cold start. Without this fix, the status line said nothing and
    // the user saw an empty dropdown with no explanation.
    let hits = 0;
    await page.route("**/api/voices", (route) => {
      hits++;
      route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "<html><body>service unavailable</body></html>",
      });
    });

    await page.goto("/");
    // The first /api/voices call fires automatically on page load.
    await expect(page.locator("#status")).toContainText(/waking up|503/i, {
      timeout: 10_000,
    });
    expect(hits).toBeGreaterThanOrEqual(1);
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
