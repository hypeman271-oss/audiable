# Narrative — end-to-end tests

Playwright smoke + regression suite. Catches the obvious "did I break the app
generating a clip" regressions across the 70+ service-worker bumps without
hand-clicking every flow.

## One-time setup

```
npm install
npx playwright install chromium
```

`npm install` pulls `@playwright/test`. The second command downloads a
self-contained Chromium build into `~/.cache/ms-playwright/` (or the
equivalent on Windows). The Chromium binary is ~250 MB — once, not per
project.

## Running

The Playwright config auto-launches `python server.py` on port **8001**
(separate from your dev server on 8000, so you can keep developing in
parallel). It also explicitly unsets `NARRATIVE_KEY` so `/api/*` calls
bypass auth.

```
npm test              # headless, list reporter
npm run test:headed   # see the browser
npm run test:ui       # Playwright UI mode (great for debugging)
npm run test:report   # open the HTML report from the last run
```

A single test:
```
npx playwright test smoke
npx playwright test -g "feedback mailto"
```

## What's covered

### `smoke.spec.js` — main happy path
- `generate, save, reload, bookmark, delete` — paste text → Generate →
  verify clip lands in library → reload → verify clip persists → click
  to load → add bookmark → verify bookmark renders → delete clip →
  verify empty.
- `generate twice creates two distinct clips` — verifies Clear properly
  decouples from the previous clip so the second Generate doesn't
  overwrite the first.

### `regression.spec.js` — bug-prevention pins
Each test names the version the bug was found in. If one of these turns
red, look at the matching commit for context.

- **v62**: `mailto:` address must NOT be URL-encoded (the `@` → `%40`
  bug killed the Send feedback button for every tester).
- **v64**: Gmail compose link points at `mail.google.com` with correct
  query parameters.
- **v46**: Light theme sets `data-theme="light"` on `<html>` and
  persists across reloads.
- **v46**: Auto theme removes the explicit attribute (so OS preference
  controls the cascade).
- **v57**: Custom-preview synthesize POST must include `"piper:"`
  prefix in `voice_id` — without it, every voice falls through to the
  SAPI default and "all voices sound the same."
- **v71**: Speaker dropdown is hidden when num_speakers > 20; the
  chip replaces it. Exactly one of the two should be visible.

## Prerequisites for the smoke test

The smoke test runs `python server.py` and synthesizes one short
sentence with whatever voice the server returns as the default. So:

- Python venv with `requirements.txt` installed.
- At least one Piper voice in `voices/` (or, on Windows, SAPI works
  too — server lists both).

If you have no installed voices, the dropdown will be empty and the
smoke test fails immediately with a clear message.

## Stability notes

- **`fullyParallel: false, workers: 1`** — synthesis is CPU-bound;
  parallel tests just thrash the same Piper model and slow each other
  down. Serial is faster.
- **`timeout: 60_000`** per test — a cold Piper load can take 10+
  seconds; 60 sec is comfortably above the 95th percentile.
- **`retries: 1` in CI** — Piper occasionally hits transient OOM on
  shared runners. One retry is enough to mask noise without hiding
  real regressions.
- **IndexedDB wipe in `beforeEach`** — keeps each smoke test
  hermetic. The regression suite skips this since it doesn't touch
  the library.
