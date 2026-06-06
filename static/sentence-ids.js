// Sentence ID helpers — JS twin of sentence_ids.py.
//
// MUST produce identical (input, output) pairs to the Python module
// for normalize() and hashText(). The fixture in
// tests/sentence_ids_fixture.json drives the test that proves they do.
//
// See SENTENCE_IDS.md for the design.

(() => {
  "use strict";

  const WHITESPACE_RUN = /\s+/g;

  // Public API attached to window so app.js can call window.NS_IDS.*
  // (NS_ID for "narrative sentence ID"). Plain object, no class.
  const NS_IDS = {
    /**
     * Canonical form of `text` for hashing.
     *   1. Unicode NFC (precomposed-é === decomposed-é).
     *   2. Collapse whitespace runs (space, tab, NBSP, newline) to one space.
     *   3. Trim.
     * Punctuation, case, quotes, em-dashes, accents preserved.
     */
    normalize(text) {
      if (text == null) return "";
      let s = String(text).normalize("NFC");
      s = s.replace(WHITESPACE_RUN, " ");
      return s.trim();
    },

    /**
     * SHA-256 of normalize(text), first 12 hex chars.
     * Async because Web Crypto is async; the sync use cases on the
     * client are vanishingly few (we hash on save, which is already
     * async). If we ever need sync, ship a small synchronous SHA-256
     * here instead — but DON'T import a npm package; this module is
     * <100 lines on purpose.
     */
    async hashText(text) {
      const n = NS_IDS.normalize(text);
      const bytes = new TextEncoder().encode(n);
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return hex.slice(0, 12);
    },

    /**
     * Canonical line ID for a clip-local counter.
     * Format `c_{clip_id}-{seq:04d}` — matches mint_line_id() in
     * sentence_ids.py. Synchronous; no I/O.
     */
    mintLineId(clipId, seq) {
      const c = Number.parseInt(clipId, 10);
      const s = Number.parseInt(seq, 10);
      return `c_${c}-${String(s).padStart(4, "0")}`;
    },
  };

  // Export both as window.NS_IDS (for app.js) and as a module-style
  // global so the test harness can grab it without a real bundler.
  window.NS_IDS = NS_IDS;
})();
