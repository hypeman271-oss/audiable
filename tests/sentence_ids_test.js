// Cross-impl verification: load static/sentence-ids.js in a minimal
// Node sandbox, run it against the same fixture sentence_ids.py used,
// and assert that every (normalize, hash) pair matches.
//
// Run: node tests/sentence_ids_test.js
//
// Exits 0 on full match, 1 on any mismatch. Lives alongside the
// fixture so the GitHub Actions corpus job (or a future tests job)
// can run it in CI.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC_DIR = path.join(__dirname, "..", "static");
const FIXTURE_PATH = path.join(__dirname, "sentence_ids_fixture.json");
const TWIN_PATH = path.join(STATIC_DIR, "sentence-ids.js");

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
const source = fs.readFileSync(TWIN_PATH, "utf-8");

// Minimal sandbox: provide `window` so the IIFE can attach NS_IDS.
// Node 18+ exposes crypto globally; older Node would need the
// `crypto.webcrypto` import — we don't support that here.
if (typeof globalThis.crypto?.subtle?.digest !== "function") {
  console.error("FATAL: Node lacks crypto.subtle.digest. Requires Node 18+.");
  process.exit(2);
}

const sandbox = {
  window: {},
  crypto: globalThis.crypto,
  TextEncoder: globalThis.TextEncoder,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const NS_IDS = sandbox.window.NS_IDS;
if (!NS_IDS) {
  console.error("FATAL: sentence-ids.js did not set window.NS_IDS");
  process.exit(2);
}

(async () => {
  let failed = 0;
  for (const { input, normalize, hash } of fixture) {
    const gotNorm = NS_IDS.normalize(input);
    const gotHash = await NS_IDS.hashText(input);
    if (gotNorm !== normalize || gotHash !== hash) {
      failed++;
      console.error(
        `MISMATCH for input=${JSON.stringify(input)}\n` +
          `  expected normalize=${JSON.stringify(normalize)}\n` +
          `  got      normalize=${JSON.stringify(gotNorm)}\n` +
          `  expected hash=${hash}\n` +
          `  got      hash=${gotHash}`,
      );
    }
  }
  // Also verify mintLineId format matches the Python helper.
  const cases = [
    [42, 7, "c_42-0007"],
    [1, 1234, "c_1-1234"],
    [1, 99999, "c_1-99999"],
  ];
  for (const [clipId, seq, expected] of cases) {
    const got = NS_IDS.mintLineId(clipId, seq);
    if (got !== expected) {
      failed++;
      console.error(`mintLineId(${clipId}, ${seq}) → ${got}, expected ${expected}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} cross-impl mismatch(es). Twins are out of sync.`);
    process.exit(1);
  }
  console.log(`JS twin matches Python on ${fixture.length} fixtures + 3 mintLineId cases.`);
})();
