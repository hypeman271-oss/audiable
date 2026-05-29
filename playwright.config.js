// @ts-check
// Playwright end-to-end harness. Launches a dedicated server.py instance
// on port 8001 (so it can coexist with a dev server on 8000) and runs
// the suite against it.
//
// Tests assume NARRATIVE_KEY is NOT set, so /api/* requests bypass the
// auth gate. The webServer block explicitly drops the env var if it
// happens to be in the parent shell.

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // synth is CPU-bound; parallel tests just thrash
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "dot" : "list",
  // Synthesis can take 5-30 sec on a cold start; give individual tests
  // plenty of headroom but cap the full suite so a hang fails fast.
  timeout: 60_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8001",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Tests interact with the live IDB; reuse a single context so the
    // beforeEach DB wipe is enough between tests within a file.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "python server.py",
    port: 8001,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: "8001",
      // Explicit empty so a stray NARRATIVE_KEY in the parent shell
      // doesn't gate /api/* and break every test.
      NARRATIVE_KEY: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  },
});
