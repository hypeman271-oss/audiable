# Extract corpus regression test

Runs `/api/extract/url` and `/api/extract` against a curated set of
real-world ebook URLs and files. Each test case has expected lower
bounds (text length, sentence count) — anything falling below is a
regression.

Triggered by the freeread.de breakage where the extracted text was
silently empty/garbled and the user noticed only when book view broke.
This catches the upstream class of bug.

## Run

```
python tests/corpus/runner.py
```

Hits `https://narrative-alpha.fly.dev` by default. Override with
`--base-url http://localhost:8000` for local dev. Needs
`NARRATIVE_KEY` in env (same bearer your browser uses).

Exits 0 on full pass, 1 on any case failing. Prints a per-case
summary + a `failures.json` for triage.

## Adding a case

Edit `manifest.json`. Two shapes:

**URL case** — server fetches the URL via /api/extract/url:
```json
{
  "id": "gutenberg-tom-sawyer",
  "kind": "url",
  "url": "https://www.gutenberg.org/files/74/74-h/74-h.htm",
  "min_chars": 50000,
  "min_sentences": 200
}
```

**File case** — runner downloads first to `fixtures/`, then POSTs the
bytes through /api/extract:
```json
{
  "id": "standard-ebooks-pride",
  "kind": "file",
  "format": "epub",
  "download_url": "https://standardebooks.org/ebooks/.../filename.epub",
  "min_chars": 100000,
  "min_sentences": 1000
}
```

Pick `min_*` values from a baseline run, then drop ~10% so normal
variation doesn't trip the alarm.

## Phases

- **Phase 1 (now)**: extract-only. Validates text + sentence count.
- **Phase 2 (next)**: spawn /api/synth/jobs on a short slice (first 5
  sentences) of each case, poll to `done`, validate audio_sha256.
- **Phase 3 (later)**: headless book-view render via Playwright.
- **Phase 4 (later)**: Fly cron schedule (3 AM ET nightly), result
  push to narrative-debug-logs.

## Fixtures

Downloaded files cached under `tests/corpus/fixtures/`. Gitignored —
each run re-fetches missing ones. Keeps the repo small and forces
the URLs to stay live (which is part of the test).
</content>
