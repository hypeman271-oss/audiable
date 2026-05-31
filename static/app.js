const $ = (id) => document.getElementById(id);

// ---- Debug log ---------------------------------------------------------
// v177: ring buffer for diagnosing "chapter X keeps failing to synthesize"
// reports. Every interesting step in the GitHub fetch → background queue →
// synthesis pipeline writes an entry here. Settings → "View debug log"
// surfaces the buffer in a modal with Copy/Download/Clear actions. The
// failures banner also gets a direct link so the user can go straight
// from "2 chapters failed" to "why."
//
// Cap intentionally generous (1000 entries, FIFO drop) — a typical 50-
// chapter import + retries fits comfortably, and most entries are short
// strings. Data field accepts any JSON-serializable value (objects get
// pretty-printed when rendered).
const _DEBUG_LOG_CAP = 1000;
const _debugLog = [];
function _dlog(category, message, data) {
  // ISO timestamp is sortable + copy/pasteable into bug reports.
  const entry = {
    t: new Date().toISOString(),
    cat: category || "general",
    msg: String(message || ""),
  };
  if (data !== undefined) entry.data = data;
  _debugLog.push(entry);
  // FIFO drop when over the cap. Splice from the front so the most
  // recent context (where the failure actually surfaced) is always
  // preserved at the tail of the buffer.
  if (_debugLog.length > _DEBUG_LOG_CAP) {
    _debugLog.splice(0, _debugLog.length - _DEBUG_LOG_CAP);
  }
  // Mirror to console at info level so developers debugging in DevTools
  // can correlate timestamps. Skip when data is undefined to avoid the
  // "[object Object]" noise on bare messages.
  try {
    if (data !== undefined) {
      console.info(`[dlog/${entry.cat}] ${entry.msg}`, data);
    } else {
      console.info(`[dlog/${entry.cat}] ${entry.msg}`);
    }
  } catch {}
}

// ---- API key (X-Narrative-Key) -----------------------------------------
// When the server is started with NARRATIVE_KEY set (typical for the public
// tunnel), every /api/* request needs an X-Narrative-Key header that matches.
// We wrap window.fetch once so the rest of the app doesn't have to think
// about it: stored key gets attached automatically, and a 401 triggers a
// single prompt + retry.
const API_KEY_STORAGE = "narrative.apiKey";

function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || ""; } catch { return ""; }
}
function setApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {}
}

let _keyPromptInFlight = false;
function _promptForApiKey() {
  // Re-entrant guard so concurrent 401s don't stack up half a dozen
  // prompts on top of each other while the user types.
  if (_keyPromptInFlight) return null;
  _keyPromptInFlight = true;
  try {
    const k = window.prompt(
      "This Narrative server requires an API key.\n\n" +
      "Paste your X-Narrative-Key value (set by the server admin):",
      getApiKey()
    );
    if (k && k.trim()) {
      setApiKey(k.trim());
      return k.trim();
    }
    return null;
  } finally {
    _keyPromptInFlight = false;
  }
}

(() => {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    options = options ? { ...options } : {};
    const url =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
        ? input.url
        : "";
    const isApi = url.startsWith("/api/");

    if (isApi) {
      const key = getApiKey();
      if (key) {
        const h = new Headers(options.headers || {});
        h.set("X-Narrative-Key", key);
        options.headers = h;
      }
    }

    let res = await origFetch(input, options);

    if (isApi && res.status === 401) {
      const newKey = _promptForApiKey();
      if (newKey) {
        const h = new Headers(options.headers || {});
        h.set("X-Narrative-Key", newKey);
        options.headers = h;
        res = await origFetch(input, options);
      }
    }
    return res;
  };
})();

const textEl = $("text");
const charCountEl = $("char-count");
const voiceEl = $("voice");
const speakerRow = $("speaker-row");
const speakerEl = $("speaker");
const speakerPreviewBtn = $("speaker-preview-btn");
const rateEl = $("rate");
const rateValueEl = $("rate-value");
const volumeEl = $("volume");
const volumeValueEl = $("volume-value");
const generateBtn = $("generate");
const downloadBtn = $("download");
const playerCard = $("player-card");
const playerEl = $("player");
const statusEl = $("status");

// Custom audio player UI ($-fetched at module load; bindings set up later).
const cpPlayBtn = $("cp-play-btn");
const cpPlayIcon = $("cp-play-icon");
const cpPauseIcon = $("cp-pause-icon");
const cpTimeCurrent = $("cp-time-current");
const cpTimeDuration = $("cp-time-duration");
const cpTimeEffective = $("cp-time-effective");
const cpScrubber = $("cp-scrubber");
const cpBuffered = $("cp-buffered");
const cpProgress = $("cp-progress");
const cpThumb = $("cp-thumb");
const cpMuteBtn = $("cp-mute-btn");
const cpVolIcon = $("cp-vol-icon");
const cpMuteIcon = $("cp-mute-icon");
const readingView = $("reading-view");
const editTextBtn = $("edit-text");
const saveTextBtn = $("save-text-btn");
const textLabel = $("text-label");
const libraryCard = $("library-card");
const libraryList = $("library-list");
const libraryClearBtn = $("library-clear");
const libraryHidePlayedBtn = $("library-hide-played");
const librarySyncGithubBtn = $("library-sync-github");
const libraryRenarrateOutdatedBtn = $("library-renarrate-outdated");
// v149: first-run empty-state card refs. _updateEmptyState shows/hides
// the card based on whether the user has any clips saved AND nothing
// typed.
const emptyStateEl = $("empty-state");
let _libraryHasClips = false;
// Set when "Sync GitHub" finds upstream changes. Used to badge library
// cards as outdated in renderLibrary. Cleared when the user refetches
// the affected clip OR re-runs Sync GitHub and the SHAs match again.
let _outdatedClipIds = new Set();
const playModeBtn = $("play-mode-btn");
const libraryLabel = $("library-label");
const librarySearch = $("library-search");
const libraryTagFilters = $("library-tag-filters");

// AND-style tag filter. Click a chip to require that tag; click again to
// drop it. Survives across renderLibrary calls; cleared explicitly by the
// "Clear" link in the chip row. Tags are stored lowercased.
const _libraryTagFilter = new Set();
const clipEditDialog = $("clip-edit");
const clipEditClose = $("clip-edit-close");
const clipEditTitle = $("clip-edit-title");
const clipEditNote = $("clip-edit-note");
const clipEditNotes = $("clip-edit-notes");
const clipEditTags = $("clip-edit-tags");
const clipEditSave = $("clip-edit-save");
const clipEditCoverPreview = $("clip-edit-cover-preview");
const clipEditCoverPick = $("clip-edit-cover-pick");
const clipEditCoverRemove = $("clip-edit-cover-remove");
const clipEditCoverInput = $("clip-edit-cover-input");
const bgArt = $("bg-art");
let _bgArtUrl = null;

// Libby-style page backdrop (v126). When a clip with an uploaded
// cover is loaded, fade that image in behind everything as a
// heavily blurred + dimmed atmosphere. Clearing the clip fades
// back to the default dark background. The CSS handles the
// blur / opacity / transition — JS just toggles inline
// background-image + the .active class.
function _setBackgroundArt(clip) {
  // Defensive: if an older cached HTML lacks the #bg-art element
  // (e.g. stale service worker before the user hard-reloads), the
  // element won't exist. Skip silently instead of throwing.
  if (!bgArt) return;
  if (_bgArtUrl) {
    URL.revokeObjectURL(_bgArtUrl);
    _bgArtUrl = null;
  }
  if (clip && clip.cover && clip.cover.blob) {
    _bgArtUrl = URL.createObjectURL(clip.cover.blob);
    bgArt.style.backgroundImage = `url("${_bgArtUrl}")`;
    bgArt.classList.add("active");
  } else {
    bgArt.classList.remove("active");
    // Defer wiping the background-image until the fade-out finishes
    // so the transition has something to fade FROM. 600ms matches
    // the CSS transition-duration on #bg-art.
    setTimeout(() => {
      if (bgArt && !bgArt.classList.contains("active")) {
        bgArt.style.backgroundImage = "";
      }
    }, 650);
  }
}

const libraryAllBookmarksBtn = $("library-all-bookmarks");
const allBookmarksDialog = $("all-bookmarks-dialog");
const allBookmarksClose = $("all-bookmarks-close");
const allBookmarksFilter = $("all-bookmarks-filter");
const allBookmarksSort = $("all-bookmarks-sort");
const allBookmarksList = $("all-bookmarks-list");
const allBookmarksSummary = $("all-bookmarks-summary");
const browseVoicesBtn = $("browse-voices-btn");
const presetSaveBtn = $("preset-save-btn");
const voiceDefaultsBtn = $("voice-defaults-btn");
const presetsList = $("presets-list");
const charactersBtn = $("characters-btn");
const charactersDialog = $("characters-dialog");
const charactersClose = $("characters-close");
const charactersList = $("characters-list");
const charactersAddBtn = $("characters-add");
const voiceBrowser = $("voice-browser");
const voiceBrowserClose = $("voice-browser-close");
const voiceBrowserSearch = $("voice-browser-search");
const voiceBrowserList = $("voice-browser-list");
const voiceInstalledToggle = $("voice-installed-toggle");
const voiceFavoritesToggle = $("voice-favorites-toggle");
// v218: third filter chip — show only voices cleared for commercial use.
const voiceCommercialToggle = $("voice-commercial-toggle");
const voiceLanguageFilter = $("voice-language-filter");
const voicePreviewText = $("voice-preview-text");
const voicePreviewClear = $("voice-preview-clear");
const voicePreviewHint = $("voice-preview-hint");
// Upload file input is still single-document only (txt/md/pdf/epub/docx).
// Scrivener gets its own input/accept filter to keep the OS file picker
// focused. Both inputs are triggered from the Import dropdown rather
// than dedicated header buttons.
const uploadInput = $("upload-input");
const scrivenerInput = $("scrivener-input");
const obsidianInput = $("obsidian-input");
const importBtn = $("import-btn");
const importMenu = $("import-menu");
const settingsBtn = $("settings-btn");
const settingsDialog = $("settings-dialog");
const settingsClose = $("settings-close");
// (Author-mode toggle is gone in v76; the three-tier Mode picker
// replaces it. The picker's radios are queried inline.)
const settingsFeedbackLink = $("settings-feedback-link");
const settingsFeedbackGmailLink = $("settings-feedback-gmail-link");
const settingsResetHintsLink = $("settings-reset-hints-link");
const settingsDebugLogLink = $("settings-debug-log-link");
const settingsWhatsNewLink = $("settings-whats-new-link");
const whatsNewBadge = settingsWhatsNewLink.querySelector(".whats-new-badge");

// Bump this number whenever there's a noteworthy change in whats-new.html
// worth surfacing. The Settings link shows a "NEW" badge until the user
// opens the changelog, at which point we save this version as "seen."
const WHATS_NEW_LATEST = 125;
const WHATS_NEW_KEY = "narrative.lastSeenWhatsNew";

function _isWhatsNewUnread() {
  try {
    const seen = Number(localStorage.getItem(WHATS_NEW_KEY)) || 0;
    return seen < WHATS_NEW_LATEST;
  } catch {
    return true;
  }
}

function _markWhatsNewSeen() {
  try {
    localStorage.setItem(WHATS_NEW_KEY, String(WHATS_NEW_LATEST));
  } catch {}
  whatsNewBadge.hidden = true;
}

// Clear the badge as soon as the user clicks; the changelog page itself
// is a regular link (target="_blank") so we don't preventDefault.
settingsWhatsNewLink.addEventListener("click", _markWhatsNewSeen);

// Alpha feedback inbox — mailto links pre-fill subject + auto-context +
// the user's report and target this address. Update before any deploy
// that changes ownership.
const FEEDBACK_EMAIL = "bachatadonis@gmail.com";
const clearBtn = $("clear-btn");
const urlRow = $("url-row");
// v142: per-flow hint above the URL input. Filled by showUrlRow({hint}).
const urlRowHint = $("url-row-hint");
const urlRowRecents = $("url-row-recents");
const urlInput = $("url-input");
const urlFetchBtn = $("url-fetch-btn");
const speedBtn = $("speed-btn");
const sleepBtn = $("sleep-btn");
const abLoopBtn = $("ab-loop-btn");
const skipBackBtn = $("skip-back-btn");
const bookmarkAddBtn = $("bookmark-add-btn");
const bookmarksList = $("bookmarks-list");
// v138 per-clip notes (free-form scratchpad). Quick-access player chip
// opens the dedicated dialog; the Edit dialog also exposes the same
// underlying clip.notes field.
const notesBtn = $("notes-btn");
const notesDialog = $("notes-dialog");
const notesDialogTitle = $("notes-dialog-title");
const notesDialogText = $("notes-dialog-text");
const notesDialogClose = $("notes-dialog-close");
const notesDialogStatus = $("notes-dialog-status");
let _notesEditingClipId = null;
const genLabel = generateBtn.querySelector(".label-text");
const genSpinner = generateBtn.querySelector(".spinner");

let lastBlobUrl = null;
let lastBlob = null;
// Images extracted from a URL fetch hang around in this module global
// until the next generate() saves them into the clip. Cleared by
// clearForNewClip and after a successful save so they don't leak into
// the next clip the user types from scratch.
let _pendingImages = [];
// Stashed alongside _pendingImages when the URL fetch (or GitHub
// browser pick) returned a gitRef. Persisted onto the saved clip so
// the update-checker can compare SHA against the live tree later.
let _pendingGitRef = null;

// ---- Interruption-aware auto-resume -------------------------------------
// When a phone call, Siri, Google Assistant, or system notification
// interrupts playback, the OS pauses the audio and (depending on platform)
// may or may not auto-resume after. iOS and Android both reliably push
// the tab to a hidden state during the interruption, then back to visible
// when it ends — which gives us a clean signal:
//
//   pause fires while visibilityState === "hidden"  →  external interrupt
//   pause fires while visibilityState === "visible" →  user-initiated
//
// _pauseAsUser() flags the four code paths that intentionally call
// playerEl.pause() from JS (sleep timer expiry, mini-player button,
// MediaSession pause/stop) so they don't get misread as external just
// because they happened during a background tab. Native audio-control
// pauses bypass JS entirely; they're caught by the visibility check.
let _externallyPaused = false;
let _suppressNextPauseFlag = false;

function _pauseAsUser() {
  _suppressNextPauseFlag = true;
  playerEl.pause();
}

playerEl.addEventListener("pause", () => {
  if (_suppressNextPauseFlag) {
    _suppressNextPauseFlag = false;
    _externallyPaused = false;
    return;
  }
  // Native audio-bar pause: user is looking at the page, this is
  // intentional. OS interrupt: page is hidden, the interrupt killed
  // playback while the user wasn't there to opt in.
  if (document.visibilityState !== "visible" && !playerEl.ended) {
    _externallyPaused = true;
  }
});

playerEl.addEventListener("play", () => {
  _externallyPaused = false;
  _suppressNextPauseFlag = false;
});

document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    _externallyPaused &&
    !playerEl.ended &&
    playerEl.src
  ) {
    _externallyPaused = false;
    // play() may reject if the browser blocks unattended resume (rare on
    // iOS/Android post-interruption, but possible). Swallow — the user
    // can hit play manually.
    playerEl.play().catch(() => {});
  }
});
// Start time (in seconds) of each sentence in the current clip. Filled from
// the SSE result event after each generate. The MediaSession seek-backward /
// seek-forward handlers use this to jump between sentence boundaries.
let sentenceOffsetsSec = [];
let sentenceSpans = [];
let activeSentenceIdx = -1;

// AbortController for the in-flight synthesis request (null when idle).
let _synthController = null;

// setTimeout handle for the 3-second pause between auto-advanced chapters.
// Cleared by _cancelAutoAdvance() whenever the user takes any action that
// would invalidate the queued next-clip load (manual play of another clip,
// Clear button, etc).
let _autoAdvanceTimer = null;
function _cancelAutoAdvance() {
  if (_autoAdvanceTimer) {
    clearTimeout(_autoAdvanceTimer);
    _autoAdvanceTimer = null;
  }
}

// Chapter-queue advance gating. Chapter N → N+1 must wait for BOTH:
//   1. the chapter's audio playback to finish (streaming queue exhausted
//      OR combined MP3 'ended' — whichever the user uses to listen)
//   2. the chapter's synthesis save to land in IndexedDB
// Two flags + a try-helper. Each flag-setter calls _tryAdvanceQueue;
// only the second one to set fires the actual advance. Prevents the
// v90 race where a single flag could be set after the only watcher
// (a setTimeout) had already fired and stopped looking.
let _queueAudioComplete = false;
let _queueSaveComplete = false;
let _queueAdvanceTimer = null;

function _tryAdvanceQueue() {
  if (_chapterTotalCount <= 0) return;
  // v165: foreground auto-advance only — the background worker
  // (v162) shares _chapterTotalCount and _chapterQueue with the
  // foreground queue, so without this guard, playing back a saved
  // clip while a background queue was running would fire the
  // foreground "next chapter" path and shift items off the
  // background queue. (User report: "I started playing a file and
  // I lost the queue.")
  if (_silentChapterQueue) return;
  if (!_queueAudioComplete || !_queueSaveComplete) return;
  // End-of-chapter sleep: the chapter just finished, both gates are
  // open, but the listener asked us to stop here. Suppress the advance,
  // clear the queue + flags so a stray later signal can't restart it,
  // and trip the sleep boundary handler. The pre-synth of N+1 may have
  // happened already — harmless, just a bit of wasted compute.
  if (_sleepEndOfChapter) {
    _queueAudioComplete = false;
    _queueSaveComplete = false;
    _chapterQueue = [];
    _chapterTotalCount = 0;
    _onSleepBoundaryReached("chapter");
    return;
  }
  // Both fired — schedule the advance with a 4-second polite breath
  // so chapters don't slam together. If a second invocation arrives
  // while the timer is pending (shouldn't, but defensive), the timer
  // is left in place and the duplicate is a no-op.
  if (_queueAdvanceTimer) return;
  _queueAudioComplete = false;
  _queueSaveComplete = false;
  // 2s breath — short enough that an attentive listener barely
  // notices, long enough to register that one chapter ended and
  // another is starting. Pre-synth means N+1 is loaded instantly
  // after this delay; the entire perceived gap is just these 2s.
  _queueAdvanceTimer = setTimeout(() => {
    _queueAdvanceTimer = null;
    _advanceChapterQueue();
  }, 2000);
}

function _resetQueueAdvanceFlags() {
  _queueAudioComplete = false;
  _queueSaveComplete = false;
  if (_queueAdvanceTimer) {
    clearTimeout(_queueAdvanceTimer);
    _queueAdvanceTimer = null;
  }
}

const synthProgress = $("synth-progress");

// ID of the clip currently loaded in the player (matches a row in IndexedDB).
// Set by generate() and loadClip(); used by the progress-save throttle to
// know which library row to update with currentTime.
let _currentClipId = null;
// Voice that the currently-loaded clip was synthesized with. Used by the
// listen-stats accumulator so the "top voice" tally reflects what the
// user actually heard, not whatever the voice picker happens to show.
let _currentPlayingVoiceId = null;
// Wall-clock timestamp of the last progress save; throttles timeupdate-driven
// IndexedDB writes to roughly once per PROGRESS_SAVE_INTERVAL_MS.
let _lastProgressSaveAt = 0;
const PROGRESS_SAVE_INTERVAL_MS = 5000;

// ---- Author mode --------------------------------------------------------
// A persisted toggle that gates "writing-craft" features (word count + read
// time, long-sentence highlighting, filler-word callouts, character voice
// assignment, etc.) behind a user opt-in. Everyone else gets a clean
// reader-focused UI by default.
//
// Three-tier UI mode picker — replaces the boolean Author toggle. CSS
// reads body[data-ui-mode] selectors:
//
//   simple   → reduces chrome; hides advanced player chips, library
//              tools, stats, audition wizard, drag handles, re-narrate
//              banner, etc. (.advanced-only is gated off in this mode)
//   standard → the previous default — everything except writing tools
//   author   → standard + writing-craft features (.author-only is
//              revealed: Characters dialog, word count + read-aloud
//              meta, long-sentence highlighter, filler-word callout)
//
// isAuthorMode() is preserved as a thin shim over the new API so the
// ~5 existing call sites don't need touching.
const UI_MODE_KEY = "narrative.uiMode";
const VALID_UI_MODES = ["simple", "standard", "author"];
const LEGACY_AUTHOR_MODE_KEY = "narrative.authorMode";

function getUIMode() {
  try {
    const stored = localStorage.getItem(UI_MODE_KEY);
    if (VALID_UI_MODES.includes(stored)) return stored;
    // First-run migration: if a tester had Author mode on before the
    // three-tier picker shipped, carry them straight to "author"
    // rather than dropping them to standard.
    const legacy = localStorage.getItem(LEGACY_AUTHOR_MODE_KEY);
    if (legacy === "true") {
      localStorage.setItem(UI_MODE_KEY, "author");
      localStorage.removeItem(LEGACY_AUTHOR_MODE_KEY);
      return "author";
    }
    if (legacy === "false") {
      localStorage.removeItem(LEGACY_AUTHOR_MODE_KEY);
    }
    return "standard";
  } catch {
    return "standard";
  }
}

function setUIMode(mode) {
  if (!VALID_UI_MODES.includes(mode)) mode = "standard";
  try { localStorage.setItem(UI_MODE_KEY, mode); } catch {}
  document.body.dataset.uiMode = mode;
  _updateModeUnlockHint(mode);
}
// v150: dynamic "+ unlocks" copy below the Mode picker. Each mode has
// a list of what it grants on top of the previous tier; the hint
// stitches together every tier ABOVE the current one so a Simple
// user sees both Standard and Author benefits in one sentence,
// Standard sees only Author, and Author sees nothing.
function _updateModeUnlockHint(mode) {
  const el = document.getElementById("mode-unlock-hint");
  if (!el) return;
  if (mode === "author") {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const parts = [];
  if (mode === "simple") {
    parts.push(
      '<strong>+ Standard</strong> unlocks bookmarks, sleep timer, A↔B loop, library tools, listen stats, and the cover-art workflow.'
    );
  }
  // Both Simple and Standard show what Author adds.
  parts.push(
    '<strong>+ Author</strong> unlocks live word count, long-sentence + filler-word callouts, character voices, and the 📝 Notes scratchpad chip.'
  );
  el.innerHTML = parts.join(" ");
  el.hidden = false;
}

// Back-compat shim. ~5 callers still read this to gate writing features.
function isAuthorMode() {
  return getUIMode() === "author";
}

// Apply current mode at boot — survives reloads and PWA reinstalls.
setUIMode(getUIMode());

// ---- Theme (auto / dark / light) ---------------------------------------
// The data-theme attribute on <html> drives a separate token block in
// styles.css that re-colors the whole UI. "auto" follows prefers-color-
// scheme; an inline boot script in index.html applies the saved choice
// before paint so testers don't see a dark→light flash on light mode.
const THEME_KEY = "narrative.theme";
const VALID_THEMES = ["auto", "dark", "light"];

function getThemePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return VALID_THEMES.includes(v) ? v : "auto";
  } catch { return "auto"; }
}

function resolveTheme(pref) {
  if (pref === "auto") {
    return matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return pref;
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  if (resolved === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  // Keep iOS / Android browser chrome in sync. index.html ships two
  // media-keyed theme-color tags that handle the Auto case for free.
  // For explicit Dark/Light, prepend an unmediated override so it wins
  // (browsers use the first applicable theme-color in document order).
  const head = document.head;
  let override = head.querySelector('meta[name="theme-color"][data-narrative]');
  if (pref === "auto") {
    if (override) override.remove();
  } else {
    if (!override) {
      override = document.createElement("meta");
      override.setAttribute("name", "theme-color");
      override.setAttribute("data-narrative", "");
      head.insertBefore(override, head.firstChild);
    }
    override.setAttribute(
      "content",
      resolved === "light" ? "#faf4e3" : "#0b1020"
    );
  }
}

function setTheme(pref) {
  if (!VALID_THEMES.includes(pref)) pref = "auto";
  try { localStorage.setItem(THEME_KEY, pref); } catch {}
  applyTheme(pref);
}

// Re-apply on system theme change ONLY when the user has chosen auto;
// otherwise their explicit pick wins.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (getThemePref() === "auto") applyTheme("auto");
});

// Wire the three radios. Reflecting current pref happens when the dialog
// opens (below) so the checked state always matches what's saved.
document
  .querySelectorAll('.theme-picker input[name="theme"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setTheme(radio.value);
    });
  });

// Skip-interval radios. Same pattern: persist + apply on change; the
// dialog-open hook below syncs the checked state to localStorage.
document
  .querySelectorAll('input[name="skip-interval"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setSkipInterval(parseInt(radio.value, 10));
    });
  });

// v197 (M2): book-font-size radios. Persist, apply the CSS var, and
// re-paginate if the user is currently in book view so the change is
// visible immediately. _bookViewRepaginate is a no-op when book view
// is closed, so this is safe to call unconditionally.
document
  .querySelectorAll('input[name="book-font-size"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      localStorage.setItem(BOOK_FONT_SIZE_KEY, radio.value);
      _applyBookFontSize(radio.value);
      _bookViewRepaginate();
    });
  });

// v199 (M3.1): book-theme radios. Same pattern as font-size — persist,
// apply the data attribute, re-paginate. The repaginate path includes
// the theme attribute on the probe so measurement matches render.
document
  .querySelectorAll('input[name="book-theme"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      localStorage.setItem(BOOK_THEME_KEY, radio.value);
      _applyBookTheme(radio.value);
      _bookViewRepaginate();
    });
  });

// Boot-time apply. The inline <head> script handles the pre-paint case;
// this is a belt-and-suspenders for browsers that ran past the inline
// script with a stale value (rare).
applyTheme(getThemePref());

// ---- Hero icon-rail triggers (v110: voice + library dialogs) ----------
// The voice card and library card moved out of the page flow into
// dialogs opened from the 🎤 / 📚 buttons next to ⚙. Triggers also
// carry live state: voice button shows the current voice name, library
// button shows the clip count.

const voiceTrigger = $("voice-trigger");
const voiceTriggerLabel = $("voice-trigger-label");
const voiceDialog = $("voice-dialog");
const voiceDialogClose = $("voice-dialog-close");
const libraryTrigger = $("library-trigger");
const libraryTriggerCount = $("library-trigger-count");
const libraryDialog = $("library-dialog");
const libraryDialogClose = $("library-dialog-close");

function _updateVoiceTriggerLabel() {
  // Voice <select> options carry the display name in textContent.
  const opt = voiceEl.selectedOptions && voiceEl.selectedOptions[0];
  const name = opt ? (opt.textContent || "").trim() : "";
  voiceTriggerLabel.textContent = name || "Voice";
  voiceTrigger.title = name ? `Voice: ${name}` : "Voice";
}

// ---- Drawer vs modal selection (v115, stacking added v117) -------------
// On desktop / landscape tablet (≥1024px) the voice + library dialogs
// open as right-side drawers (.show(), non-modal) so the text content
// stays interactive on the left. Below 1024px they open as modal
// bottom-sheets (.showModal()) the way they did at v110-v114. The
// trigger icons become toggles in drawer mode — clicking the same
// icon while the drawer is open closes it (matches user muscle
// memory; works because non-modal dialogs don't block trigger clicks).
//
// v117: at desktop width, voice + library can be OPEN AT THE SAME TIME
// and stack vertically (voice top half, library bottom half). The CSS
// uses the per-dialog body classes below to detect "both open" and
// re-flow. On mobile (modal mode) we still enforce mutual exclusion —
// stacking doesn't make sense when each dialog covers the viewport.
const DRAWER_BREAKPOINT_PX = 1024;
const _isDrawerMode = () => window.innerWidth >= DRAWER_BREAKPOINT_PX;

function _openAsDrawerOrModal(dialog) {
  if (_isDrawerMode()) {
    dialog.show();
    _syncDrawerBodyClasses();
    // v156: the just-opened drawer becomes the active (full-height)
    // one in the stacked layout. The user just chose to open this
    // drawer — show them the thing they asked for.
    _promoteDrawer(dialog);
  } else {
    // Modal mode (mobile): only one dialog at a time. Each modal
    // covers the viewport with a backdrop — stacking would be a mess.
    if (dialog !== voiceDialog && voiceDialog.open) voiceDialog.close();
    if (dialog !== libraryDialog && libraryDialog.open) libraryDialog.close();
    dialog.showModal();
  }
}

// Body class management. CSS keys off `drawer-voice-open` and
// `drawer-library-open` independently:
//   - either present → body gets padding-right (text content shifts left)
//   - both present   → drawers stack (active one full height, other
//     collapses to header strip — see drawer-active-{voice,library})
function _syncDrawerBodyClasses() {
  document.body.classList.toggle("drawer-voice-open", voiceDialog.open);
  document.body.classList.toggle("drawer-library-open", libraryDialog.open);
  // v156: when both are open, ensure one of drawer-active-{voice,library}
  // is set so the stacked CSS picks a layout. When fewer than two are
  // open, the active class is irrelevant — clear both so reopening
  // doesn't inherit a stale active state.
  if (voiceDialog.open && libraryDialog.open) {
    if (
      !document.body.classList.contains("drawer-active-voice") &&
      !document.body.classList.contains("drawer-active-library")
    ) {
      document.body.classList.add("drawer-active-voice");
    }
    // v158: take a measurement on every state change so the strip's
    // top anchor moves with the active drawer's content height.
    requestAnimationFrame(_updateDrawerStackHeight);
  } else {
    document.body.classList.remove("drawer-active-voice");
    document.body.classList.remove("drawer-active-library");
    // Clear the var so a stale value doesn't leak when only one
    // drawer is open (where the var has no effect anyway).
    document.body.style.removeProperty("--drawer-active-h");
  }
}

// v156: promote the given dialog to the active (full-height) one in
// the stacked drawer layout. No-op when fewer than two drawers are
// open — the active class only matters when stacking.
function _promoteDrawer(dialog) {
  if (!voiceDialog.open || !libraryDialog.open) return;
  if (dialog === voiceDialog) {
    document.body.classList.add("drawer-active-voice");
    document.body.classList.remove("drawer-active-library");
  } else if (dialog === libraryDialog) {
    document.body.classList.add("drawer-active-library");
    document.body.classList.remove("drawer-active-voice");
  }
  // v158: re-measure after the class change so the inactive strip
  // re-anchors immediately. rAF waits for the active drawer to
  // re-render at its new height before reading offsetHeight.
  requestAnimationFrame(_updateDrawerStackHeight);
}

// v158: measure the active drawer's current height and publish it
// as --drawer-active-h so the inactive strip's `top` lines up
// flush with the active drawer's bottom — no gap above (active
// pinned to top: 0) or below (strip immediately below). Without
// this the strip's `top` falls back to (viewport - strip-h) and
// the active drawer's empty trailing space becomes visible chrome.
function _updateDrawerStackHeight() {
  if (!_isDrawerMode()) return;
  if (!voiceDialog.open || !libraryDialog.open) return;
  const isVoiceActive = document.body.classList.contains("drawer-active-voice");
  const active = isVoiceActive ? voiceDialog : libraryDialog;
  const h = active.offsetHeight;
  if (h > 0) {
    document.body.style.setProperty("--drawer-active-h", `${Math.round(h)}px`);
  }
}

// Observe both dialogs — content changes (Browse voices opens, a
// new clip lands in the library, an Author-mode chip appears) all
// shift the active drawer's height. Fires on hide too (size goes
// to 0); guarded inside _updateDrawerStackHeight.
if (typeof ResizeObserver !== "undefined") {
  const obs = new ResizeObserver(() => _updateDrawerStackHeight());
  obs.observe(voiceDialog);
  obs.observe(libraryDialog);
}
window.addEventListener("resize", _updateDrawerStackHeight);

// v156: click anywhere inside a drawer → that drawer becomes active.
// Lets the user tap the collapsed strip's header to swap which
// drawer has full height. No-op when only one drawer is open
// (_promoteDrawer guards on .open).
voiceDialog.addEventListener("click", () => _promoteDrawer(voiceDialog));
libraryDialog.addEventListener("click", () => _promoteDrawer(libraryDialog));

// Same sync on close so the classes drop when a drawer is dismissed
// via Close button, Esc, trigger-toggle, or programmatic .close().
voiceDialog.addEventListener("close", _syncDrawerBodyClasses);
libraryDialog.addEventListener("close", _syncDrawerBodyClasses);

voiceTrigger.addEventListener("click", () => {
  // Toggle: clicking the icon while the drawer is open closes it.
  if (voiceDialog.open) {
    voiceDialog.close();
    return;
  }
  _updateVoiceTriggerLabel();
  _openAsDrawerOrModal(voiceDialog);
});
voiceDialogClose.addEventListener("click", () => voiceDialog.close());
// Keep the label in sync whenever the voice changes (picker, preset
// apply, voice browser install pick, etc.).
voiceEl.addEventListener("change", _updateVoiceTriggerLabel);

libraryTrigger.addEventListener("click", () => {
  if (libraryDialog.open) {
    libraryDialog.close();
    return;
  }
  // Refresh the list every open so newly-saved clips show up without
  // a page reload. renderLibrary also rewires the badge below.
  renderLibrary();
  _openAsDrawerOrModal(libraryDialog);
});
libraryDialogClose.addEventListener("click", () => libraryDialog.close());

// Non-modal dialogs (the drawer-mode show()) don't auto-close on Esc
// like showModal() does. Handle it manually so the keyboard shortcut
// works in both modes.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (voiceDialog.open && !voiceDialog.matches(":modal")) {
    e.preventDefault();
    voiceDialog.close();
  } else if (libraryDialog.open && !libraryDialog.matches(":modal")) {
    e.preventDefault();
    libraryDialog.close();
  }
});

// Backdrop-click closes any dialog. With showModal(), clicks on the
// area OUTSIDE the dialog box hit the ::backdrop pseudo-element, but
// the click event still fires on the <dialog> with the dialog itself
// as e.target. Clicks INSIDE the dialog target inner elements
// (buttons, inputs, divs), so `e.target === dialog` is a clean signal
// that the user clicked outside.
//
// Solves the desktop muscle-memory case where users try to close by
// re-clicking the hero trigger icon (🎤 / 📚): the icon is visually
// dimmed under the backdrop, but the modal blocks pointer events on
// it. Clicking the backdrop where the icon appears now closes the
// dialog the way they expect. Also matches the standard iOS / Material
// "tap outside to dismiss" pattern. Applied once at boot to every
// <dialog> in the page (we don't add dialogs dynamically).
document.querySelectorAll("dialog").forEach((d) => {
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
});

settingsBtn.addEventListener("click", () => {
  // Sync the mode radios to the saved UI mode so the dialog always
  // reflects current state, even if the user switched in another tab.
  const mode = getUIMode();
  document
    .querySelectorAll('.mode-picker input[name="ui-mode"]')
    .forEach((r) => { r.checked = r.value === mode; });
  // Same for the theme radios.
  const pref = getThemePref();
  document
    .querySelectorAll('.theme-picker input[name="theme"]')
    .forEach((r) => { r.checked = r.value === pref; });
  // And the skip-interval radios.
  document
    .querySelectorAll('input[name="skip-interval"]')
    .forEach((r) => { r.checked = parseInt(r.value, 10) === _skipInterval; });
  // v197 (M2): book-font-size radios.
  const bfs = _loadBookFontSize();
  document
    .querySelectorAll('input[name="book-font-size"]')
    .forEach((r) => { r.checked = r.value === bfs; });
  // v199 (M3.1): book-theme radios.
  const bt = _loadBookTheme();
  document
    .querySelectorAll('input[name="book-theme"]')
    .forEach((r) => { r.checked = r.value === bt; });
  // Refresh stats so they reflect listening that happened since the
  // dialog was last opened. _renderStatsPanel resolves a few lookups
  // (voice display name, clip title) so it's async.
  _renderStatsPanel();
  // Refresh the feedback link's mailto href with the latest auto-context
  // (build version, currently-loaded clip). Set before the dialog shows
  // so the link is ready by the time the user can click it.
  _refreshFeedbackHref();
  // Show the "NEW" badge on the What's new link if the user hasn't seen
  // the current changelog version yet.
  whatsNewBadge.hidden = !_isWhatsNewUnread();
  // Sync the GitHub PAT field. We DON'T show the stored token in clear
  // text — that would leak it into the visible DOM and into form-fill
  // history. Instead we just show a "Token saved (last 4: ABCD)"
  // confirmation, with the input empty so any typed value is treated
  // as a fresh paste.
  const _gh = $("settings-github-token");
  const _ghStatus = $("settings-github-status");
  if (_gh && _ghStatus) {
    _gh.value = "";
    const saved = getGithubToken();
    if (saved) {
      const tail = saved.slice(-4);
      // v140: prominent banner state — accent border + ✓ icon — so a
      // returning user sees "yes, your token is on file" at the top
      // of the GitHub section, not as faint hint text below the
      // (deliberately cleared) input.
      _ghStatus.dataset.state = "saved";
      _ghStatus.textContent =
        `Token saved (ending in …${tail}). Paste a new value to replace it; the field stays blank for safety.`;
    } else {
      // No token → no banner. The hint paragraph below the empty
      // input already explains the section.
      _ghStatus.dataset.state = "empty";
      _ghStatus.textContent = "";
    }
  }
  // v149: collapsed-by-default help disclosure is right for repeat
  // users (they know the dance), but a first-time user needs the
  // visual guide to be visible without an extra click. Open it
  // automatically when no token is saved; respect the user's choice
  // once they've toggled it manually (data-user-toggled flag set on
  // first interaction below).
  const _ghHelp = $("settings-github-help");
  if (_ghHelp && !_ghHelp.dataset.userToggled) {
    _ghHelp.open = !getGithubToken();
  }
  // v180: refresh OAuth button state every time Settings opens so a
  // status change (token saved in another tab, server-side OAuth got
  // configured) is reflected immediately.
  if (typeof _refreshGithubOAuthUI === "function") {
    _refreshGithubOAuthUI();
  }
  settingsDialog.showModal();
});

settingsClose.addEventListener("click", () => settingsDialog.close());

// v220h: open /manual.html in an in-app dialog instead of a new tab.
//
// Problem: on a phone PWA, target=_blank opens a new tab and the OS
// suspends the original tab — including its in-flight GitHub fetch
// and synth SSE. v216 paused our own watchdog on visibility change,
// but the browser cancels the network requests at a lower level we
// can't reach. So we just don't navigate away.
//
// The dialog has an iframe pointing at /manual.html — same content,
// but no tab switch. Three call sites use this:
//   1. The header ? icon (v220e)
//   2. The empty-state "Read the 2-minute guide" link (v220e)
//   3. The Settings → "Help & manual →" link (v118+, promoted to top
//      in v220f)
//
// Modifier-clicks (cmd / ctrl / middle / shift) fall through to the
// native new-tab behavior so desktop power users who want an actual
// tab can still get one. The "Open in new tab ↗" affordance inside
// the dialog header is the explicit escape hatch for the same.
(function _initManualDialog() {
  const dlg = document.getElementById("manual-dialog");
  const frame = document.getElementById("manual-dialog-frame");
  const closeBtn = document.getElementById("manual-dialog-close");
  if (!dlg || !frame || !closeBtn) return;

  let loaded = false;
  function openManualDialog() {
    if (!loaded) {
      // Lazy-load the iframe content on first open. After that the
      // user can re-open the dialog without paying the parse cost
      // again — the iframe stays mounted, just hidden by the close.
      frame.src = "/manual.html";
      loaded = true;
    }
    // v220l: back to showModal() — matches the Settings dialog
    // which works fine. The v220j show() detour broke tap on the
    // page. Modal contract is NOT what caused the post-close scroll
    // lock; the iframe inside was. See closeManualDialog for the
    // iframe-specific cleanup.
    if (!dlg.open) dlg.showModal();
  }
  function closeManualDialog() {
    // v220l: blur the iframe BEFORE closing so its document doesn't
    // hold scroll focus. Combined with the close() that follows, this
    // releases the touch context cleanly on Android Chrome.
    try {
      if (frame.contentWindow) frame.contentWindow.blur();
      frame.blur();
    } catch {}
    if (dlg.open) dlg.close();
  }
  closeBtn.addEventListener("click", closeManualDialog);

  // Click on backdrop (the auto ::backdrop from showModal) closes
  // the dialog. Same idiom Settings/voice browser dialogs use.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeManualDialog();
  });

  // Helper: intercept a manual-targeting <a> click and route through
  // the dialog instead. Honors modifier-clicks (cmd/ctrl/shift) and
  // non-primary mouse buttons so power-users can still open in a
  // new tab if they explicitly ask for it.
  function _routeManualClick(e) {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (typeof e.button === "number" && e.button !== 0) return;
    e.preventDefault();
    openManualDialog();
  }

  // Wire all three call sites. getElementById for the IDs we have;
  // querySelector for the empty-state link (no id) and the Settings
  // link (no id either — it's the first manual.html href in the
  // settings-body, promoted to top in v220f).
  const headerHelp = document.getElementById("help-btn");
  if (headerHelp) headerHelp.addEventListener("click", _routeManualClick);

  const emptyStateLink = document.querySelector(
    ".empty-state-manual-link a[href='/manual.html']"
  );
  if (emptyStateLink) emptyStateLink.addEventListener("click", _routeManualClick);

  // Settings dialog: the Help & manual link. Match by href so we
  // don't depend on a specific class composition.
  const settingsManualLinks = document.querySelectorAll(
    ".settings-body a.settings-help-link[href='/manual.html']"
  );
  for (const a of settingsManualLinks) {
    a.addEventListener("click", _routeManualClick);
  }
})();

// v220g: first-load attention animation on the ? and ⚙ icons.
//
// Problem: testers consistently miss the gear (and the new ? help
// icon next to it). Once they don't see them on first paint, they
// don't come back to look. A subtle 3-pulse animation on both icons
// — 1.5s after page load — pulls the eye there without screaming.
//
// Dismisses for life on:
//   - click of either icon (they found it — done)
//   - 3.2s timer (the animation's own end — natural conclusion)
//
// Earlier draft also dismissed on pointermove + keydown, but those
// fire during normal page-load cursor settle, so the animation got
// killed before the user could see it. Removed. The 3-second pulse
// is short enough that letting it finish is fine even if the user
// has already moved on.
//
// Replay by clearing narrative.helpAttentionSeen via Settings →
// Replay onboarding tips (the key is in _ONBOARDING_HINT_KEYS).
(function _initHelpAttentionPulse() {
  const HELP_ATTENTION_KEY = "narrative.helpAttentionSeen";
  let seen = false;
  try { seen = localStorage.getItem(HELP_ATTENTION_KEY) === "1"; } catch {}
  if (seen) return;
  const helpBtn = document.getElementById("help-btn");
  const gearBtn = document.getElementById("settings-btn");
  if (!helpBtn || !gearBtn) return;

  const armed = [helpBtn, gearBtn];
  let dismissTimer = null;

  function dismiss() {
    for (const el of armed) el.classList.remove("attention-pulse");
    try { localStorage.setItem(HELP_ATTENTION_KEY, "1"); } catch {}
    helpBtn.removeEventListener("click", dismiss);
    gearBtn.removeEventListener("click", dismiss);
    if (dismissTimer) clearTimeout(dismissTimer);
  }
  helpBtn.addEventListener("click", dismiss, { once: true });
  gearBtn.addEventListener("click", dismiss, { once: true });

  // 1.5s settle delay — page paints, status bar settles, hero
  // resolves. Then start the pulse.
  setTimeout(() => {
    for (const el of armed) el.classList.add("attention-pulse");
    // CSS plays animation 3x (3s). Schedule cleanup just after the
    // last iteration completes so we don't leave the class hanging.
    dismissTimer = setTimeout(dismiss, 3200);
  }, 1500);
})();

// v152: keyboard shortcuts overlay. Opens via "?" key (when focus
// is NOT inside an input/textarea/contenteditable — otherwise the
// user can't type "?" into a search box) or via the Settings link.
const shortcutsDialog = $("shortcuts-dialog");
const shortcutsClose = $("shortcuts-close");
const shortcutsLink = $("settings-shortcuts-link");
if (shortcutsClose) {
  shortcutsClose.addEventListener("click", () => shortcutsDialog.close());
}
if (shortcutsLink) {
  shortcutsLink.addEventListener("click", (e) => {
    e.preventDefault();
    // Close Settings so the shortcuts dialog isn't stacked on top —
    // both use .showModal() and Esc would close the wrong one.
    if (settingsDialog.open) settingsDialog.close();
    shortcutsDialog.showModal();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (!t) return;
  // Don't hijack ? while the user is typing — they need it in
  // search/URL/notes/etc.
  if (
    t.matches &&
    t.matches("input, textarea, [contenteditable=true], [contenteditable=plaintext-only]")
  ) {
    return;
  }
  // Don't open while another modal is already showing (e.g. user
  // hit ? inside the voice browser); let Esc close that first.
  const anyOpen = document.querySelector("dialog[open]");
  if (anyOpen) return;
  e.preventDefault();
  shortcutsDialog.showModal();
});

// GitHub PAT input — save on change, with a confirmation hint shown
// underneath. Token-shape sanity check is loose: GitHub PATs start with
// `ghp_` (classic) or `github_pat_` (fine-grained), but we don't fail
// on unknown formats since GitHub Enterprise and future formats may
// differ.
(() => {
  const input = $("settings-github-token");
  const clearBtn = $("settings-github-token-clear");
  const status = $("settings-github-status");
  if (!input || !clearBtn || !status) return;
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) return; // empty value on change just means user re-opened the dialog
    setGithubToken(v);
    const tail = v.slice(-4);
    // v140: flip the banner to the accent-tinted "saved" state so the
    // user gets a loud visual at the TOP of the section right after
    // pasting — that's where they're already looking.
    status.dataset.state = "saved";
    status.textContent =
      `Token saved (ending in …${tail}). The field below was cleared so the value can't be read back.`;
    input.value = ""; // don't keep it visible in the DOM
    // v180: signed-in user line updates from the new token.
    if (typeof _refreshGithubOAuthUI === "function") _refreshGithubOAuthUI();
  });
  clearBtn.addEventListener("click", () => {
    setGithubToken("");
    input.value = "";
    status.dataset.state = "cleared";
    status.textContent = "Token cleared from this device.";
    // v180: signed-in user line clears with the token.
    if (typeof _refreshGithubOAuthUI === "function") _refreshGithubOAuthUI();
  });

  // v144: when the "Show me what to copy" disclosure opens, pull its
  // summary up to the top of the dialog scroll area so the mock
  // screenshot is in view immediately. Previously the body expanded
  // below the fold and at least one tester didn't notice anything
  // happened — they were staring at the (now invisible) input row
  // and the help they were trying to read was already on screen
  // just below it.
  const ghHelp = $("settings-github-help");
  if (ghHelp) {
    ghHelp.addEventListener("toggle", () => {
      // v149: mark that the user has chosen a state so the
      // "default open when no token" auto-toggle in the dialog
      // open path leaves their choice alone next time.
      ghHelp.dataset.userToggled = "1";
      if (!ghHelp.open) return;
      // scrollIntoView with block:"start" aligns the summary to the
      // dialog's scroll container top. Respect reduced-motion by
      // skipping the smooth scroll there.
      const reduced =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      ghHelp.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
    });
  }
})();

// v180: GitHub OAuth — Sign-in button wiring + signed-in user display.
// Fetches /api/github/oauth/status once on Settings open and adjusts
// the button's enabled / disabled state. When a token is saved (PAT
// OR OAuth), calls /user via api.github.com to show "Signed in as
// @user" + an avatar bullet. PAT and OAuth tokens are interchangeable
// at the API layer — both produce the same Bearer auth — so this
// works for both.
let _githubOAuthStatusCache = null;       // null = not fetched yet
let _githubOAuthInflightUser = null;       // fetch promise dedupe
let _githubOAuthLastTokenChecked = "";     // skip duplicate /user calls

async function _fetchGithubOAuthStatus() {
  if (_githubOAuthStatusCache) return _githubOAuthStatusCache;
  try {
    const res = await fetch("/api/github/oauth/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _githubOAuthStatusCache = await res.json();
  } catch (err) {
    _githubOAuthStatusCache = { configured: false, error: err.message };
  }
  return _githubOAuthStatusCache;
}

async function _fetchGithubUser(token) {
  if (!token) return null;
  if (token === _githubOAuthLastTokenChecked && _githubOAuthInflightUser) {
    return _githubOAuthInflightUser;
  }
  _githubOAuthLastTokenChecked = token;
  _githubOAuthInflightUser = (async () => {
    try {
      // Direct fetch to api.github.com — same as the rest of the
      // GitHub flows do via the backend. We hit it client-side here
      // because the token is already on this device and there's no
      // value in routing through our server just to log "@octocat".
      const res = await fetch("https://api.github.com/user", {
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
  return _githubOAuthInflightUser;
}

async function _refreshGithubOAuthUI() {
  const btn = document.getElementById("settings-github-oauth-btn");
  const note = document.getElementById("settings-github-oauth-note");
  if (!btn || !note) return;

  const status = await _fetchGithubOAuthStatus();
  const labelEl = btn.querySelector(".settings-github-oauth-label");
  const token = getGithubToken();

  if (!status.configured) {
    btn.disabled = true;
    btn.title =
      "GitHub OAuth isn't configured on this server. The operator " +
      "needs to set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET env vars. " +
      "See OAUTH_SETUP.md. Or paste a Personal Access Token below.";
    if (labelEl) labelEl.textContent = "Sign in with GitHub";
    note.textContent =
      "OAuth not configured on the server — paste a token below instead.";
    note.dataset.state = "info";
    return;
  }

  btn.disabled = false;
  btn.title =
    "Opens GitHub in this tab so you can authorize Narrative. " +
    "Token comes back via a redirect — never typed.";
  if (token) {
    if (labelEl) labelEl.textContent = "Re-authorize with GitHub";
    // Try to look up "Signed in as @user". Best-effort: failure
    // (revoked token / no scopes / network) just falls back to the
    // generic "Token saved" line in the existing #settings-github-status.
    const user = await _fetchGithubUser(token);
    if (user && user.login) {
      note.textContent = `Signed in as @${user.login}.`;
      note.dataset.state = "signed-in";
    } else {
      note.textContent =
        "Token saved on this device — couldn't fetch the GitHub user " +
        "(token may have expired or lacks read:user scope).";
      note.dataset.state = "warn";
    }
  } else {
    if (labelEl) labelEl.textContent = "Sign in with GitHub";
    note.textContent = "";
    note.dataset.state = "";
  }
}

(() => {
  const btn = document.getElementById("settings-github-oauth-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    // Top-level navigation — fragments + cookies need a real page
    // load, not a fetch. The /start endpoint 302s us to GitHub.
    window.location.href = "/api/github/oauth/start";
  });
})();

// Mode picker change handler. Apply the new mode, then refresh the
// textarea meta so the word-count / read-time line appears or
// disappears immediately when flipping to/from Author.
document
  .querySelectorAll('.mode-picker input[name="ui-mode"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        setUIMode(radio.value);
        updateCounts();
      }
    });
  });

// Alpha feedback. Two paths so the user can pick whichever works:
//
//   - mailto: → opens the system default mail handler (Outlook on
//     Windows, Mail.app on macOS, Gmail / Mail on phones depending on
//     the user's setup).
//   - Gmail compose URL → opens Gmail directly in a browser tab,
//     bypassing the OS default. Useful when the system default is
//     something the user doesn't actually check (e.g. Outlook/Hotmail
//     on Windows when they live in Gmail).
//
// Both URLs share the same prefilled body, built once per Settings open.
// Two reliability gotchas:
//   1. The address in mailto: must be RAW — encoding `@` to `%40`
//      produces a malformed URI that modern browsers silently reject.
//      Only the subject + body get encoded. The Gmail URL DOES need
//      the address encoded (it's a query parameter there).
//   2. window.location.href = "mailto:..." can fail silently on iOS
//      PWAs. Setting the <a>'s href and letting the native click
//      handler take over is much more reliable, plus we copy the
//      address to the clipboard and show a status so the user knows
//      if nothing happened.
async function _buildFeedbackParts() {
  let buildVer = "(no SW cache)";
  try {
    const keys = await caches.keys();
    buildVer = keys.find((k) => k.startsWith("narrative-shell")) || buildVer;
  } catch {}
  const ctx = [
    `URL:       ${location.href}`,
    `Build:     ${buildVer}`,
    `UA:        ${navigator.userAgent}`,
    `Window:    ${window.innerWidth}×${window.innerHeight}`,
    `Screen:    ${screen.width}×${screen.height}`,
    `Mode:      ${getUIMode()}`,
    `Playing:   ${_currentClipId ? `clip ${_currentClipId}` : "(no clip loaded)"}`,
    `When:      ${new Date().toISOString()}`,
  ].join("\n");
  const subject = "Narrative alpha feedback";
  const body =
    "What were you doing?\n" +
    "\n\n" +
    "What did you expect to happen?\n" +
    "\n\n" +
    "What actually happened?\n" +
    "\n\n" +
    "(Screenshot welcome — attach to this email)\n" +
    "\n" +
    "---\n" +
    "Auto-context (don't edit — helps me debug):\n" +
    ctx;
  return { subject, body };
}

// Prebake hrefs on Settings open so the links behave like native
// hyperlinks. Refreshed every open so the auto-context (build version,
// current clip, timestamp) stays current.
async function _refreshFeedbackHref() {
  try {
    const { subject, body } = await _buildFeedbackParts();
    const su = encodeURIComponent(subject);
    const bo = encodeURIComponent(body);
    settingsFeedbackLink.href = `mailto:${FEEDBACK_EMAIL}?subject=${su}&body=${bo}`;
    // Gmail compose URL — opens in a new tab via target="_blank" on the
    // <a>. `view=cm&fs=1` = "compose, full screen." `to` is a query
    // parameter here, so it DOES need encoding (unlike mailto).
    settingsFeedbackGmailLink.href =
      `https://mail.google.com/mail/?view=cm&fs=1` +
      `&to=${encodeURIComponent(FEEDBACK_EMAIL)}` +
      `&su=${su}&body=${bo}`;
  } catch {}
}

// Shared click feedback: copy the address to the clipboard and surface a
// status line so the user knows something happened — useful when the
// mail handler doesn't actually open (PWA restrictions, no default app,
// browser blocks the protocol).
async function _onFeedbackLinkClick(kind) {
  try {
    await navigator.clipboard?.writeText(FEEDBACK_EMAIL);
    setStatus(`Opening ${kind} to ${FEEDBACK_EMAIL} (also copied to clipboard).`);
  } catch {
    setStatus(`Opening ${kind} to ${FEEDBACK_EMAIL}.`);
  }
}

settingsFeedbackLink.addEventListener("click", () =>
  _onFeedbackLinkClick("mail app")
);
settingsFeedbackGmailLink.addEventListener("click", () =>
  _onFeedbackLinkClick("Gmail")
);

// v174: replay every onboarding tip + first-tap hint. Useful after
// dismissing one by accident — or when the user iterated through
// several builds and a stale flag from an earlier round is now
// suppressing a tip they want to see again. Wipes the known
// hint/tip localStorage keys (NOT the substantive state — voices,
// presets, library order, GitHub token, mode, theme, etc., all
// stay). After clearing, re-render the surfaces that read those
// flags so the user sees the change immediately without reload.
const _ONBOARDING_HINT_KEYS = [
  "narrative.firstClipTourSeen",
  "narrative.firstClipConfettiSeen",
  "narrative.dragHintDismissed",
  "narrative.voiceFavTipDismissed",
  // v219: Commercial-only filter chip first-tap hint.
  "narrative.voiceCommercialTipDismissed",
  // v220g: first-load attention pulse on the ? and ⚙ icons. Clearing
  // this re-arms the animation on the next page load — useful for
  // testing the onboarding flow without nuking IndexedDB.
  "narrative.helpAttentionSeen",
  "narrative.speakerAuditionTipDismissed",
  "narrative.speakerAuditionTipUsed",
  "narrative.hintSeen.speed",
  "narrative.hintSeen.sleep",
  "narrative.hintSeen.abloop",
  "narrative.hintSeen.playMode",
  "narrative.hintSeen.hidePlayed",
  "narrative.hintSeen.speakerAudition",
];
if (settingsResetHintsLink) {
  settingsResetHintsLink.addEventListener("click", (e) => {
    e.preventDefault();
    let cleared = 0;
    try {
      for (const k of _ONBOARDING_HINT_KEYS) {
        if (localStorage.getItem(k) !== null) {
          localStorage.removeItem(k);
          cleared += 1;
        }
      }
    } catch {}
    // Re-render every surface that reads the hint flags so the user
    // immediately sees a tip reappear (rather than having to reload).
    // renderLibrary() pulls the live clip count and calls
    // _updateFirstClipTour for us; the other tips re-render directly.
    // v178: also reset _lastSeenClipCount to 0 BEFORE renderLibrary
    // runs, so the next _updateFirstClipTour call sees a 0 → N
    // transition and confetti can re-fire. Without this, users who
    // upgraded with clips already on file (so prev jumped from -1
    // straight to N at v175 install) can never satisfy the gate even
    // after clearing the flag — they'd have to delete every clip
    // first. Resetting here makes "Replay onboarding tips" the
    // honest test path the button name promises.
    try {
      _lastSeenClipCount = 0;
      if (typeof renderLibrary === "function") renderLibrary();
      if (typeof _updateVoiceFavoritesTip === "function") _updateVoiceFavoritesTip();
      if (typeof _updateVoiceCommercialTip === "function") _updateVoiceCommercialTip();
      if (typeof _updateSpeakerAuditionTip === "function") {
        // Re-run with the current voice's speaker count so the banner
        // pops back if a high-count voice is selected.
        const n = _voiceSpeakerCounts.get(voiceEl.value) || 0;
        _updateSpeakerAuditionTip(n > SPEAKER_DROPDOWN_MAX ? n : 0);
      }
    } catch (err) { console.warn("reset hints re-render:", err); }
    setStatus(`Onboarding tips reset — ${cleared} flag${cleared === 1 ? "" : "s"} cleared.`);
  });
}

// ---- Debug log viewer --------------------------------------------------
// v177: surfaces the _debugLog ring buffer in a modal so the user can
// copy/download it when reporting "chapter X keeps failing" issues.
const debugLogDialog = $("debug-log-dialog");
const debugLogClose = $("debug-log-close");
const debugLogCount = $("debug-log-count");
const debugLogBody = $("debug-log-body");
const debugLogCopy = $("debug-log-copy");
const debugLogDownload = $("debug-log-download");
const debugLogClear = $("debug-log-clear");

function _formatDebugLogForDisplay() {
  if (_debugLog.length === 0) {
    return "(empty — no entries yet. Try a GitHub import or background queue to populate.)";
  }
  const lines = [];
  for (const e of _debugLog) {
    let line = `${e.t}  [${e.cat}]  ${e.msg}`;
    if (e.data !== undefined) {
      let dataStr = "";
      try { dataStr = JSON.stringify(e.data, null, 2); } catch { dataStr = String(e.data); }
      // Indent the data block so it visually associates with the line above.
      line += "\n" + dataStr.split("\n").map((l) => "  " + l).join("\n");
    }
    lines.push(line);
  }
  return lines.join("\n\n");
}

function _renderDebugLog() {
  if (debugLogCount) debugLogCount.textContent = String(_debugLog.length);
  if (debugLogBody) debugLogBody.textContent = _formatDebugLogForDisplay();
}

function openDebugLog() {
  _renderDebugLog();
  // Scroll to the bottom so the most recent entries (which are usually
  // what the user wants to see) are visible without manual scroll.
  if (debugLogBody) {
    requestAnimationFrame(() => {
      debugLogBody.scrollTop = debugLogBody.scrollHeight;
    });
  }
  if (debugLogDialog && !debugLogDialog.open) debugLogDialog.showModal();
}

if (settingsDebugLogLink) {
  settingsDebugLogLink.addEventListener("click", (e) => {
    e.preventDefault();
    // Close Settings first so the debug log opens on top cleanly.
    if (typeof settingsDialog !== "undefined" && settingsDialog.open) {
      settingsDialog.close();
    }
    openDebugLog();
  });
}
if (debugLogClose) {
  debugLogClose.addEventListener("click", () => debugLogDialog.close());
}
if (debugLogCopy) {
  debugLogCopy.addEventListener("click", async () => {
    const text = _formatDebugLogForDisplay();
    try {
      await navigator.clipboard.writeText(text);
      debugLogCopy.textContent = "Copied!";
      setTimeout(() => { debugLogCopy.textContent = "Copy"; }, 1500);
    } catch (err) {
      // Clipboard API blocked (insecure context / permissions). Fall
      // back to selecting the body so the user can ⌘C / Ctrl+C.
      try {
        const range = document.createRange();
        range.selectNodeContents(debugLogBody);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        debugLogCopy.textContent = "Selected — press Ctrl+C";
        setTimeout(() => { debugLogCopy.textContent = "Copy"; }, 2500);
      } catch {}
    }
  });
}
if (debugLogDownload) {
  debugLogDownload.addEventListener("click", () => {
    const text = _formatDebugLogForDisplay();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    // Local stamp without leaking seconds-precision: YYYY-MM-DDTHH-MM.
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:.]/g, "-");
    a.href = url;
    a.download = `narrative-debug-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
if (debugLogClear) {
  debugLogClear.addEventListener("click", () => {
    if (!confirm("Clear the debug log? This can't be undone.")) return;
    _debugLog.length = 0;
    _renderDebugLog();
  });
}

// ---- Streaming playback state -------------------------------------------
// While synthesis runs, each sentence's WAV arrives over SSE and we play
// them in sequence via the audio element. When the final `result` event
// arrives, we swap the player to the combined WAV at the current "virtual"
// position so seek / download / library work normally.
//
//   _streamQueue:     [{url, durationSec}, ...]  per-sentence blob URLs
//   _streamPlayhead:  index of the currently-playing sentence; -1 when
//                     not in streaming mode (idle, or after the swap)
//   _streamElapsed:   total seconds of *completed* sentences, used to
//                     compute virtualTime() across boundaries
let _streamQueue = [];
let _streamPlayhead = -1;
let _streamElapsed = 0;

function resetStream() {
  for (const item of _streamQueue) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
  _streamQueue = [];
  _streamPlayhead = -1;
  _streamElapsed = 0;
}

// Total seconds of audio logically played across sentence boundaries.
// During streaming, player.currentTime is local to the current sentence;
// after the swap to combined WAV, _streamPlayhead is -1 and we just use
// player.currentTime directly.
function virtualTime() {
  if (_streamPlayhead < 0) return playerEl.currentTime || 0;
  return _streamElapsed + (playerEl.currentTime || 0);
}

function startNextStreamSentence() {
  _streamPlayhead++;
  while (_streamPlayhead < _streamQueue.length && !_streamQueue[_streamPlayhead].url) {
    // Skip empty SAPI chunks so sentence indices still line up.
    _streamPlayhead++;
  }
  if (_streamPlayhead < _streamQueue.length) {
    playerEl.src = _streamQueue[_streamPlayhead].url;
    // Re-narrate suppresses streaming audio: the user shouldn't hear
    // Sarah's voice from sentence 0 onward while they were already
    // listening at sentence 5. Sentences keep queueing in the
    // background; playback resumes at the captured position via
    // _maybeStartRenarrateResume() as soon as we've synthesized far
    // enough to cover that point.
    if (!_regenSuppressStreaming) {
      playerEl.play().catch(() => {});
    }
  }
}

// During a re-narrate, called on every sentence event while playback is
// still suppressed. As soon as enough sentence offsets have arrived to
// know which sentence covers the resume position, hijack the stream:
// jump _streamPlayhead to that sentence, set _streamElapsed so
// virtualTime() math stays correct, load and play that sentence, then
// seek inside it to land at the captured resume time. The normal
// "ended → startNextStreamSentence" chain takes over from there, so
// subsequent sentences play in sequence and the eventual swap to
// combined audio just continues the same playhead.
function _maybeStartRenarrateResume(totalSentences) {
  const resume = _regenResumeAtSec;
  if (resume == null) return;

  // Find the sentence containing resume. A sentence covers [start, end)
  // where end is the start of the next sentence (or +Infinity for the
  // last one). We can only commit to a target when we either (a) know
  // the next sentence's offset, or (b) know this is the final sentence.
  let target = -1;
  for (let i = 0; i < sentenceOffsetsSec.length; i++) {
    const start = sentenceOffsetsSec[i];
    if (start === undefined) continue;
    const nextStart = sentenceOffsetsSec[i + 1];
    const isLast = i === totalSentences - 1;
    const end = nextStart !== undefined ? nextStart : (isLast ? Infinity : null);
    if (end == null) break; // can't determine yet — wait for more
    if (resume >= start && resume < end) {
      target = i;
      break;
    }
  }
  if (target < 0) return;

  // Skip empty (URL-less) targets — point at the next sentence with
  // audio. Edge case: resume falls inside an empty SAPI chunk; we drift
  // forward to the next playable sentence, which is the closest we can
  // get without a frame-accurate scrub through silence.
  let usable = target;
  while (
    usable < _streamQueue.length &&
    (!_streamQueue[usable] || !_streamQueue[usable].url)
  ) {
    usable++;
  }
  if (usable >= _streamQueue.length) return; // not queued yet — wait

  // Lock state to "playing from sentence usable" so the chain handlers
  // and highlight machinery work. _streamPlayhead is incremented inside
  // startNextStreamSentence, so we set it one below the target.
  _regenSuppressStreaming = false;
  _regenResumeAtSec = null;
  _streamPlayhead = usable - 1;
  _streamElapsed = sentenceOffsetsSec[usable] || 0;
  startNextStreamSentence();

  // Seek inside the loaded sentence to the intra-sentence offset so the
  // user lands AT the resume position, not at the start of the
  // containing sentence. Bound to loadedmetadata (currentTime isn't
  // honored until the audio's duration is known).
  const intra = Math.max(0, resume - (sentenceOffsetsSec[usable] || 0));
  if (intra > 0) {
    const seekInside = () => {
      try {
        if (isFinite(playerEl.duration)) {
          playerEl.currentTime = Math.min(intra, playerEl.duration);
        }
      } catch {}
    };
    playerEl.addEventListener("loadedmetadata", seekInside, { once: true });
  }
}

// ---- Playback speed -----------------------------------------------------
// Single cycling button; each tap advances to the next rate. Persisted in
// localStorage so it sticks across reloads, and reapplied on every
// loadedmetadata because the audio element can reset playbackRate when
// src changes (which happens often during streaming).
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
const SPEED_STORAGE_KEY = "narrative.playbackRate";

function _loadSavedSpeed() {
  const saved = parseFloat(localStorage.getItem(SPEED_STORAGE_KEY));
  return SPEEDS.includes(saved) ? saved : 1;
}

let _playbackRate = _loadSavedSpeed();

function _fmtSpeed(r) {
  // 1.0 → "1×", 1.25 → "1.25×"
  return `${Number.isInteger(r) ? r : r}×`;
}

function updateSpeedBtn() {
  speedBtn.textContent = _fmtSpeed(_playbackRate);
  // Rich tooltip: total length and wall-clock total at this speed.
  // Hover-only on desktop, long-press on touch; the visible
  // cp-time-effective annotation carries the same info for users
  // who never hover.
  const dur = isFinite(playerEl.duration) ? playerEl.duration : 0;
  if (_playbackRate === 1 || dur <= 0) {
    speedBtn.title = `Playback speed (currently ${_fmtSpeed(_playbackRate)})`;
  } else {
    const scaled = dur / _playbackRate;
    speedBtn.title =
      `Speed ${_fmtSpeed(_playbackRate)} · ` +
      `${_fmtDurationCoarse(dur)} → ${_fmtDurationCoarse(scaled)} at this speed`;
  }
}

function applyPlaybackRate() {
  if (isFinite(playerEl.playbackRate)) {
    playerEl.playbackRate = _playbackRate;
  }
}

// v150: first-tap hint for cycle chips. The Sleep / A↔B / Speed
// chips all cycle through internal states on tap, but a first-time
// tester sees the state change with no signal that more taps will
// keep cycling. _maybeChipHint returns a hint string the first time
// a given key is hit, then locks it; the chip handlers fire a
// follow-up setStatus 1.2s later so the original action status
// (e.g. "Sleep timer 15 min.") reads first and the hint reinforces.
function _maybeChipHint(key, message) {
  try {
    if (localStorage.getItem(key) === "1") return null;
    localStorage.setItem(key, "1");
    return message;
  } catch {
    return null;
  }
}
function _fireChipHint(key, message) {
  const hint = _maybeChipHint(key, message);
  if (hint) setTimeout(() => setStatus(hint), 1200);
}

speedBtn.addEventListener("click", () => {
  const i = SPEEDS.indexOf(_playbackRate);
  _playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
  try { localStorage.setItem(SPEED_STORAGE_KEY, String(_playbackRate)); } catch {}
  updateSpeedBtn();
  applyPlaybackRate();
  // Cycle speed → recompute the wall-clock remaining annotation.
  if (typeof _cpRefreshTime === "function") _cpRefreshTime();
  _fireChipHint(
    "narrative.hintSeen.speed",
    "💡 Tap again to cycle: 1× → 1.25× → 1.5× → 1.75× → 2× → 0.75×."
  );
});

updateSpeedBtn();
applyPlaybackRate();
// Re-apply on every src change — browsers sometimes reset playbackRate to 1
// when the audio source changes, which would break per-sentence streaming.
// Also re-render the speed tooltip + effective-remaining once duration
// is known (the values depend on it).
playerEl.addEventListener("loadedmetadata", () => {
  applyPlaybackRate();
  updateSpeedBtn();
  if (typeof _cpRefreshTime === "function") _cpRefreshTime();
});

// ---- Sleep timer --------------------------------------------------------
// Cycles through Off / 15 / 30 / 45 / 60 min. On expiry, fades the player
// volume to zero over 5 seconds and pauses. Volume is restored after the
// fade so the next manual play isn't silent. Wall-clock based, so audio
// keeps playing through phone PWA backgrounding even when setInterval
// gets throttled — `timeupdate` (which fires while audio plays) also
// checks the expiry, catching it within a few hundred ms in any case.
const SLEEP_DURATIONS_MIN = [0, 15, 30, 45, 60];
const SLEEP_FADE_MS = 5000;
// The sleep button cycle has one more state past the minute presets:
// "end of chapter" (when a chapter queue is active) or "end of clip"
// (when not). The distinction is wholly cosmetic — both stop at the
// next natural narrative boundary. Picked over minute timers when you
// know roughly where you are in a book but don't want to guess how
// long the chapter has left.
const SLEEP_IDX_END_OF_BOUNDARY = SLEEP_DURATIONS_MIN.length; // 5

let _sleepIdx = 0;          // index into the extended cycle (5 = end-of-boundary)
let _sleepExpiryMs = 0;     // 0 when idle; Date.now() target otherwise
let _sleepTickHandle = null;
let _sleepFadeHandle = null;
let _sleepFadeStartVol = null;  // saved so cancel/reset can restore
let _sleepEndOfChapter = false; // true when end-of-boundary mode is armed

function _formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function _updateSleepBtn() {
  if (_sleepEndOfChapter) {
    // Label shifts based on whether there's actually a chapter queue.
    // Same mode either way — "boundary" is whatever ends next.
    sleepBtn.textContent =
      _chapterTotalCount > 0 ? "💤 Chapter end" : "💤 Clip end";
    sleepBtn.classList.add("active");
    return;
  }
  if (_sleepExpiryMs <= 0) {
    sleepBtn.textContent = "Sleep";
    sleepBtn.classList.remove("active");
    return;
  }
  const remaining = _sleepExpiryMs - Date.now();
  sleepBtn.textContent = `💤 ${_formatCountdown(remaining)}`;
  sleepBtn.classList.add("active");
}

// Called when a natural narrative boundary completes while end-of-chapter
// sleep is armed. The audio has already finished (or is about to) so we
// don't need the volume fade the minute-timer expiry uses — just pause,
// reset the sleep state, and tell the user. The chapter-queue / library-
// auto-advance call sites guarantee they don't fire after this.
function _onSleepBoundaryReached(boundary) {
  _sleepEndOfChapter = false;
  _sleepIdx = 0;
  _updateSleepBtn();
  if (!playerEl.paused) _pauseAsUser();
  setStatus(`Sleep timer reached — paused at end of ${boundary}.`);
}

function _cancelSleepFade() {
  if (_sleepFadeHandle) clearInterval(_sleepFadeHandle);
  _sleepFadeHandle = null;
  if (_sleepFadeStartVol !== null) {
    playerEl.volume = _sleepFadeStartVol;
    _sleepFadeStartVol = null;
  }
}

function cancelSleepTimer() {
  if (_sleepTickHandle) clearInterval(_sleepTickHandle);
  _sleepTickHandle = null;
  _sleepExpiryMs = 0;
  // NOTE: _sleepEndOfChapter is NOT cleared here — startSleepTimer
  // calls cancelSleepTimer to wipe minute-mode state before switching
  // to a new minute count, but the click handler manages the
  // end-of-chapter flag explicitly so the two modes can't both be on.
  _cancelSleepFade();
  _updateSleepBtn();
}

function startSleepTimer(minutes) {
  cancelSleepTimer();
  _sleepExpiryMs = Date.now() + minutes * 60 * 1000;
  // Tick once per second for the countdown label; timeupdate will catch
  // expiry faster when audio is actively playing.
  _sleepTickHandle = setInterval(() => {
    if (Date.now() >= _sleepExpiryMs) {
      _onSleepExpired();
    } else {
      _updateSleepBtn();
    }
  }, 1000);
  _updateSleepBtn();
}

function _onSleepExpired() {
  if (_sleepTickHandle) clearInterval(_sleepTickHandle);
  _sleepTickHandle = null;
  _sleepExpiryMs = 0;

  // If we're already paused, nothing to fade — just reset UI.
  if (playerEl.paused) {
    _updateSleepBtn();
    setStatus("Sleep timer reached.");
    return;
  }

  // Linear fade from current volume to 0 over SLEEP_FADE_MS.
  _sleepFadeStartVol = playerEl.volume;
  const fadeStartAt = Date.now();
  _sleepFadeHandle = setInterval(() => {
    const elapsed = Date.now() - fadeStartAt;
    const ratio = Math.max(0, 1 - elapsed / SLEEP_FADE_MS);
    playerEl.volume = _sleepFadeStartVol * ratio;
    if (elapsed >= SLEEP_FADE_MS) {
      clearInterval(_sleepFadeHandle);
      _sleepFadeHandle = null;
      _pauseAsUser(); // intentional — don't auto-resume on next visibility
      // Restore volume so next manual play isn't silent.
      playerEl.volume = _sleepFadeStartVol;
      _sleepFadeStartVol = null;
      _updateSleepBtn();
      setStatus("Sleep timer reached — paused.");
    }
  }, 100);
  _updateSleepBtn();
}

sleepBtn.addEventListener("click", () => {
  _fireChipHint(
    "narrative.hintSeen.sleep",
    "💡 Tap Sleep again to cycle: 15 / 30 / 45 / 60 min · end of chapter · off."
  );
  // Cycle is Off → 15 → 30 → 45 → 60 → End-of-boundary → Off.
  // SLEEP_IDX_END_OF_BOUNDARY (5) is the final slot before wrapping.
  _sleepIdx = (_sleepIdx + 1) % (SLEEP_DURATIONS_MIN.length + 1);

  if (_sleepIdx === 0) {
    _sleepEndOfChapter = false;
    cancelSleepTimer();
    setStatus("Sleep timer off.");
    return;
  }

  if (_sleepIdx === SLEEP_IDX_END_OF_BOUNDARY) {
    // End-of-boundary mode. Clear any running minute timer; the natural
    // boundary will trigger _onSleepBoundaryReached.
    cancelSleepTimer();
    _sleepEndOfChapter = true;
    _updateSleepBtn();
    setStatus(
      _chapterTotalCount > 0
        ? "Sleep set for end of chapter."
        : "Sleep set for end of clip."
    );
    return;
  }

  // Minute presets.
  _sleepEndOfChapter = false;
  const minutes = SLEEP_DURATIONS_MIN[_sleepIdx];
  startSleepTimer(minutes);
  setStatus(`Sleep timer set for ${minutes} min.`);
});

// Belt-and-suspenders: `timeupdate` keeps firing during playback (including
// from the PWA's lock-screen MediaSession control flow), so we'll catch the
// expiry promptly even if setInterval is throttled in the background.
playerEl.addEventListener("timeupdate", () => {
  if (_sleepExpiryMs > 0 && Date.now() >= _sleepExpiryMs) {
    _onSleepExpired();
  }
});

_updateSleepBtn();

// ---- A-B loop -----------------------------------------------------------
// Tap the chip to mark A (current time), tap again to mark B and start
// looping between them, tap a third time to clear. Useful for re-listening
// to a tricky passage (language practice, study, writers checking rhythm,
// listeners re-hearing a complex paragraph).
//
// State machine:
//   _loopA = null, _loopB = null     → idle, label "A↔B"
//   _loopA set,    _loopB = null     → "A 1:23", waiting for B
//   _loopA set,    _loopB set        → looping, label "↻ 1:23–2:45", accent bg
//
// While looping is active, a timeupdate guard seeks back to A whenever
// currentTime crosses B. Switching clips clears the loop (the bounds
// belonged to a different audio track).
let _loopA = null;
let _loopB = null;

function _updateAbBtn() {
  if (_loopA == null) {
    abLoopBtn.textContent = "A↔B";
    abLoopBtn.classList.remove("active");
  } else if (_loopB == null) {
    abLoopBtn.textContent = `A ${formatTime(_loopA)}`;
    abLoopBtn.classList.remove("active");
  } else {
    abLoopBtn.textContent = `↻ ${formatTime(_loopA)}–${formatTime(_loopB)}`;
    abLoopBtn.classList.add("active");
  }
}

function clearAbLoop() {
  _loopA = null;
  _loopB = null;
  _updateAbBtn();
}

abLoopBtn.addEventListener("click", () => {
  const here = virtualTime();
  if (_loopA == null) {
    _loopA = here;
  } else if (_loopB == null) {
    // v220v: B must be at least ~0.5s past A. Previously a 2nd tap at
    // the same time silently RESET A to here, leaving the label looking
    // unchanged ("A 1:23" → "A 1:23"). Tester reported "only first tap
    // works" — they were tapping rapidly while paused, expecting both
    // bounds to set in two taps. New behavior: keep A where it is, show
    // a status that tells the user what to do. The next tap (after they
    // seek or play forward) sets B and starts the loop.
    if (here <= _loopA + 0.5) {
      setStatus(
        `A is at ${formatTime(_loopA)}. Play forward (or seek), then tap A↔B to set B.`
      );
      return;
    }
    _loopB = here;
  } else {
    // Third tap clears.
    _loopA = null;
    _loopB = null;
  }
  _updateAbBtn();
  _fireChipHint(
    "narrative.hintSeen.abloop",
    "💡 Tap once at A · play forward · tap again at B · tap again to clear."
  );
});

// Loop enforcement: when both bounds are set, seek back to A whenever the
// playhead crosses B. timeupdate fires ~4 times/sec during playback, which
// is enough granularity that the user won't hear past B.
playerEl.addEventListener("timeupdate", () => {
  if (_loopA == null || _loopB == null) return;
  if (virtualTime() >= _loopB) {
    seekToTime(_loopA);
  }
});

_updateAbBtn();

// ---- Listen statistics --------------------------------------------------
// Buckets listen seconds by day, voice, and clip. Drives the Settings
// stats panel ("Today / This week / All-time / Top voice / Most listened").
// All wall-clock at 1× speed equivalent: we add playerEl.currentTime
// deltas while playing, so a 23-minute audiobook listened at 1.5× counts
// as ~15 minutes — the "how much content you got through" view, not the
// "how long you were doing it" view. The former is what users care about.
const STATS_KEY = "narrative.stats";
const STATS_SCHEMA = 1;

function _emptyStats() {
  return { schema: STATS_SCHEMA, daily: {}, voices: {}, clips: {}, total: 0 };
}

function _loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return _emptyStats();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== STATS_SCHEMA) return _emptyStats();
    return {
      schema: STATS_SCHEMA,
      daily: parsed.daily || {},
      voices: parsed.voices || {},
      clips: parsed.clips || {},
      total: Number(parsed.total) || 0,
    };
  } catch {
    return _emptyStats();
  }
}

let _stats = _loadStats();
let _statsDirty = false;
let _lastListenTime = -1; // playerEl.currentTime at last accumulator tick

function _flushStats() {
  if (!_statsDirty) return;
  try { localStorage.setItem(STATS_KEY, JSON.stringify(_stats)); } catch {}
  _statsDirty = false;
}

function _todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Prune day buckets older than 60 days so the JSON blob can't grow without
// bound. All-time total + voices + clips are not pruned (those are
// cumulative). Returns the pruned stats.
function _pruneOldDays(stats) {
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(stats.daily)) {
    const parsed = Date.parse(key + "T00:00:00");
    if (isFinite(parsed) && parsed < cutoff) delete stats.daily[key];
  }
  return stats;
}

function _recordListenDelta(deltaSec, clipId, voiceId) {
  // Sanity gate: clip negative deltas (seek backwards), oversized deltas
  // (resume after pause, tab backgrounded), and tiny noise. Tab throttling
  // can fire timeupdate after a long pause — the resume looks like a
  // huge jump; we don't want to credit the user for the time they were
  // away.
  if (!isFinite(deltaSec) || deltaSec <= 0 || deltaSec > 2) return;
  const today = _todayKey();
  _stats.daily[today] = (_stats.daily[today] || 0) + deltaSec;
  _stats.total += deltaSec;
  if (voiceId) {
    _stats.voices[voiceId] = (_stats.voices[voiceId] || 0) + deltaSec;
  }
  if (clipId != null) {
    const k = String(clipId);
    _stats.clips[k] = (_stats.clips[k] || 0) + deltaSec;
  }
  _statsDirty = true;
}

playerEl.addEventListener("play", () => {
  // Reset the delta tracker so the first post-play tick doesn't credit
  // a giant jump from wherever the head was last.
  _lastListenTime = playerEl.currentTime || 0;
});

playerEl.addEventListener("pause", () => {
  _lastListenTime = -1;
  _flushStats();
});

playerEl.addEventListener("seeking", () => {
  // Discard the in-progress delta — the next post-seek timeupdate will
  // re-anchor _lastListenTime to the new position.
  _lastListenTime = -1;
});

playerEl.addEventListener("timeupdate", () => {
  if (playerEl.paused) return;
  const now = playerEl.currentTime || 0;
  if (_lastListenTime < 0) {
    _lastListenTime = now;
    return;
  }
  const delta = now - _lastListenTime;
  _lastListenTime = now;
  // Attribute to the voice the loaded clip was synthesized with; the
  // picker can drift mid-playback if the user starts tweaking for the
  // next clip while the current one plays.
  _recordListenDelta(delta, _currentClipId, _currentPlayingVoiceId);
});

// Periodic flush so the user can close the tab and not lose listen time.
setInterval(_flushStats, 10_000);
window.addEventListener("beforeunload", _flushStats);
window.addEventListener("pagehide", _flushStats);

function _statsTodaySec() {
  return _stats.daily[_todayKey()] || 0;
}

function _statsWeekSec() {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    total += _stats.daily[k] || 0;
  }
  return total;
}

function _statsTopVoiceId() {
  let best = null;
  let bestSec = 0;
  for (const [k, v] of Object.entries(_stats.voices)) {
    if (v > bestSec) { bestSec = v; best = k; }
  }
  return best;
}

function _statsTopClipId() {
  let best = null;
  let bestSec = 0;
  for (const [k, v] of Object.entries(_stats.clips)) {
    if (v > bestSec) { bestSec = v; best = k; }
  }
  return best;
}

// Format seconds as "12 min" / "3h 20m" / "1d 4h" — punchier than
// formatTime's M:SS for stats that span hours / days.
function _formatStatsDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} sec`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 24 * 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / (24 * 3600));
  const h = Math.round((sec % (24 * 3600)) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function _resetStats() {
  _stats = _emptyStats();
  _statsDirty = true;
  _flushStats();
  _lastListenTime = -1;
}

// Stats panel inside the Settings dialog. Pulls the latest numbers,
// resolves voice display name + top clip title, and hides the bottom
// extras + Reset button until there's actually been some listening.
async function _renderStatsPanel() {
  const todayEl = $("stats-today");
  const weekEl = $("stats-week");
  const totalEl = $("stats-total");
  const topVoiceEl = $("stats-top-voice");
  const topClipEl = $("stats-top-clip");
  const extrasEl = $("stats-extras");
  const emptyEl = $("stats-empty");
  const resetBtn = $("stats-reset");

  todayEl.textContent = _formatStatsDuration(_statsTodaySec());
  weekEl.textContent = _formatStatsDuration(_statsWeekSec());
  totalEl.textContent = _formatStatsDuration(_stats.total);

  const hasAny = _stats.total > 0;
  emptyEl.hidden = hasAny;
  extrasEl.hidden = !hasAny;
  resetBtn.hidden = !hasAny;
  if (!hasAny) return;

  // Top voice — display name preferred over the raw voice_id slug. The
  // <select> options carry friendly labels; fall back to the id if it's
  // not in the picker (e.g. an installed voice that was removed).
  const topVoiceId = _statsTopVoiceId();
  if (topVoiceId) {
    let label = topVoiceId;
    const opt = voiceEl.querySelector(`option[value="${CSS.escape(topVoiceId)}"]`);
    if (opt && opt.textContent) label = opt.textContent;
    topVoiceEl.textContent = label;
  } else {
    topVoiceEl.textContent = "—";
  }

  // Top clip — resolve via IndexedDB. If it was deleted, fall through.
  const topClipId = _statsTopClipId();
  if (topClipId) {
    try {
      const clip = await getClip(Number(topClipId));
      topClipEl.textContent = clip?.title || `Clip ${topClipId}`;
    } catch {
      topClipEl.textContent = `Clip ${topClipId}`;
    }
  } else {
    topClipEl.textContent = "—";
  }
}

// Reset stats. No native confirm() — keeps the dialog focused. Click the
// button once to arm ("Tap again to confirm"), again within 4 sec to wipe.
(() => {
  const resetBtn = $("stats-reset");
  let armed = false;
  let armTimer = null;
  const original = "Reset stats";
  resetBtn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      resetBtn.textContent = "Tap again to confirm";
      resetBtn.style.color = "var(--danger)";
      armTimer = setTimeout(() => {
        armed = false;
        resetBtn.textContent = original;
        resetBtn.style.color = "";
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    resetBtn.textContent = original;
    resetBtn.style.color = "";
    _resetStats();
    _renderStatsPanel();
  });
})();

// ---- Bookmarks ----------------------------------------------------------
// Drop a timestamp on the currently-loaded clip while you're listening.
// Each bookmark gets an optional note (typed inline, no modal — the
// "Add a note…" placeholder reads as a hint without forcing a dialog).
// Bookmarks live as clip.bookmarks[] in IndexedDB and survive export/import.

async function addBookmarkAtCurrentTime() {
  if (!_currentClipId) {
    setStatus("Load a clip first — nothing to bookmark.", true);
    return;
  }
  try {
    const clip = await getClip(_currentClipId);
    if (!clip) return;
    const t = virtualTime();
    if (!Array.isArray(clip.bookmarks)) clip.bookmarks = [];
    clip.bookmarks.push({
      id: Date.now(),
      timeSec: t,
      note: "",
      createdAt: new Date().toISOString(),
    });
    // Keep the list sorted by timestamp so display order matches audio order.
    clip.bookmarks.sort((a, b) => a.timeSec - b.timeSec);
    await saveClip(clip);
    await renderBookmarks();
    // v210 (M6.1): if the book view is open, re-stash bookmarks +
    // re-render the current spread so the new ribbon shows up
    // immediately on the bookmarked page.
    if (_bookViewSource && typeof bookView !== "undefined" && bookView && !bookView.hidden) {
      _bookViewSource.bookmarks = clip.bookmarks;
      _bookViewRenderSpread(_bookViewCurrentSpread);
    }
    setStatus(`Bookmark added at ${formatTime(t)}.`);
  } catch (e) {
    console.warn("bookmark add failed:", e);
    setStatus(`Bookmark failed: ${e.message}`, true);
  }
}

async function updateBookmarkNote(bookmarkId, newNote) {
  if (!_currentClipId) return;
  try {
    const clip = await getClip(_currentClipId);
    if (!clip || !Array.isArray(clip.bookmarks)) return;
    const bm = clip.bookmarks.find((b) => b.id === bookmarkId);
    if (!bm) return;
    bm.note = newNote;
    await saveClip(clip);
    // No re-render needed; the user already sees their typed note.
  } catch (e) {
    console.warn("bookmark note save failed:", e);
  }
}

async function deleteBookmark(bookmarkId) {
  if (!_currentClipId) return;
  try {
    const clip = await getClip(_currentClipId);
    if (!clip || !Array.isArray(clip.bookmarks)) return;
    clip.bookmarks = clip.bookmarks.filter((b) => b.id !== bookmarkId);
    await saveClip(clip);
    await renderBookmarks();
  } catch (e) {
    console.warn("bookmark delete failed:", e);
  }
}

// Move the playhead to time `t` (in seconds within the clip's full timeline).
// Handles both streaming mode (jump to the per-sentence WAV that covers t,
// then nudge currentTime to the intra-sentence offset) and post-swap mode
// (direct currentTime). Used by bookmark jump.
function seekToTime(t) {
  t = Math.max(0, Number(t) || 0);
  if (_streamPlayhead >= 0 && sentenceOffsetsSec.length) {
    const idx = currentSentenceIndex(t);
    if (idx >= 0 && idx < _streamQueue.length) {
      const sentenceStart = sentenceOffsetsSec[idx] || 0;
      const intra = Math.max(0, t - sentenceStart);
      // Use the existing sentence-seek path to load the right per-sentence
      // WAV, then advance inside it once its metadata is ready.
      seekToSentence(idx);
      const onLoad = () => {
        playerEl.removeEventListener("loadedmetadata", onLoad);
        try {
          const cap = isFinite(playerEl.duration) ? playerEl.duration : intra;
          playerEl.currentTime = Math.min(cap, intra);
        } catch {}
      };
      playerEl.addEventListener("loadedmetadata", onLoad);
    }
    return;
  }
  // Post-swap / combined-WAV: direct currentTime move.
  try {
    const cap = isFinite(playerEl.duration) ? playerEl.duration : t;
    playerEl.currentTime = Math.min(cap, t);
  } catch {}
}

async function renderBookmarks() {
  bookmarksList.innerHTML = "";
  let bookmarks = [];
  if (_currentClipId) {
    try {
      const clip = await getClip(_currentClipId);
      if (clip && Array.isArray(clip.bookmarks)) bookmarks = clip.bookmarks;
    } catch {}
  }

  // Update the chip label so the bookmark count is visible even when the
  // list is scrolled out of view.
  bookmarkAddBtn.textContent =
    bookmarks.length > 0 ? `🔖 Bookmark · ${bookmarks.length}` : "🔖 Bookmark";

  if (bookmarks.length === 0) {
    bookmarksList.hidden = true;
    return;
  }
  bookmarksList.hidden = false;

  for (const bm of bookmarks) {
    const row = document.createElement("div");
    row.className = "bookmark-row";

    const timeBtn = document.createElement("button");
    timeBtn.type = "button";
    timeBtn.className = "bookmark-time";
    timeBtn.textContent = formatTime(bm.timeSec);
    timeBtn.title = `Jump to ${formatTime(bm.timeSec)}`;
    timeBtn.addEventListener("click", () => {
      seekToTime(bm.timeSec);
      playerEl.play().catch(() => {});
    });

    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "bookmark-note";
    noteInput.value = bm.note || "";
    noteInput.maxLength = 200;
    noteInput.placeholder = "Add a note…";
    noteInput.addEventListener("change", () => {
      updateBookmarkNote(bm.id, noteInput.value.trim());
    });
    noteInput.addEventListener("keydown", (e) => {
      // Enter saves + blurs (which triggers the change handler above).
      // Escape reverts to the saved value and blurs.
      if (e.key === "Enter") {
        e.preventDefault();
        noteInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        noteInput.value = bm.note || "";
        noteInput.blur();
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "bookmark-delete";
    delBtn.textContent = "×";
    delBtn.title = "Delete bookmark";
    delBtn.setAttribute("aria-label", `Delete bookmark at ${formatTime(bm.timeSec)}`);
    delBtn.addEventListener("click", () => deleteBookmark(bm.id));

    row.append(timeBtn, noteInput, delBtn);
    bookmarksList.appendChild(row);
  }
}

bookmarkAddBtn.addEventListener("click", addBookmarkAtCurrentTime);

// ---- Configurable skip-back / skip-forward ------------------------------
// Quick recovery for "I zoned out for a moment" + its mirror for "okay
// I got that, move me along." Separate from the MediaSession sentence
// skip on the lock screen (that one jumps a whole sentence, which is
// overkill when you just missed a word).
//
// The interval is user-configurable from Settings — authors revising
// their own prose want a tight 2s for re-hearing a tricky line; a
// commuter listening to a long article wants 30s for skipping ahead.
const SKIP_INTERVAL_KEY = "narrative.skipInterval";
const SKIP_INTERVALS = [2, 5, 10, 15, 30];
const DEFAULT_SKIP_INTERVAL = 5;

function _loadSkipInterval() {
  const raw = parseInt(localStorage.getItem(SKIP_INTERVAL_KEY), 10);
  return SKIP_INTERVALS.includes(raw) ? raw : DEFAULT_SKIP_INTERVAL;
}

let _skipInterval = _loadSkipInterval();
const skipForwardBtn = $("skip-forward-btn");

function _applySkipInterval() {
  const n = _skipInterval;
  skipBackBtn.textContent = `↶ ${n}s`;
  skipBackBtn.setAttribute("aria-label", `Skip back ${n} seconds`);
  skipBackBtn.title = `Skip back ${n} seconds`;
  skipForwardBtn.textContent = `${n}s ↷`;
  skipForwardBtn.setAttribute("aria-label", `Skip forward ${n} seconds`);
  skipForwardBtn.title = `Skip forward ${n} seconds`;
}

function setSkipInterval(n) {
  if (!SKIP_INTERVALS.includes(n)) return;
  _skipInterval = n;
  try { localStorage.setItem(SKIP_INTERVAL_KEY, String(n)); } catch {}
  _applySkipInterval();
}

skipBackBtn.addEventListener("click", () => {
  // Use seekToTime so streaming mode + combined-WAV mode are both handled,
  // and the math is in terms of the virtual timeline (not whatever
  // per-sentence WAV happens to be loaded right now).
  const here = virtualTime();
  seekToTime(Math.max(0, here - _skipInterval));
});

skipForwardBtn.addEventListener("click", () => {
  // seekToTime already clamps to playerEl.duration on the way out, so
  // overshooting the end is a no-op rather than an error.
  const here = virtualTime();
  seekToTime(here + _skipInterval);
});

_applySkipInterval();

// ---- Sticky mini player -------------------------------------------------
// Shows a slim "now playing" bar at the top of the viewport once the main
// player card has scrolled off-screen, so play / pause / seek-back-to-
// player stay one tap away while you're scrolling through the library.
//
// Visibility is driven by an IntersectionObserver watching the main player
// card. The mini player mirrors playerEl state — it doesn't have its own
// audio. State sync flows: playerEl events → _updateMini*().
const miniPlayer = $("mini-player");
const miniPlayPause = $("mini-play-pause");
const miniInfo = $("mini-info");
const miniTitleEl = $("mini-title");
const miniTimeEl = $("mini-time");
const miniScrollUpBtn = $("mini-scroll-up");
const miniProgressFill = $("mini-progress-fill");

function _updateMiniPlayerState() {
  miniPlayPause.textContent = playerEl.paused ? "▶" : "⏸";
  const cur = virtualTime();
  // Prefer the cached duration from sentence offsets (works in streaming
  // mode too), otherwise fall back to playerEl.duration.
  const dur = isFinite(playerEl.duration) && playerEl.duration > 0
    ? playerEl.duration
    : 0;
  miniTimeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  if (dur > 0) {
    const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
    miniProgressFill.style.width = `${pct}%`;
  } else {
    miniProgressFill.style.width = "0%";
  }
}

async function _updateMiniPlayerTitle() {
  if (!_currentClipId) {
    miniTitleEl.textContent = "Generating…";
    return;
  }
  try {
    const clip = await getClip(_currentClipId);
    if (clip) {
      miniTitleEl.textContent = clip.title || "(untitled)";
      miniTitleEl.title = clip.title || "";
    }
  } catch {}
}

// IntersectionObserver: slide the mini player in when the main player card
// has scrolled OFF THE TOP of the viewport — meaning the user has scrolled
// *past* it. Don't show it when the player is below the viewport (page
// just loaded and the user hasn't reached the player yet) — otherwise the
// mini bar covers the Narrative hero + ⚙ Settings button.
//
// boundingClientRect.bottom < 0 means the player is entirely above the
// viewport (scrolled past). bottom > 0 with !isIntersecting means it's
// below the viewport (not yet reached).
const _miniObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const scrolledPast = entry.boundingClientRect.bottom < 0;
      const shouldShow = !entry.isIntersecting && scrolledPast && !playerCard.hidden;
      if (shouldShow) {
        miniPlayer.hidden = false;
        // Force a layout pass so the browser registers the starting
        // transform before we toggle data-visible — without this, the
        // first show-on-page-load skips the slide-in animation.
        void miniPlayer.offsetHeight;
        miniPlayer.dataset.visible = "true";
        _updateMiniPlayerState();
        _updateMiniPlayerTitle();
      } else {
        miniPlayer.dataset.visible = "false";
        // Wait for the slide-out transition (matches the CSS duration)
        // before hiding so the bar doesn't pop out abruptly.
        setTimeout(() => {
          if (miniPlayer.dataset.visible !== "true") miniPlayer.hidden = true;
        }, 280);
      }
    }
  },
  { threshold: 0 }
);
_miniObserver.observe(playerCard);

miniPlayPause.addEventListener("click", () => {
  if (playerEl.paused) playerEl.play().catch(() => {});
  else _pauseAsUser();
});

// Tap the title block OR the explicit ↑ button to jump back to the full
// player card. The title block is the bigger hit-target on phone.
function _scrollToPlayer() {
  playerCard.scrollIntoView({ behavior: "smooth", block: "start" });
}
miniScrollUpBtn.addEventListener("click", _scrollToPlayer);
miniInfo.addEventListener("click", _scrollToPlayer);

playerEl.addEventListener("timeupdate", _updateMiniPlayerState);
playerEl.addEventListener("play", _updateMiniPlayerState);
playerEl.addEventListener("pause", _updateMiniPlayerState);
playerEl.addEventListener("loadedmetadata", _updateMiniPlayerState);

// ---- Resume position ---------------------------------------------------
// Per-clip "remember where I left off." Saved into the existing IndexedDB
// row by mutating clip.progressSec; throttled so we're not hitting the DB
// every timeupdate.

async function maybeSaveProgress(force = false) {
  if (!_currentClipId) return;
  // Don't try to save during streaming — the offsets are local to the
  // current sentence's WAV, not the whole clip. We'll start saving once
  // the swap to combined WAV happens (_streamPlayhead drops back to -1).
  if (_streamPlayhead >= 0) return;
  if (!isFinite(playerEl.currentTime)) return;
  const now = Date.now();
  if (!force && now - _lastProgressSaveAt < PROGRESS_SAVE_INTERVAL_MS) return;
  _lastProgressSaveAt = now;
  try {
    const clip = await getClip(_currentClipId);
    if (!clip) return;
    clip.progressSec = playerEl.currentTime;
    await saveClip(clip);
  } catch (e) {
    console.warn("progress save failed:", e);
  }
}

async function markCurrentClipPlayed() {
  if (!_currentClipId) return;
  try {
    const clip = await getClip(_currentClipId);
    if (!clip) return;
    clip.progressSec = 0;
    // Stamp the completion time so the "Hide played" library filter has
    // something to key off. We can't distinguish "never played" from
    // "played and reset" via progressSec alone (both are 0).
    clip.playedAt = new Date().toISOString();
    await saveClip(clip);
    renderLibrary();
  } catch (e) {
    console.warn("mark-played failed:", e);
  }
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

function enterBusyState() {
  // Switch button to "Cancel" mode — still clickable to abort.
  generateBtn.classList.replace("primary", "secondary");
  genLabel.textContent = "Cancel";
  genSpinner.hidden = false;
  synthProgress.value = 0;
  synthProgress.hidden = false;
  downloadBtn.disabled = true;
}

function exitBusyState() {
  generateBtn.classList.replace("secondary", "primary");
  genLabel.textContent = "Generate";
  genSpinner.hidden = true;
  synthProgress.hidden = true;
  if (lastBlob) downloadBtn.disabled = false;
}

function _countWords(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return 0;
  // Split on any whitespace; the regex handles tabs / newlines / multiple
  // spaces in one shot. Matches what most writing apps report.
  return trimmed.split(/\s+/).length;
}

function _estimateReadSeconds(words, wpm) {
  if (!words || !wpm) return 0;
  return (words / wpm) * 60;
}

function updateCounts() {
  const text = textEl.value;
  const len = text.length;
  let label = `${len.toLocaleString()} / 500,000`;

  // Author-mode extras: word count + read-aloud time estimate. Hidden by
  // default so a reader who's pasting articles doesn't see writing stats
  // they don't care about.
  if (isAuthorMode()) {
    const words = _countWords(text);
    const wpm = Number(rateEl.value) || 180;
    const sec = _estimateReadSeconds(words, wpm);
    if (words > 0) {
      label += ` · ${words.toLocaleString()} words · ~${formatTime(sec)} at ${wpm} wpm`;
    } else {
      label += ` · 0 words`;
    }
  }

  charCountEl.textContent = label;

  // The filler chip strip rebuilds on every keystroke. CSS gates author-
  // only visibility so this DOM stays empty / hidden for readers — but
  // running the counter is essentially free, so we don't branch on
  // isAuthorMode here.
  _renderFillerChips(text);
}

// ---- Filler-word callout (Author mode) ---------------------------------
// Common crutch words. Singular & easy to extend — the regex is built
// from this list at module load. Multi-word entries ("kind of", "sort
// of") need the regex to allow a single space inside the match.
const FILLER_WORDS = [
  "just",
  "very",
  "really",
  "actually",
  "basically",
  "literally",
  "that",
  "even",
  "somehow",
  "perhaps",
  "quite",
  "simply",
  "rather",
  "maybe",
  "totally",
  "definitely",
  "honestly",
  "obviously",
  "kind of",
  "sort of",
];

// Pre-build one big alternation. Word boundaries on both ends so "thatch"
// doesn't count as "that". `gi` flags for global + case-insensitive.
const _FILLER_RE = new RegExp(
  "\\b(" +
    FILLER_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|") +
    ")\\b",
  "gi"
);

function _countFillerWords(text) {
  const counts = new Map();
  if (!text) return counts;
  const matches = text.match(_FILLER_RE);
  if (!matches) return counts;
  for (const raw of matches) {
    // Normalize internal whitespace so "kind  of" and "kind of" collapse,
    // and lowercase so "Just" and "just" aggregate.
    const key = raw.toLowerCase().replace(/\s+/g, " ");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

const fillerCountsEl = $("filler-counts");
// Cap visible chips so a long manuscript doesn't fill the screen. Top-N
// by count is the useful signal — the long tail is noise.
const FILLER_TOP_N = 8;

function _renderFillerChips(text) {
  const counts = _countFillerWords(text);
  if (counts.size === 0) {
    fillerCountsEl.hidden = true;
    fillerCountsEl.innerHTML = "";
    return;
  }
  // Stable ordering: count desc, then alphabetical so equal counts don't
  // jitter as the user types.
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, FILLER_TOP_N);

  fillerCountsEl.innerHTML = "";
  for (const [word, n] of sorted) {
    const chip = document.createElement("span");
    chip.className = "filler-chip";
    const label = document.createElement("span");
    label.className = "filler-word";
    label.textContent = word;
    const num = document.createElement("strong");
    num.textContent = String(n);
    chip.append(label, num);
    fillerCountsEl.appendChild(chip);
  }
  fillerCountsEl.hidden = false;
}

rateEl.addEventListener("input", () => {
  rateValueEl.textContent = rateEl.value;
  // Author mode shows "~M:SS at N wpm" in the textarea meta — the
  // estimate depends on the current rate, so refresh it as the slider moves.
  if (isAuthorMode()) updateCounts();
});

volumeEl.addEventListener("input", () => {
  volumeValueEl.textContent = `${volumeEl.value}%`;
});

textEl.addEventListener("input", () => {
  updateCounts();
  _updateEmptyState();
});
updateCounts();

// v149: first-run empty-state. Originally gated to "user has NEVER
// generated a clip" — but a tester with 11 clips in their library
// landed on an empty textarea between sessions and didn't know what
// to do (v220b feedback). The Import ▼ dropdown in the card header
// is too quiet to be the only orientation cue. Show the cards
// whenever the textarea is empty + no current clip + not in reading
// view; adapt the head text so returning users don't see the
// "New to Narrative?" welcome.
function _updateEmptyState() {
  if (!emptyStateEl) return;
  // Reading view active → the user is listening to something already.
  // Clip loaded → not the empty case either. Suppress in both cases.
  const hasText = (textEl.value || "").trim().length > 0;
  const inReadingView = !textEl.parentNode || textEl.hidden;
  const show = !hasText && !_currentClipId && !inReadingView;
  emptyStateEl.hidden = !show;
  // v220b: swap the head text based on user state. First-time users
  // get the welcome; returning users get a compact "next thing to do"
  // prompt so the empty state reads as a quick-pick row, not an
  // onboarding splash they've already moved past.
  if (show) {
    const head = emptyStateEl.querySelector(".empty-state-head");
    if (head) {
      head.textContent = _libraryHasClips
        ? "Start a new clip:"
        : "New to Narrative? Try one of these to get started.";
    }
  }
}
// Card clicks reuse the existing Import-dropdown paths so the action
// behavior stays in one place (no duplicate file pickers, no
// duplicate showUrlRow callers).
// v220c: short demo paragraph used by the "Try sample text" empty-state
// card. Chosen to (a) have rich-enough prosody to showcase the voice,
// (b) include a comma + a question + a name so the prosody differences
// vs ElevenLabs-style voices are audible, and (c) be short enough that
// a brand-new user hears the synth complete in under 20 seconds.
const _SAMPLE_TEXT =
  "Welcome to Narrative. I'm a sample paragraph, here so you can hear " +
  "what this voice sounds like before you paste your own text. Try " +
  "swapping the voice in the top-right corner, or change the speed " +
  "and volume sliders below. Then come back and replace me with your " +
  "own chapter, article, or note — and hit Generate.";

document.querySelectorAll("[data-empty-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.emptyAction;
    if (action === "url") {
      if (urlRow.hidden) showUrlRow({ placeholder: "https://… (article URL)" });
      else urlInput.focus();
    } else if (action === "file") {
      uploadInput.click();
    } else if (action === "github") {
      showUrlRow({
        placeholder: "github.com/owner/repo",
        prefill: "https://github.com/",
        hint:
          'Paste the <strong>repo root</strong> — like ' +
          '<code>github.com/owner/repo</code> — not a link to a ' +
          'specific file. We\'ll open a picker so you can choose ' +
          'which chapters to import.',
      });
    } else if (action === "sample") {
      // v220c: paste sample text + focus the textarea (cursor lands
      // at end) + scroll to the Generate button. Re-runs the empty-
      // state check so the cards hide now that there's text, and
      // updates the live word-count chip. setStatus gives a one-line
      // breadcrumb pointing at what to do next.
      textEl.value = _SAMPLE_TEXT;
      textEl.focus();
      textEl.setSelectionRange(_SAMPLE_TEXT.length, _SAMPLE_TEXT.length);
      updateCounts();
      _updateEmptyState();
      const genBtn = document.getElementById("generate");
      if (genBtn) genBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setStatus("Sample text loaded — hit Generate to hear it.");
    }
  });
});

// voice_id → num_speakers, populated from /api/voices. Used by onVoiceChange
// to decide whether to surface the speaker picker. SAPI voices and most
// Piper voices have num_speakers=1; LibriTTS is the headline 904-speaker model.
const _voiceSpeakerCounts = new Map();

// Tracks the "voices haven't loaded yet" state so generate() can show a
// different (gentler) error when the user clicks Generate during a retry
// loop versus when no voice is genuinely selectable. Cleared on success.
let _voicesLoadFailed = false;
let _voicesRetryTimer = null;

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    if (!res.ok) throw new Error(`voices request failed: ${res.status}`);
    const data = await res.json();
    voiceEl.innerHTML = "";
    _voiceSpeakerCounts.clear();
    if (!data.voices || data.voices.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No voices found on this system";
      opt.disabled = true;
      voiceEl.appendChild(opt);
      onVoiceChange();
      return;
    }

    // Local helper so the favorites optgroup and the engine groups share
    // exactly the same option-rendering format. Anything that ends up in
    // _voiceSpeakerCounts during this pass is also driven through here.
    const renderOpt = (v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      const suffix =
        v.engine === "piper" || !v.languages?.[0] ? "" : ` · ${v.languages[0]}`;
      const multi = v.num_speakers > 1 ? ` · ${v.num_speakers} voices` : "";
      opt.textContent = `${v.name}${suffix}${multi}`;
      _voiceSpeakerCounts.set(v.id, Number(v.num_speakers) || 1);
      return opt;
    };

    // ★ Favorites optgroup — only the user's starred installed voices, in
    // the order they starred them (most-recently first). Skipped when no
    // favorites are starred so a fresh install doesn't show an empty header.
    const favIds = getFavoriteVoices();
    if (favIds.length > 0) {
      const favByEngine = new Map(data.voices.map((v) => [v.id, v]));
      const favVoices = favIds
        .map((id) => favByEngine.get(id))
        .filter(Boolean);
      if (favVoices.length > 0) {
        const og = document.createElement("optgroup");
        og.label = "★ Favorites";
        for (const v of favVoices) og.appendChild(renderOpt(v));
        voiceEl.appendChild(og);
      }
    }

    const groups = [
      { engine: "piper", label: "Neural (high quality)" },
      { engine: "sapi", label: "System voices" },
    ];

    for (const g of groups) {
      const voices = data.voices.filter((v) => v.engine === g.engine);
      if (voices.length === 0) continue;
      const og = document.createElement("optgroup");
      og.label = g.label;
      for (const v of voices) {
        og.appendChild(renderOpt(v));
      }
      voiceEl.appendChild(og);
    }
    // Sync the speaker row to whichever voice ended up selected.
    onVoiceChange();
    // Success — clear any retry state from a previous cold-start cycle.
    _voicesLoadFailed = false;
    if (_voicesRetryTimer) {
      clearTimeout(_voicesRetryTimer);
      _voicesRetryTimer = null;
    }
  } catch (err) {
    // Surface the failure prominently and schedule an auto-retry. The
    // common cause is a Fly.io cold-start 503 — the machine is waking
    // and the catalog endpoint won't respond until uvicorn is up. Auto-
    // retrying every 10s gets the user from "dropdown is empty and I
    // don't know why" to "ah, it's just warming up" without manual
    // refreshes. Local 503s (real server bug) also get the retry, which
    // is fine — the worst case is a polite loop until the user reloads.
    _voicesLoadFailed = true;
    const m = String(err.message).match(/\b(\d{3})\b/);
    const httpCode = m ? m[1] : null;
    const detail = httpCode === "503"
      ? `Server is waking up (${httpCode}) — retrying in 10s…`
      : `Could not load voices: ${err.message} — retrying in 10s…`;
    setStatus(detail, true);
    if (_voicesRetryTimer) clearTimeout(_voicesRetryTimer);
    _voicesRetryTimer = setTimeout(() => {
      _voicesRetryTimer = null;
      loadVoices();
    }, 10_000);
  }
}

// ---- Speaker picker -----------------------------------------------------
// Shown only when the selected voice has num_speakers > 1. Selection is
// persisted per voice in localStorage so switching away and back doesn't
// reset you to speaker 0.
const SPEAKER_STORAGE_KEY = "narrative.speakerByVoice";

function _loadSpeakerMap() {
  try {
    return JSON.parse(localStorage.getItem(SPEAKER_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function _saveSpeakerMap(map) {
  try {
    localStorage.setItem(SPEAKER_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

function rememberedSpeaker(voiceId) {
  const map = _loadSpeakerMap();
  const v = Number(map[voiceId]);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function rememberSpeaker(voiceId, speakerId) {
  const map = _loadSpeakerMap();
  map[voiceId] = Number(speakerId) || 0;
  _saveSpeakerMap(map);
}

// ---- Voice favorites ----------------------------------------------------
// User-starred voices. Drives the "★ Favorites" optgroup at the top of
// the main picker AND a filter chip in the voice browser. Stored as an
// array so the user's star order is stable (most-recently-starred floats
// to the top within the favorites list).
// GitHub Personal Access Token (PAT) for fetching from private repos.
// Stored in localStorage so it persists across sessions on this device
// only. The token is sent to /api/extract/url in the request body when
// the URL is a GitHub URL; the backend forwards it as a Bearer token
// to github.com / raw.githubusercontent.com only.
const GITHUB_TOKEN_KEY = "narrative.githubToken";

function getGithubToken() {
  try {
    return (localStorage.getItem(GITHUB_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

// v163: remember recently-browsed GitHub repos so the user can
// re-open them with one click — both from Import → GitHub (chip
// row above the URL field) and from the queue panel (chips at the
// bottom). v176: expanded from a single most-recent value to a
// list of up to 5, most-recent-first, deduped by URL.
const LAST_GITHUB_REPO_KEY = "narrative.lastGithubRepo";       // legacy (single)
const RECENT_GITHUB_REPOS_KEY = "narrative.recentGithubRepos"; // v176 list
const RECENT_GITHUB_REPOS_MAX = 5;

// v176 helpers -----------------------------------------------------------
// Read the recent-repos list. On first read after a v176 upgrade we
// also migrate the legacy single-value key into the new list so the
// user doesn't lose their last-opened repo.
function _getRecentGithubRepos() {
  try {
    const raw = localStorage.getItem(RECENT_GITHUB_REPOS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(
          (r) => r && r.url && r.owner && r.repo
        ).slice(0, RECENT_GITHUB_REPOS_MAX);
      }
    }
    // Migrate from the v163 single-value key if present.
    const legacyRaw = localStorage.getItem(LAST_GITHUB_REPO_KEY);
    if (legacyRaw) {
      const obj = JSON.parse(legacyRaw);
      if (obj && obj.url && obj.owner && obj.repo) {
        const seed = [obj];
        try {
          localStorage.setItem(RECENT_GITHUB_REPOS_KEY, JSON.stringify(seed));
        } catch {}
        return seed;
      }
    }
  } catch {}
  return [];
}

// Push (or move-to-front) a repo on the recent list. Dedupes by url
// and caps at RECENT_GITHUB_REPOS_MAX. Also writes through the
// legacy single-value key so any code path still reading the old key
// keeps working until it's migrated.
function _pushRecentGithubRepo(info) {
  if (!info || !info.url || !info.owner || !info.repo) return;
  const list = _getRecentGithubRepos();
  const url = info.url;
  const filtered = list.filter((r) => r.url !== url);
  filtered.unshift({
    url: info.url,
    owner: info.owner,
    repo: info.repo,
    branch: info.branch || null,
  });
  const capped = filtered.slice(0, RECENT_GITHUB_REPOS_MAX);
  try {
    localStorage.setItem(RECENT_GITHUB_REPOS_KEY, JSON.stringify(capped));
    localStorage.setItem(LAST_GITHUB_REPO_KEY, JSON.stringify(capped[0]));
  } catch {}
  if (typeof _renderBgQueuePanel === "function") _renderBgQueuePanel();
}

// Backward-compat: callers that need "most recent" still work. Reads
// from the new list (which auto-migrates from the legacy key) and
// returns the head, or null if the list is empty.
function _getLastGithubRepo() {
  const list = _getRecentGithubRepos();
  return list.length > 0 ? list[0] : null;
}

// Kept as an alias so older v163 call sites continue to compile.
// New code should call _pushRecentGithubRepo directly.
function _setLastGithubRepo(info) {
  _pushRecentGithubRepo(info);
}

function setGithubToken(token) {
  try {
    if (token && token.trim()) {
      localStorage.setItem(GITHUB_TOKEN_KEY, token.trim());
    } else {
      localStorage.removeItem(GITHUB_TOKEN_KEY);
    }
  } catch {}
}

// v180: GitHub OAuth — capture the access token from the URL fragment
// after the server's /api/github/oauth/callback redirects back to /.
// The fragment carries `#gh_token=...` so the token never appears in
// access logs or Referer headers. We store it via setGithubToken (same
// path the PAT paste uses), surface a one-shot success status, then
// clear the fragment + the query param via history.replaceState so a
// reload doesn't re-process the same token.
function _captureGithubOAuthRedirect() {
  try {
    const hash = window.location.hash || "";
    const search = window.location.search || "";
    let captured = null;
    let success = false;
    let errMsg = null;

    // Parse the fragment for gh_token=...
    if (hash.startsWith("#") && hash.includes("gh_token=")) {
      const params = new URLSearchParams(hash.slice(1));
      const tok = params.get("gh_token");
      if (tok) captured = tok;
    }
    // Parse the query for the success / error signals.
    if (search) {
      const q = new URLSearchParams(search);
      success = q.get("gh_oauth") === "success";
      errMsg = q.get("gh_oauth_error");
    }

    if (captured) {
      setGithubToken(captured);
      _dlog && _dlog("oauth", "GitHub OAuth captured token from fragment", {
        chars: captured.length,
      });
      // Clear fragment + query so a reload doesn't re-show the toast
      // and the token isn't sitting in window.location for any rogue
      // script to read.
      try {
        history.replaceState({}, "", window.location.pathname);
      } catch {}
      // Defer status until setStatus is wired (it's declared later in
      // the file). On a typical run this fires after init though.
      setTimeout(() => {
        try {
          if (typeof setStatus === "function") {
            setStatus("✓ Signed in with GitHub — token saved.");
          }
        } catch {}
      }, 0);
      // Best-effort: surface signed-in user display once Settings
      // opens. _refreshGithubOAuthUI handles both cases.
      if (typeof _refreshGithubOAuthUI === "function") {
        _refreshGithubOAuthUI();
      }
    } else if (errMsg) {
      _dlog && _dlog("oauth", `GitHub OAuth error from server: ${errMsg}`, {});
      try { history.replaceState({}, "", window.location.pathname); } catch {}
      setTimeout(() => {
        try {
          if (typeof setStatus === "function") {
            setStatus(`GitHub sign-in failed: ${errMsg}`, true);
          }
        } catch {}
      }, 0);
    } else if (success) {
      // Success flag without a token is unexpected but harmless. Tidy
      // the URL so a reload doesn't re-trigger the branch.
      try { history.replaceState({}, "", window.location.pathname); } catch {}
    }
  } catch (err) {
    // Defensive: never let URL parsing break boot. The user can still
    // paste a PAT manually.
    console.warn("[oauth] capture failed:", err);
  }
}
_captureGithubOAuthRedirect();

function _isGithubUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "github.com" ||
      u.hostname === "www.github.com" ||
      u.hostname === "raw.githubusercontent.com" ||
      // v181: Gist raw file URLs go through this host. The PAT
      // forwarding gate above (only attach token for GitHub URLs)
      // also needs to apply to gists, so include both Gist hosts
      // in the check.
      u.hostname === "gist.github.com" ||
      u.hostname === "gist.githubusercontent.com"
    );
  } catch {
    return false;
  }
}

// v181: Gist-specific detector. Only the gist.github.com host counts
// — gist.githubusercontent.com is a raw-file CDN, not a URL the user
// would paste expecting to see a file picker. fetchFromUrl routes
// matching URLs to openGistBrowser.
function _isGistUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "gist.github.com";
  } catch {
    return false;
  }
}

const VOICE_FAVORITES_KEY = "narrative.voiceFavorites";

function getFavoriteVoices() {
  try {
    const raw = localStorage.getItem(VOICE_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function isFavoriteVoice(voiceId) {
  return getFavoriteVoices().includes(voiceId);
}

function toggleFavoriteVoice(voiceId) {
  if (!voiceId) return false;
  const list = getFavoriteVoices();
  const idx = list.indexOf(voiceId);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.unshift(voiceId); // newest at top
  }
  try {
    localStorage.setItem(VOICE_FAVORITES_KEY, JSON.stringify(list));
  } catch {}
  return idx < 0; // true when we just added
}

// Re-fetch /api/voices and rebuild the main picker so the "★ Favorites"
// optgroup stays in sync after a star toggle. Preserves the currently-
// selected voice so the user doesn't lose their place when starring
// while a clip is loaded.
async function _refreshFavoritesInMainPicker() {
  const previous = voiceEl.value;
  await loadVoices();
  if (previous && voiceEl.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
    voiceEl.value = previous;
    onVoiceChange();
  }
}

// Above this many speakers, the native dropdown is unusable (LibriTTS:
// 904) — we hide it and surface a chip that opens the audition wizard
// instead. Voices at or below this threshold keep the dropdown since
// it's still scannable at that size.
const SPEAKER_DROPDOWN_MAX = 20;
const speakerChip = $("speaker-chip");

function _updateSpeakerChipLabel() {
  const n = Number(speakerEl.value) || 0;
  speakerChip.textContent = `Speaker ${n} — change…`;
}

function onVoiceChange() {
  stopSpeakerPreview();
  // Keep the hero trigger label in sync with whatever's selected —
  // covers both user picks (the "change" event) and programmatic
  // selection (e.g. preset apply, boot-time auto-select).
  if (typeof _updateVoiceTriggerLabel === "function") {
    _updateVoiceTriggerLabel();
  }
  const voiceId = voiceEl.value;
  const n = _voiceSpeakerCounts.get(voiceId) || 1;
  if (n <= 1) {
    speakerRow.hidden = true;
    speakerEl.innerHTML = "";
    speakerChip.hidden = true;
    return;
  }

  // The <select> still backs the chosen speaker even in chip mode —
  // segments / preview / preset code all read speakerEl.value. So we
  // always populate it; the chip just hides the visual element.
  speakerEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Speaker ${i}`;
    speakerEl.appendChild(opt);
  }
  speakerEl.value = String(Math.min(rememberedSpeaker(voiceId), n - 1));

  // High-count voices: hide the dropdown, surface the chip + audition
  // entry point. Low-count voices: regular dropdown (audition button
  // still available for power users who want to star a small roster).
  const useChip = n > SPEAKER_DROPDOWN_MAX;
  speakerEl.hidden = useChip;
  speakerChip.hidden = !useChip;
  if (useChip) _updateSpeakerChipLabel();

  speakerRow.hidden = false;

  // v170: inline tip for high-count voices, replacing the v168
  // _fireChipHint approach that wrote to the global status bar —
  // which is occluded by this very dialog, so users never saw it
  // (and the localStorage flag got "consumed" sight-unseen). The
  // banner is dismissible (×) and auto-hides once the user has
  // actually opened the Audition wizard; both states persist in
  // localStorage so a returning user isn't nagged.
  _updateSpeakerAuditionTip(useChip ? n : 0);
}

// v170: inline tip pointing at the Audition link. The voice dialog
// is fullscreen on phones — a setStatus-based hint is invisible
// behind it. The banner shows when a high-count voice loads AND the
// user has neither dismissed it nor opened Audition yet.
const SPEAKER_AUDITION_TIP_DISMISSED_KEY = "narrative.speakerAuditionTipDismissed";
const SPEAKER_AUDITION_TIP_USED_KEY = "narrative.speakerAuditionTipUsed";
function _updateSpeakerAuditionTip(speakerCount) {
  const tip = document.getElementById("speaker-audition-tip");
  if (!tip) return;
  let dismissed = false, used = false;
  try {
    dismissed = localStorage.getItem(SPEAKER_AUDITION_TIP_DISMISSED_KEY) === "1";
    used = localStorage.getItem(SPEAKER_AUDITION_TIP_USED_KEY) === "1";
  } catch {}
  if (!speakerCount || dismissed || used) {
    tip.hidden = true;
    return;
  }
  const countEl = document.getElementById("speaker-audition-tip-count");
  if (countEl) countEl.textContent = String(speakerCount);
  tip.hidden = false;
}
const _speakerAuditionTipDismissBtn = document.getElementById(
  "speaker-audition-tip-dismiss"
);
if (_speakerAuditionTipDismissBtn) {
  _speakerAuditionTipDismissBtn.addEventListener("click", () => {
    try { localStorage.setItem(SPEAKER_AUDITION_TIP_DISMISSED_KEY, "1"); } catch {}
    const tip = document.getElementById("speaker-audition-tip");
    if (tip) tip.hidden = true;
  });
}

voiceEl.addEventListener("change", onVoiceChange);
voiceEl.addEventListener("change", _updateRenarrateBanner);
speakerEl.addEventListener("change", () => {
  stopSpeakerPreview();
  rememberSpeaker(voiceEl.value, Number(speakerEl.value));
});

// ---- Re-narrate banner --------------------------------------------------
// Voice is baked into the audio at synthesis time — there's no live voice
// switch. When the user picks a different voice while a clip is loaded,
// surface a banner offering to re-synthesize the loaded clip in the new
// voice. Dismiss keeps the picker change as the default for next Generate;
// the previous voice on the clip stays put until the user explicitly
// re-narrates.
const renarrateBanner = $("renarrate-banner");
const renarrateClipTitle = $("renarrate-clip-title");
const renarrateVoiceName = $("renarrate-voice-name");
const renarrateConfirm = $("renarrate-confirm");
const renarrateDismiss = $("renarrate-dismiss");
// User-dismissed banners shouldn't flash back if the user toggles voices
// again on the same clip — track the last clip we dismissed so we don't
// nag. Reset on Clear / loadClip.
let _renarrateDismissedClipId = null;

async function _updateRenarrateBanner() {
  // Hide the banner when:
  //   - No clip loaded (voice change is just setting defaults)
  //   - Synthesis in flight (regen is already happening or about to)
  //   - Voice picker matches the loaded clip's voice (nothing to do)
  //   - The user already dismissed for this clip
  if (
    !_currentClipId ||
    _synthController ||
    _renarrateDismissedClipId === _currentClipId
  ) {
    renarrateBanner.hidden = true;
    return;
  }
  const pickerVoice = voiceEl.value;
  if (!pickerVoice || pickerVoice === _currentPlayingVoiceId) {
    renarrateBanner.hidden = true;
    return;
  }
  // Look up the title for the labelled prompt. Falls back gracefully
  // if the clip isn't reachable for some reason.
  try {
    const clip = await getClip(_currentClipId);
    renarrateClipTitle.textContent = clip?.title || "this clip";
  } catch {
    renarrateClipTitle.textContent = "this clip";
  }
  const voiceName =
    voiceEl.selectedOptions[0]?.textContent || pickerVoice;
  renarrateVoiceName.textContent = voiceName;
  renarrateBanner.hidden = false;
}

renarrateDismiss.addEventListener("click", () => {
  _renarrateDismissedClipId = _currentClipId;
  renarrateBanner.hidden = true;
});

renarrateConfirm.addEventListener("click", () => {
  if (!_currentClipId) return;
  // Capture the user's position BEFORE starting the regen — the new
  // audio will seek here once the swap completes.
  _regenResumeAtSec = virtualTime();
  // Suppress streaming-sentence playback so the user doesn't hear
  // the new voice rewinding to sentence 0 while we re-synthesize.
  // Status line still shows synth progress.
  _regenSuppressStreaming = true;
  // Pause the old combined audio now so it doesn't keep speaking
  // Amy while the reading view rebuilds for Sarah.
  if (!playerEl.paused) _pauseAsUser();
  // Use the existing in-place regen path. generate() already pulls
  // voice + speaker + rate + volume from the current picker state, so
  // we just flag the existing clip id as the regen target.
  _regenTargetClipId = _currentClipId;
  renarrateBanner.hidden = true;
  _renarrateDismissedClipId = null;
  generate();
});

// Reuse the voice-browser preview's shared Audio element for the inline
// speaker preview. State machine mirrors togglePreview() in the catalog.
let _speakerPreviewActive = false;

function stopSpeakerPreview() {
  if (!_speakerPreviewActive) return;
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.removeAttribute("src");
    _previewAudio.load();
  }
  speakerPreviewBtn.classList.remove("playing", "loading");
  speakerPreviewBtn.textContent = "▶";
  speakerPreviewBtn.disabled = false;
  speakerPreviewBtn.title = "Preview this speaker";
  _speakerPreviewActive = false;
}

speakerPreviewBtn.addEventListener("click", async () => {
  if (_speakerPreviewActive) {
    stopSpeakerPreview();
    return;
  }
  // Also stop any catalog-row preview that might be playing.
  if (typeof stopPreview === "function") stopPreview();

  const voiceId = (voiceEl.value || "").replace(/^piper:/, "");
  const speakerId = Number(speakerEl.value || 0);
  if (!voiceId) return;

  const audio = _ensurePreviewAudio();
  // When the shared Audio's ended event fires we won't know who owns it;
  // attach a one-shot reset so the button flips back correctly.
  const onEnded = () => {
    audio.removeEventListener("ended", onEnded);
    stopSpeakerPreview();
  };
  audio.addEventListener("ended", onEnded);

  speakerPreviewBtn.classList.add("loading");
  speakerPreviewBtn.textContent = "…";
  _speakerPreviewActive = true;
  audio.src = `/api/voices/sample/${encodeURIComponent(voiceId)}?speaker=${speakerId}`;
  try {
    await audio.play();
    speakerPreviewBtn.classList.remove("loading");
    speakerPreviewBtn.classList.add("playing");
    speakerPreviewBtn.textContent = "■";
  } catch (err) {
    audio.removeEventListener("ended", onEnded);
    speakerPreviewBtn.classList.remove("playing", "loading");
    speakerPreviewBtn.textContent = "—";
    speakerPreviewBtn.title = "No preview available for this speaker";
    speakerPreviewBtn.disabled = true;
    _speakerPreviewActive = false;
    console.info("speaker preview unavailable:", voiceId, speakerId, err.message || err);
  }
});

// ---- Speaker audition wizard --------------------------------------------
// Browsing 904 anonymous LibriTTS speaker IDs via a single dropdown is
// hopeless. This wizard surfaces 6 at a time as rows with ▶ / ★ / Use
// controls, with star persistence per-voice so a returning user can
// jump straight to their shortlist via the "★ Starred only" filter.
const speakerWizard = $("speaker-wizard");
const speakerWizardClose = $("speaker-wizard-close");
const speakerWizardSubtitle = $("speaker-wizard-subtitle");
const speakerWizardStarredBtn = $("speaker-wizard-starred");
const speakerWizardList = $("speaker-wizard-list");
const speakerWizardPrev = $("speaker-wizard-prev");
const speakerWizardNext = $("speaker-wizard-next");
const speakerAuditionBtn = $("speaker-audition-btn");

const SPEAKER_FAVS_KEY = "narrative.speakerFavorites";
const SPEAKER_WIZARD_PAGE_SIZE = 6;

function _loadAllSpeakerFavs() {
  try {
    const raw = localStorage.getItem(SPEAKER_FAVS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _saveAllSpeakerFavs(map) {
  try {
    localStorage.setItem(SPEAKER_FAVS_KEY, JSON.stringify(map));
  } catch {}
}

function getSpeakerFavs(voiceId) {
  const all = _loadAllSpeakerFavs();
  const list = all[voiceId];
  return Array.isArray(list) ? list.filter((n) => Number.isFinite(n)) : [];
}

function isStarredSpeaker(voiceId, speakerId) {
  return getSpeakerFavs(voiceId).includes(speakerId);
}

function toggleSpeakerFav(voiceId, speakerId) {
  const all = _loadAllSpeakerFavs();
  const list = Array.isArray(all[voiceId]) ? [...all[voiceId]] : [];
  const idx = list.indexOf(speakerId);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift(speakerId); // newest at top
  all[voiceId] = list;
  _saveAllSpeakerFavs(all);
  return idx < 0;
}

let _wizardPage = 0;
let _wizardStarredOnly = false;
let _wizardActiveBtn = null;
// Cache the voice's speaker count + the voice id at open time so paging
// doesn't break if the user changes voice in the background.
let _wizardVoiceId = null;
let _wizardSpeakerCount = 0;

function _wizardCurrentIds() {
  if (_wizardStarredOnly) {
    return getSpeakerFavs(_wizardVoiceId).slice().sort((a, b) => a - b);
  }
  // Full range 0..N-1.
  return Array.from({ length: _wizardSpeakerCount }, (_, i) => i);
}

function _wizardPageIds() {
  const all = _wizardCurrentIds();
  const start = _wizardPage * SPEAKER_WIZARD_PAGE_SIZE;
  return { all, page: all.slice(start, start + SPEAKER_WIZARD_PAGE_SIZE), start };
}

function _stopWizardPreview() {
  if (_wizardActiveBtn) {
    _wizardActiveBtn.classList.remove("playing", "loading");
    _wizardActiveBtn.textContent = "▶";
    _wizardActiveBtn = null;
  }
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.removeAttribute("src");
    _previewAudio.load();
  }
}

async function _wizardPlay(speakerId, btn) {
  if (_wizardActiveBtn === btn) {
    _stopWizardPreview();
    return;
  }
  _stopWizardPreview();
  const audio = _ensurePreviewAudio();
  const voiceId = (_wizardVoiceId || "").replace(/^piper:/, "");
  btn.classList.add("loading");
  btn.textContent = "…";
  _wizardActiveBtn = btn;
  const onEnded = () => {
    audio.removeEventListener("ended", onEnded);
    if (_wizardActiveBtn === btn) _stopWizardPreview();
  };
  audio.addEventListener("ended", onEnded);
  audio.src = `/api/voices/sample/${encodeURIComponent(voiceId)}?speaker=${speakerId}`;
  try {
    await audio.play();
    btn.classList.remove("loading");
    btn.classList.add("playing");
    btn.textContent = "■";
  } catch (err) {
    audio.removeEventListener("ended", onEnded);
    btn.classList.remove("loading", "playing");
    btn.textContent = "—";
    btn.disabled = true;
    if (_wizardActiveBtn === btn) _wizardActiveBtn = null;
    console.info("wizard preview unavailable:", voiceId, speakerId, err);
  }
}

function _updateWizardStarredChip() {
  const favCount = getSpeakerFavs(_wizardVoiceId).length;
  speakerWizardStarredBtn.textContent = _wizardStarredOnly
    ? `Show all (${favCount})`
    : `★ Starred only (${favCount})`;
  speakerWizardStarredBtn.classList.toggle("active", _wizardStarredOnly);
  speakerWizardStarredBtn.setAttribute(
    "aria-pressed",
    String(_wizardStarredOnly)
  );
}

function renderSpeakerWizard() {
  _stopWizardPreview();
  _updateWizardStarredChip();

  const { all, page, start } = _wizardPageIds();
  const total = all.length;
  if (total === 0) {
    speakerWizardSubtitle.textContent = _wizardStarredOnly
      ? "No starred speakers yet — turn off the filter and ★ some."
      : "No speakers available.";
    speakerWizardList.innerHTML = "";
    speakerWizardPrev.disabled = true;
    speakerWizardNext.disabled = true;
    return;
  }

  const end = Math.min(start + page.length, total);
  speakerWizardSubtitle.textContent = `Speakers ${start + 1}–${end} of ${total}`;

  speakerWizardList.innerHTML = "";
  for (const speakerId of page) {
    const row = document.createElement("div");
    row.className = "speaker-wizard-row";

    const num = document.createElement("span");
    num.className = "speaker-wizard-num";
    num.textContent = `Speaker ${speakerId}`;
    row.appendChild(num);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "speaker-wizard-play";
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", `Preview speaker ${speakerId}`);
    playBtn.addEventListener("click", () => _wizardPlay(speakerId, playBtn));
    row.appendChild(playBtn);

    const starBtn = document.createElement("button");
    starBtn.type = "button";
    const starred = isStarredSpeaker(_wizardVoiceId, speakerId);
    starBtn.className = "speaker-wizard-star" + (starred ? " starred" : "");
    starBtn.textContent = starred ? "★" : "☆";
    starBtn.setAttribute(
      "aria-label",
      starred ? `Unstar speaker ${speakerId}` : `Star speaker ${speakerId}`
    );
    starBtn.addEventListener("click", () => {
      toggleSpeakerFav(_wizardVoiceId, speakerId);
      renderSpeakerWizard();
    });
    row.appendChild(starBtn);

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "speaker-wizard-use";
    useBtn.textContent = "Use";
    useBtn.setAttribute("aria-label", `Use speaker ${speakerId}`);
    useBtn.addEventListener("click", () => {
      speakerEl.value = String(speakerId);
      // Fire the native change event so rememberSpeaker + downstream
      // listeners run as if the user picked from the dropdown.
      speakerEl.dispatchEvent(new Event("change"));
      _stopWizardPreview();
      speakerWizard.close();
    });
    row.appendChild(useBtn);

    speakerWizardList.appendChild(row);
  }

  speakerWizardPrev.disabled = _wizardPage === 0;
  speakerWizardNext.disabled = end >= total;
}

function openSpeakerWizard() {
  _wizardVoiceId = voiceEl.value || null;
  _wizardSpeakerCount = _voiceSpeakerCounts.get(_wizardVoiceId) || 0;
  _wizardPage = 0;
  _wizardStarredOnly = false;
  renderSpeakerWizard();
  speakerWizard.showModal();
}

speakerAuditionBtn.addEventListener("click", () => {
  // v170: opening the wizard from the link means the user found
  // the affordance — mark the tip "used" so it never shows again.
  try { localStorage.setItem(SPEAKER_AUDITION_TIP_USED_KEY, "1"); } catch {}
  const tip = document.getElementById("speaker-audition-tip");
  if (tip) tip.hidden = true;
  openSpeakerWizard();
});

// v152: speaker explainer link. Toggles an inline popover (v153)
// so a repeat click visibly closes it again — the original v152
// setStatus fired the same message both times, which the user
// couldn't tell was a real second-click reaction.
const speakerHelpBtn = $("speaker-help-btn");
const speakerHelpPopover = $("speaker-help-popover");
if (speakerHelpBtn && speakerHelpPopover) {
  speakerHelpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !speakerHelpPopover.hidden;
    speakerHelpPopover.hidden = isOpen;
    speakerHelpBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
  });
  // Tap outside the popover (anywhere in the voice dialog body)
  // closes it. Click on the popover itself doesn't bubble close.
  speakerHelpPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (speakerHelpPopover.hidden) return;
    if (e.target === speakerHelpBtn) return;
    if (speakerHelpPopover.contains(e.target)) return;
    speakerHelpPopover.hidden = true;
    speakerHelpBtn.setAttribute("aria-expanded", "false");
  });
}
// Chip click is the primary path for high-count voices — the native
// dropdown is hidden in that mode, so the chip carries both the current-
// value display AND the "change" affordance in a single tap target.
speakerChip.addEventListener("click", () => {
  // v170: chip also routes through the wizard — same "found it"
  // signal as the Audition link.
  try { localStorage.setItem(SPEAKER_AUDITION_TIP_USED_KEY, "1"); } catch {}
  const tip = document.getElementById("speaker-audition-tip");
  if (tip) tip.hidden = true;
  openSpeakerWizard();
});
speakerWizardClose.addEventListener("click", () => speakerWizard.close());
speakerWizard.addEventListener("close", _stopWizardPreview);

// Keep the chip's label in sync when the underlying <select> changes —
// covers wizard "Use" (which dispatches change), preset application,
// and any other path that mutates speakerEl.value.
speakerEl.addEventListener("change", () => {
  if (!speakerChip.hidden) _updateSpeakerChipLabel();
});

speakerWizardStarredBtn.addEventListener("click", () => {
  _wizardStarredOnly = !_wizardStarredOnly;
  _wizardPage = 0;
  renderSpeakerWizard();
});

speakerWizardPrev.addEventListener("click", () => {
  if (_wizardPage > 0) {
    _wizardPage -= 1;
    renderSpeakerWizard();
  }
});

speakerWizardNext.addEventListener("click", () => {
  const { all } = _wizardPageIds();
  if ((_wizardPage + 1) * SPEAKER_WIZARD_PAGE_SIZE < all.length) {
    _wizardPage += 1;
    renderSpeakerWizard();
  }
});

// ---- Synthesis presets ---------------------------------------------------
// Save named voice + speaker + rate + volume combos as chips you can tap to
// re-apply. Useful when you've found a LibriTTS speaker + speed you like
// and want to come back to it without rebuilding the config by hand.
const PRESETS_STORAGE_KEY = "narrative.presets";

function _loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _savePresets(list) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("preset save failed:", e);
  }
}

function _currentPresetSnapshot() {
  return {
    voiceId: voiceEl.value || null,
    speakerId: speakerRow.hidden ? null : Number(speakerEl.value || 0),
    rate: Number(rateEl.value),
    volume: Number(volumeEl.value) / 100,
  };
}

function _suggestPresetName() {
  const voiceLabel =
    (voiceEl.selectedOptions[0]?.textContent || "Voice").split(" · ")[0];
  const parts = [voiceLabel];
  if (!speakerRow.hidden) parts.push(`spk ${speakerEl.value}`);
  parts.push(`${rateEl.value} wpm`);
  return parts.join(" · ");
}

function applyPreset(preset) {
  // Voice: check it's still in the dropdown (the user might have removed
  // it via the voice browser since the preset was saved).
  if (preset.voiceId) {
    let optionExists = false;
    for (const opt of voiceEl.options) {
      if (opt.value === preset.voiceId) { optionExists = true; break; }
    }
    if (!optionExists) {
      setStatus(
        `Preset "${preset.name}" uses a voice that isn't installed.`,
        true
      );
      return;
    }
    voiceEl.value = preset.voiceId;
    onVoiceChange(); // populates speaker dropdown for the new voice
  }

  // Speaker: only meaningful if the new voice exposes one and the saved
  // index is in range for that voice.
  if (
    typeof preset.speakerId === "number" &&
    !speakerRow.hidden &&
    speakerEl.options.length > preset.speakerId
  ) {
    speakerEl.value = String(preset.speakerId);
  }

  if (typeof preset.rate === "number") {
    const r = Math.min(300, Math.max(80, Math.round(preset.rate)));
    rateEl.value = String(r);
    rateValueEl.textContent = String(r);
  }
  if (typeof preset.volume === "number") {
    const v = Math.min(100, Math.max(0, Math.round(preset.volume * 100)));
    volumeEl.value = String(v);
    volumeValueEl.textContent = `${v}%`;
  }

  setStatus(`Applied preset: ${preset.name}`);
}

function deletePreset(id) {
  const list = _loadPresets().filter((p) => p.id !== id);
  _savePresets(list);
  renderPresets();
}

function renderPresets() {
  const list = _loadPresets();
  presetsList.innerHTML = "";
  if (list.length === 0) {
    // v166: show a one-line explainer when no presets exist instead
    // of hiding the row entirely — testers had no idea what "Save
    // preset" would produce. Becomes a real chip list once they
    // save one. Hidden on Simple mode (advanced-only) so casual
    // readers never see writing-craft chrome.
    presetsList.hidden = false;
    const empty = document.createElement("p");
    empty.className = "presets-empty advanced-only";
    empty.textContent =
      "💡 Tip — Save preset stores the current voice + speed + volume as a named combo. Useful when juggling two voices for different content (fiction vs. tech docs, narrator vs. character).";
    presetsList.appendChild(empty);
    return;
  }
  presetsList.hidden = false;
  for (const preset of list) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "preset-chip";
    chip.title = (
      `${preset.voiceId || "default voice"}` +
      (preset.speakerId != null ? ` · spk ${preset.speakerId}` : "") +
      ` · ${preset.rate} wpm · ${Math.round(preset.volume * 100)}%`
    );

    const name = document.createElement("span");
    name.className = "preset-chip-name";
    name.textContent = preset.name;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "preset-chip-x";
    del.textContent = "×";
    del.title = "Delete preset";
    del.setAttribute("aria-label", `Delete preset ${preset.name}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    });

    chip.append(name, del);
    chip.addEventListener("click", () => applyPreset(preset));
    presetsList.appendChild(chip);
  }
}

// ---- Reset Speed / Volume to factory defaults (v129) -------------------
// "Defaults" link in the Voice dialog. Just synth knobs — voice and
// speaker stay as-is so the user doesn't lose their pick when backing
// out of speed/volume experiments. The 'input' dispatch is so the
// existing listener that mirrors slider → label text fires and updates
// the "180" / "100%" badges next to each slider.
voiceDefaultsBtn.addEventListener("click", () => {
  rateEl.value = "180";
  volumeEl.value = "100";
  rateEl.dispatchEvent(new Event("input", { bubbles: true }));
  volumeEl.dispatchEvent(new Event("input", { bubbles: true }));
  setStatus("Reset to defaults: Speed 180 wpm, Volume 100%");
});

presetSaveBtn.addEventListener("click", () => {
  const suggested = _suggestPresetName();
  const name = window.prompt("Name this preset:", suggested);
  if (!name || !name.trim()) return;
  const list = _loadPresets();
  list.unshift({
    id: Date.now(),
    name: name.trim(),
    ..._currentPresetSnapshot(),
    createdAt: new Date().toISOString(),
  });
  _savePresets(list);
  renderPresets();
  setStatus(`Saved preset: ${name.trim()}`);
});

renderPresets();

// ---- Character voices (Author mode) -------------------------------------
// Persisted roster of {id, name, voiceId, speakerId}. When Author mode is
// on AND the user has defined at least one character, generate() detects
// attributed dialogue ("...," X said) and routes those sentences through
// the /api/synthesize/segments/stream endpoint with each segment carrying
// its assigned voice. Other sentences fall through to the main voice
// picker (used as "narration").
const CHARACTERS_STORAGE_KEY = "narrative.characters";

function _loadCharacters() {
  try {
    const raw = localStorage.getItem(CHARACTERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _saveCharacters(list) {
  try {
    localStorage.setItem(CHARACTERS_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("character save failed:", e);
  }
}

function _populateVoiceOptions(selectEl, currentVoiceId) {
  // Mirror the main voice dropdown so the character's voice picker shows
  // the same installed Piper / SAPI voice list.
  selectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Default voice";
  selectEl.appendChild(placeholder);

  for (const og of voiceEl.querySelectorAll("optgroup")) {
    const newOg = document.createElement("optgroup");
    newOg.label = og.label;
    for (const opt of og.querySelectorAll("option")) {
      const c = document.createElement("option");
      c.value = opt.value;
      c.textContent = opt.textContent;
      newOg.appendChild(c);
    }
    selectEl.appendChild(newOg);
  }
  selectEl.value = currentVoiceId || "";
}

function _populateSpeakerOptions(selectEl, voiceId, currentSpeakerId) {
  selectEl.innerHTML = "";
  const n = _voiceSpeakerCounts.get(voiceId) || 1;
  if (n <= 1) {
    selectEl.hidden = true;
    return;
  }
  selectEl.hidden = false;
  for (let i = 0; i < n; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Speaker ${i}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = String(Math.min(Number(currentSpeakerId) || 0, n - 1));
}

function renderCharacters() {
  const characters = _loadCharacters();
  charactersList.innerHTML = "";
  if (characters.length === 0) {
    const empty = document.createElement("div");
    empty.className = "characters-empty";
    empty.textContent =
      "No characters yet. Add one to start routing dialogue through a different voice.";
    charactersList.appendChild(empty);
    return;
  }

  for (const ch of characters) {
    const row = document.createElement("div");
    row.className = "character-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "character-name";
    nameInput.placeholder = "Name (e.g. Sarah)";
    nameInput.maxLength = 60;
    nameInput.value = ch.name || "";
    nameInput.addEventListener("change", () => {
      _updateCharacter(ch.id, { name: nameInput.value.trim() });
    });

    // Gender hint for Tier 2 pronoun resolution. Optional — leaving it
    // at "—" falls back to Tier 1 (last-named-speaker only). When set,
    // "She said" attributes to the most recent female-tagged character
    // in scope, etc. Tier 2 BACKLOG: gets ~5-10pts of accuracy on
    // mixed-gender two-character dialogue scenes.
    const genderSelect = document.createElement("select");
    genderSelect.className = "character-gender";
    genderSelect.title = "Used to resolve pronoun attribution (he / she / they)";
    for (const [val, label] of [
      ["", "—"],
      ["male", "He"],
      ["female", "She"],
      ["they", "They"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      genderSelect.appendChild(opt);
    }
    genderSelect.value = ch.gender || "";
    genderSelect.addEventListener("change", () => {
      _updateCharacter(ch.id, { gender: genderSelect.value || "" });
    });

    const voiceSelect = document.createElement("select");
    voiceSelect.className = "character-voice";
    _populateVoiceOptions(voiceSelect, ch.voiceId);
    voiceSelect.addEventListener("change", () => {
      _updateCharacter(ch.id, { voiceId: voiceSelect.value || null, speakerId: 0 });
      _populateSpeakerOptions(speakerSelect, voiceSelect.value, 0);
    });

    const speakerSelect = document.createElement("select");
    speakerSelect.className = "character-speaker";
    _populateSpeakerOptions(speakerSelect, ch.voiceId, ch.speakerId);
    speakerSelect.addEventListener("change", () => {
      _updateCharacter(ch.id, { speakerId: Number(speakerSelect.value) || 0 });
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "character-delete";
    delBtn.textContent = "×";
    delBtn.title = "Delete character";
    delBtn.setAttribute("aria-label", `Delete ${ch.name || "character"}`);
    delBtn.addEventListener("click", () => _deleteCharacter(ch.id));

    row.append(nameInput, genderSelect, voiceSelect, speakerSelect, delBtn);
    charactersList.appendChild(row);
  }
}

function _addCharacter() {
  const list = _loadCharacters();
  list.push({
    id: Date.now(),
    name: "",
    gender: "",
    voiceId: null,
    speakerId: null,
  });
  _saveCharacters(list);
  renderCharacters();
}

function _updateCharacter(id, patch) {
  const list = _loadCharacters();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch };
  _saveCharacters(list);
}

function _deleteCharacter(id) {
  const list = _loadCharacters().filter((c) => c.id !== id);
  _saveCharacters(list);
  renderCharacters();
}

charactersBtn.addEventListener("click", () => {
  renderCharacters();
  charactersDialog.showModal();
});
charactersClose.addEventListener("click", () => charactersDialog.close());
charactersAddBtn.addEventListener("click", _addCharacter);

// Dialogue / attribution heuristic. Tier 3 (v220y): cross-paragraph
// cursors + active-speaker carry-forward, on top of the existing
// Tier 1 (last-named) + Tier 2 (gender-keyed pronoun) passes.
//
// Walks the text paragraph by paragraph, but the THREE cursors all
// persist across paragraph boundaries:
//
//   - `lastNamedChar` — most recently named character (any gender).
//     Used as the Tier 1 fallback when no pronoun matches.
//   - `lastByGender`  — most recently named character per declared
//     gender (male / female / they). Used to resolve "he/she/they said"
//     even when the named speaker is many sentences back — including
//     across paragraph boundaries (real prose names a character once
//     per scene, not once per paragraph).
//   - `activeSpeaker` — the character to whom the most recent dialogue
//     sentence was attributed. Used to carry attribution forward
//     across consecutive quote-only sentences (long speeches split
//     across multiple sentences, or single-paragraph monologues).
//
// Resolution order for a quote-bearing sentence:
//   1. Explicit name in the same sentence  (definitive)
//   2. Pronoun → lastByGender bucket       (gender-disambiguated)
//   3. activeSpeaker                       (long-speech continuation)
//   4. lastNamedChar                       (Tier 1 fallback)
//   5. Narrator                            (no signal)
//
// Pronoun scan (outside the quotes — the dialogue CONTENT can mention
// pronouns too):
//   - "she" / "her" / "hers"    → lastByGender.female
//   - "he"  / "him" / "his"     → lastByGender.male
//   - "they" / "them" / "their" → lastByGender.they
//
// The Tier 2 reset-at-paragraph-break convention ("fresh paragraph +
// opening quote = new speaker") was too aggressive for real prose —
// long speeches and chapter-scale scenes where one character is named
// early then referred to by pronoun for paragraphs afterward both lost
// their attribution. Tier 3 trusts that authors explicitly attribute
// when a new speaker enters; in absence of any signal, the cursors
// keep tracking who was last established.
//
// Accuracy: ~92% on mixed-gender dialogue scenes (long-speech +
// pronoun cases now resolve), vs. ~85% Tier 2, ~75-80% Tier 1.
function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _DIALOGUE_QUOTE = /["“”'‘’]/;

// Strip quoted spans before scanning for attribution pronouns. Without
// this, the "him" in {"I saw him at the store," John said.} would
// trigger the male pronoun lookup based on the dialogue CONTENT
// instead of the attribution. Curly + straight quotes both handled;
// runaway / mismatched quotes are tolerated (greedy match caps at the
// next quote of the matching family).
function _stripQuotes(sentence) {
  return sentence
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/‘[^’]*’/g, " ")
    .replace(/'[^']*'/g, " ");
}

// Pronoun → declared-gender bucket. Singular "they/them/their" maps
// to the "they" bucket — matches how the Characters dialog tags
// non-binary speakers.
const _PRONOUN_TO_GENDER = {
  he: "male", him: "male", his: "male",
  she: "female", her: "female", hers: "female",
  they: "they", them: "they", their: "they",
};

const _PRONOUN_RE = new RegExp(
  `\\b(${Object.keys(_PRONOUN_TO_GENDER).join("|")})\\b`,
  "i"
);

function _detectAttributionGender(sentence) {
  const outside = _stripQuotes(sentence);
  const m = outside.match(_PRONOUN_RE);
  if (!m) return null;
  return _PRONOUN_TO_GENDER[m[1].toLowerCase()] || null;
}

function segmentTextByCharacter(text, characters, fallbackVoiceId, fallbackSpeakerId) {
  const named = characters.filter((c) => c.name && c.name.trim() && c.voiceId);
  if (named.length === 0) {
    // Fast path: no characters defined → single narrator segment.
    const sentences = splitSentencesClient(text);
    return [{
      voiceId: fallbackVoiceId,
      speakerId: fallbackSpeakerId,
      text: sentences.join(" "),
    }];
  }

  const charRegexes = named.map((c) => ({
    voiceId: c.voiceId,
    speakerId: typeof c.speakerId === "number" ? c.speakerId : null,
    gender: c.gender || "", // "" | "male" | "female" | "they"
    re: new RegExp(`\\b${_escapeRegex(c.name)}\\b`, "i"),
  }));

  // First-match wins. Order is the user's roster order; if two
  // characters' names appear in the same sentence (rare), the earlier
  // one in the roster takes attribution. Users can re-order the roster
  // if this matters for their scene.
  function _findNamedChar(sentence) {
    for (const c of charRegexes) {
      if (c.re.test(sentence)) return c;
    }
    return null;
  }

  // Paragraph split: blank line(s) between blocks. Matches what most
  // pasted prose looks like; falls back gracefully to "one big
  // paragraph" if the user pastes a single block with no breaks (in
  // which case the cursor doesn't reset and the whole block is one
  // attribution chain).
  const paragraphs = text
    .split(/\r?\n\s*\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const segments = [];
  let current = null;

  // v220y Tier 3: cursors persist across paragraph boundaries. Real
  // prose names a character once per scene then refers to them by
  // pronoun for paragraphs after; the per-paragraph reset of Tier 2
  // dropped attribution every time the writer moved on. activeSpeaker
  // carries the most-recently-attributed character forward across
  // consecutive quote-only sentences so multi-sentence speeches share
  // one voice.
  let lastNamedChar = null;
  const lastByGender = { male: null, female: null, they: null };
  let activeSpeaker = null;

  for (const paragraph of paragraphs) {
    const sentences = splitSentencesClient(paragraph);
    for (const sentence of sentences) {
      let attributedVoice = fallbackVoiceId;
      let attributedSpeaker = fallbackSpeakerId;
      let attributedChar = null; // tracks the char object so we can
                                 // update activeSpeaker after the fact

      const hasQuote = _DIALOGUE_QUOTE.test(sentence);
      const explicitName = _findNamedChar(sentence);

      // Update lastNamedChar + lastByGender on ANY sentence that names
      // a character — narration counts too. The gender bucket only
      // updates when the character has a declared gender (unset
      // characters still contribute to the Tier 1 single-cursor
      // fallback).
      if (explicitName) {
        lastNamedChar = explicitName;
        if (
          explicitName.gender &&
          Object.prototype.hasOwnProperty.call(lastByGender, explicitName.gender)
        ) {
          lastByGender[explicitName.gender] = explicitName;
        }
      }

      if (hasQuote) {
        if (explicitName) {
          // 1) Named in this sentence + quote → direct attribution.
          attributedChar = explicitName;
        } else {
          // 2) No explicit name. Tier 2 (pronoun→gender) > Tier 3
          //    (activeSpeaker carry-forward) > Tier 1 (last-named) >
          //    narrator. Tier 3 sits ABOVE the Tier 1 fallback because
          //    a continuing speech is a stronger signal than "whoever
          //    was last mentioned in narration." Example:
          //      Llea looked at Tom. "I'm sorry," she said. "It's fine."
          //    Sentence 3 has no name, no pronoun. lastNamedChar = Tom
          //    (narration mention), activeSpeaker = Llea (just spoke).
          //    Carry-forward keeps Llea continuing her thought.
          const g = _detectAttributionGender(sentence);
          const fromGender = g && lastByGender[g];
          attributedChar = fromGender || activeSpeaker || lastNamedChar;
        }
        if (attributedChar) {
          attributedVoice = attributedChar.voiceId;
          attributedSpeaker = attributedChar.speakerId;
          activeSpeaker = attributedChar;
        }
      }
      // No quote → narrator. Cursors still updated above for the next
      // dialogue sentence's benefit. activeSpeaker is NOT cleared by
      // narration — a "She set both hands flat on the table." sentence
      // between two quotes shouldn't break the dialogue chain.

      if (
        current &&
        current.voiceId === attributedVoice &&
        current.speakerId === attributedSpeaker
      ) {
        current.text += " " + sentence;
      } else {
        current = {
          voiceId: attributedVoice,
          speakerId: attributedSpeaker,
          text: sentence,
        };
        segments.push(current);
      }
    }
  }
  return segments;
}

// Decode a base64 string to a Uint8Array for Blob construction.
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// When set, the next generate() will overwrite this clip id instead of
// creating a fresh one. Used by saveCurrentClipText() to re-synthesize
// when sentence count changes so karaoke alignment stays in sync.
let _regenTargetClipId = null;
// Re-narrate flow: capture the user's listening position at the moment
// they click "Re-narrate," then seek the new combined audio to that
// position after the swap. Without this, re-narrate effectively
// restarts the clip from sentence 0 — disorienting if you were
// halfway through a chapter.
let _regenResumeAtSec = null;
// While re-narrating, sentences still stream in via SSE but we don't
// auto-play them — startNextStreamSentence checks this flag and skips
// the play() call. The user sees the synthesis progress in the status
// line; audio resumes at the captured position once the combined swap
// completes.
let _regenSuppressStreaming = false;

// v220w: library re-narrate is a silent-refresh path. The user tapped 🔄
// on a card; they want the clip updated with the new voice but do NOT
// want stop-and-go playback during synthesis. On a 1-CPU Fly machine,
// per-sentence playback stalls every time the player runs ahead of the
// synth, which sounds like "the synthesis keeps stopping" (it isn't —
// playback is just outpacing it). This flag tells the SSE result
// handler to skip the auto-play at the end. Library re-narrate clears
// the chip pulse + updates the row; the user taps the card to play
// when they're ready.
let _libraryRenarrateNoAutoPlay = false;

async function generate() {
  // v141: belt-and-braces guard. The Generate button is also
  // disabled while a background queue runs, but a programmatic
  // call (e.g. _advanceChapterQueue racing the cancel path) could
  // still reach here — short-circuit with a clearer message than
  // "Type or paste some text first", which sent at least one
  // tester reaching for reload.
  if (_silentChapterQueue) {
    setStatus("Background queue is running — cancel it to generate manually.", true);
    return;
  }
  // Reset chapter-queue advance flags so this chapter starts with a
  // clean slate (only matters mid-queue — for non-queue generates the
  // flags should already be false and _chapterTotalCount is 0).
  _resetQueueAdvanceFlags();

  const text = textEl.value.trim();
  if (!text) {
    setStatus("Type or paste some text first.", true);
    textEl.focus();
    return;
  }
  // Fail fast when no voice is selected — otherwise the empty voice_id
  // routes through to SAPI's default (or worse, falls into a code path
  // that produces a malformed WAV that lameenc can't encode and the
  // user sees a baffling "mp3 encode failed" instead of "pick a voice").
  // The dropdown is empty when /api/voices failed to load (e.g., Fly.io
  // cold-start 503); the retry-banner path covers that case.
  if (!voiceEl.value) {
    if (_voicesLoadFailed) {
      setStatus(
        "Server's still waking up — voices haven't loaded yet. Hold on a moment.",
        true
      );
    } else {
      setStatus(
        "Pick a voice first — the dropdown is empty.",
        true
      );
    }
    return;
  }

  // Consume the regen target up front so a second concurrent generate()
  // call doesn't double-claim it. If set, fetch the existing clip's
  // identity (title / note / createdAt) so the regen preserves them
  // instead of falling back to auto-suggested defaults.
  const regenTargetId = _regenTargetClipId;
  _regenTargetClipId = null;
  let regenExistingMeta = null;
  if (regenTargetId) {
    try {
      const existing = await getClip(regenTargetId);
      if (existing) {
        regenExistingMeta = {
          title: existing.title,
          note: existing.note || "",
          createdAt: existing.createdAt,
          // Carry bookmarks through a regen — the audio length may have
          // shifted slightly, but the user's notes are too valuable to
          // wipe automatically. They can prune misaligned ones manually.
          bookmarks: Array.isArray(existing.bookmarks) ? existing.bookmarks : [],
          // Preserve URL-extracted images across a regen — the text
          // didn't change, so positions stay valid.
          images: Array.isArray(existing.images) ? existing.images : [],
          // Preserve gitRef. A voice-change regen of a git-sourced
          // clip doesn't change the SHA; a refetch-and-regen replaces
          // the gitRef via _pendingGitRef (the refetch path stashes
          // the new gitRef before invoking generate()).
          gitRef: existing.gitRef || null,
        };
      }
    } catch {}
  }

  _synthController = new AbortController();
  resetStream();
  sentenceOffsetsSec = [];
  // Clear the stale reading-view spans too — _maybeStartRenarrateResume
  // and the regular first-sentence branch both gate "have we rebuilt
  // the reading view yet?" on sentenceSpans.length === 0. Without this
  // reset, a re-narrate would never get past the guard since the loaded
  // clip's reading view leaves sentenceSpans populated.
  sentenceSpans = [];
  activeSentenceIdx = -1;
  enterBusyState();
  setStatus(regenTargetId ? "Re-synthesizing…" : "Starting synthesis…");

  // Character-voice mode kicks in only when Author mode is on, the user
  // has defined at least one character with a voice assigned, AND the
  // text actually contains attributable dialogue (the detection function
  // returns >1 segment). Otherwise we fall through to the regular
  // single-voice synth path.
  const fallbackVoice = voiceEl.value || null;
  const fallbackSpeaker = speakerRow.hidden
    ? null
    : Number(speakerEl.value || 0);
  let endpoint = "/api/synthesize/stream";
  let requestBody;
  let charactersUsed = 0;
  if (isAuthorMode()) {
    const characters = _loadCharacters().filter((c) => c.name && c.voiceId);
    if (characters.length > 0) {
      const segs = segmentTextByCharacter(
        text, characters, fallbackVoice, fallbackSpeaker
      );
      // Only flip to the segments endpoint if detection actually
      // produced more than one segment — otherwise the regular endpoint
      // is faster and identical in output.
      if (segs.length > 1) {
        endpoint = "/api/synthesize/segments/stream";
        requestBody = JSON.stringify({
          segments: segs.map((s) => ({
            text: s.text,
            voice_id: s.voiceId,
            speaker_id: s.speakerId,
          })),
          rate: Number(rateEl.value),
          volume: Number(volumeEl.value) / 100,
        });
        // Count distinct character voices that actually show up so the
        // status line can give the user feedback.
        const used = new Set();
        for (const s of segs) {
          if (s.voiceId && s.voiceId !== fallbackVoice) used.add(s.voiceId);
        }
        charactersUsed = used.size;
      }
    }
  }
  if (!requestBody) {
    requestBody = JSON.stringify({
      text,
      voice_id: fallbackVoice,
      rate: Number(rateEl.value),
      volume: Number(volumeEl.value) / 100,
      speaker_id: fallbackSpeaker,
    });
  }
  if (charactersUsed > 0) {
    setStatus(
      `Synthesising with ${charactersUsed} character voice${charactersUsed === 1 ? "" : "s"}…`
    );
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: _synthController.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }

    // Parse the SSE stream manually (EventSource only supports GET).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are terminated by \n\n
      const blocks = buf.split("\n\n");
      buf = blocks.pop(); // keep any incomplete trailing block
      for (const block of blocks) {
        const line = block.trim();
        if (!line.startsWith("data:")) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (event.type === "sentence") {
          // Decode this sentence's WAV (may be empty for silent SAPI chunks)
          // and queue it up. Empty entries get a null URL so the playback
          // chain skips them while keeping index alignment with the offsets.
          const bytes = event.wav_b64 ? base64ToBytes(event.wav_b64) : new Uint8Array(0);
          const url = bytes.length > 0
            ? URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))
            : null;
          _streamQueue.push({ url, durationSec: 0 });
          sentenceOffsetsSec[event.index] = event.offset_ms / 1000;

          synthProgress.max = event.total;
          synthProgress.value = event.index + 1;
          setStatus(`Synthesising… ${event.index + 1} / ${event.total} sentences`);

          // Re-narrate kick-off: we deliberately suppress streaming
          // playback so the new voice doesn't start at sentence 0 while
          // the user was at sentence 5. Wait until we've queued enough
          // sentences to cover the resume position, then start there.
          if (_regenSuppressStreaming && _streamPlayhead < 0) {
            // Build the reading view exactly once per regen — once
            // sentenceSpans is populated for the new text, subsequent
            // sentence events skip the rebuild.
            if (sentenceSpans.length === 0) {
              enterReadingView(
                text,
                regenExistingMeta && Array.isArray(regenExistingMeta.images)
                  ? regenExistingMeta.images
                  : (_pendingImages || [])
              );
              setMediaMetadata(text);
              playerCard.hidden = false;
            }
            _maybeStartRenarrateResume(event.total);
          } else if (_streamPlayhead < 0 && url) {
            // Normal first-sentence path: kick off streaming playback.
            enterReadingView(
              text,
              regenExistingMeta && Array.isArray(regenExistingMeta.images)
                ? regenExistingMeta.images
                : (_pendingImages || [])
            );
            setMediaMetadata(text);
            playerCard.hidden = false;
            startNextStreamSentence();
          } else if (
            // We were stalled at end-of-current waiting for more audio;
            // the just-arrived sentence is the one we need.
            _streamPlayhead >= 0 && playerEl.ended &&
            _streamPlayhead === _streamQueue.length - 2
          ) {
            startNextStreamSentence();
          }

        } else if (event.type === "result") {
          // Synthesis is done — swap the player from per-sentence WAVs to the
          // full combined audio (now MP3-encoded server-side, ~5x smaller than
          // WAV with no audible loss for speech). After the swap, native seek,
          // download, and library save all see one continuous audio track.
          // There may be a brief audible glitch at the swap; the tradeoff is
          // that the rest of the playback Just Works.
          const combined = new Blob([base64ToBytes(event.mp3_b64)], { type: "audio/mpeg" });
          sentenceOffsetsSec = (event.sentence_offsets_ms || []).map((ms) => ms / 1000);

          if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
          lastBlob = combined;
          lastBlobUrl = URL.createObjectURL(combined);

          // Re-narrate overrides: when the user clicked "Re-narrate
          // with X," _regenResumeAtSec carries the pre-renarrate
          // virtualTime so we resume there instead of wherever the
          // streaming playhead happened to land. _regenSuppressStreaming
          // also tells us to force-resume after the seek (since the
          // player has been intentionally paused throughout streaming
          // and wasPlaying would otherwise be false).
          const renarrateActive = _regenSuppressStreaming;
          const targetTime =
            _regenResumeAtSec != null ? _regenResumeAtSec : virtualTime();
          _regenResumeAtSec = null;
          _regenSuppressStreaming = false;
          const wasPlaying = !playerEl.paused && !playerEl.ended;
          const startedFresh = _streamPlayhead < 0; // no playback at all yet
          _streamPlayhead = -1;
          _streamElapsed = 0;

          playerCard.hidden = false;
          // Make sure the reading view is set up — for very short inputs the
          // sentence event might not have fired the first-sentence branch.
          if (sentenceSpans.length === 0) {
            enterReadingView(
              text,
              regenExistingMeta && Array.isArray(regenExistingMeta.images)
                ? regenExistingMeta.images
                : (_pendingImages || [])
            );
            setMediaMetadata(text);
          }

          const voiceName = voiceEl.selectedOptions[0]?.textContent || voiceEl.value || "";
          // If we're regenerating, reuse the existing clip id so the row
          // updates in place. Otherwise mint a fresh id from the wall clock.
          const newClipId = regenTargetId || Date.now();
          const onLoaded = () => {
            if (isFinite(playerEl.duration)) {
              playerEl.currentTime = Math.min(targetTime, playerEl.duration);
            }
            // wasPlaying captures whether the user was hearing audio
            // before the swap. For re-narrate, streaming was suppressed
            // so wasPlaying is always false — but the user explicitly
            // asked to re-narrate, so we resume regardless.
            //
            // v220w: library re-narrate is the exception — see
            // _libraryRenarrateNoAutoPlay declaration. The user tapped 🔄
            // on a card and doesn't want playback to start.
            if (
              !_libraryRenarrateNoAutoPlay &&
              (wasPlaying || startedFresh || renarrateActive)
            ) {
              playerEl.play().catch(() => {});
            }
            _libraryRenarrateNoAutoPlay = false;
            // Track which library row this player is bound to so the
            // progress-save throttle can update the right one.
            _currentClipId = newClipId;
            _currentPlayingVoiceId = voiceEl.value || null;
            _lastProgressSaveAt = Date.now(); // suppress an immediate redundant save
            saveClip({
              id: newClipId,
              // For regen, preserve whatever title/note/createdAt the user
              // had on the original clip so re-narration doesn't blow away
              // a custom title or note. For new clips, fall back to the
              // auto-suggested title.
              // Chapter queue (if active) supplies the title for new clips
              // — that's how "Chapter 3: The Crossing" lands in the library
              // instead of the auto-suggested first-line title.
              title: regenExistingMeta
                ? regenExistingMeta.title
                : (_pendingChapterTitle || makeTitle(text)),
              note: regenExistingMeta ? regenExistingMeta.note : "",
              text,
              voiceId: voiceEl.value || null,
              voiceName,
              rate: Number(rateEl.value),
              volume: Number(volumeEl.value) / 100,
              speakerId: speakerRow.hidden ? null : Number(speakerEl.value || 0),
              // v219: snapshot voice provenance at generation time. If a
              // regen reuses an old voice on a fresh tier, this records
              // what's true *now*, which is what matters for the audio
              // file produced now. For library import of pre-v219 clips,
              // these fields are simply absent and the Edit dialog falls
              // back to "Unknown provenance."
              provenance: (() => {
                const p = _voiceProvenance(voiceEl.value);
                return p
                  ? {
                      voiceId: voiceEl.value || null,
                      speakerId: speakerRow.hidden
                        ? null
                        : Number(speakerEl.value || 0),
                      voiceName,
                      license: p.license,
                      licenseDataset: p.licenseDataset,
                      licenseCommercial: p.licenseCommercial,
                      attribution: p.attribution,
                      capturedAt: Date.now(),
                    }
                  : null;
              })(),
              sentenceOffsetsSec: sentenceOffsetsSec.slice(),
              blob: combined,
              durationSec: isFinite(playerEl.duration) ? playerEl.duration : 0,
              progressSec: 0,
              // Empty for fresh clips, preserved across regen.
              bookmarks: regenExistingMeta ? regenExistingMeta.bookmarks : [],
              // Carry any URL-extracted images onto the clip. Existing
              // images survive a regen (text didn't change → positions
              // still valid); only a new URL fetch can replace them.
              images: regenExistingMeta && Array.isArray(regenExistingMeta.images)
                ? regenExistingMeta.images
                : (_pendingImages || []),
              // GitHub source pin.
              //   - Refetch regen: _pendingGitRef is set to the NEW SHA
              //     from the refetch — must win, else the outdated
              //     banner would fire again on next load (loop).
              //   - Voice-change regen: _pendingGitRef is null
              //     (cleared after prior save), so existing wins. SHA
              //     stays correct because text didn't change.
              //   - Fresh clip: regenExistingMeta is null, _pending wins.
              gitRef: _pendingGitRef
                ? _pendingGitRef
                : (regenExistingMeta && regenExistingMeta.gitRef
                    ? regenExistingMeta.gitRef
                    : null),
              createdAt: regenExistingMeta
                ? regenExistingMeta.createdAt
                : new Date().toISOString(),
            })
              .then(() => {
                // v220q: clear the busy state for this clip if it was
                // marked by _libraryRenarrate. renderLibrary() below
                // already re-renders cards; _renarratingClipIds is
                // checked by makeClipCard so the pulse stops naturally.
                if (regenTargetId) _renarratingClipIds.delete(regenTargetId);
                renderLibrary();
                // For a regen this picks up the existing bookmarks (which
                // we want to preserve across re-synthesis); for a fresh
                // clip this just renders the empty list (hidden).
                renderBookmarks();
                _updateMiniPlayerTitle();
                // Consume the pending chapter title now that the save has
                // landed; the next chapter (if queued) will set its own.
                _pendingChapterTitle = null;
                // Pending images have been written to the clip — clear so
                // they don't leak into the next fresh clip the user types.
                _pendingImages = [];
  _pendingGitRef = null;
                _pendingGitRef = null;
                // Chapter queue: mark "save side" complete and try to
                // advance. The audio side is signaled separately by
                // streaming exhaustion or the combined MP3's 'ended'.
                // Both must fire before _tryAdvanceQueue does anything,
                // and either ordering works (one sets its flag, the
                // other sees both true and schedules the advance).
                if (_chapterTotalCount > 0) {
                  _queueSaveComplete = true;
                  _tryAdvanceQueue();
                  // Kick off background synthesis of the NEXT chapter
                  // so it's ready to play instantly when this one ends.
                  // Skipped when a regen is pending or another pre-synth
                  // is already in flight (one lookahead at a time).
                  if (
                    _chapterQueue.length > 0 &&
                    !_preSynthChapter &&
                    !_preSynthController &&
                    !_regenTargetClipId
                  ) {
                    _preSynthesizeChapter(_chapterQueue[0]);
                  }
                }
              })
              .catch((e) => console.warn("library save failed:", e));
          };
          playerEl.addEventListener("loadedmetadata", onLoaded, { once: true });
          playerEl.src = lastBlobUrl;

          setStatus(`Ready · ${(combined.size / 1024).toFixed(0)} KB`);

        } else if (event.type === "error") {
          throw new Error(event.message || "synthesis error");
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // Leave the partially-streamed audio in place so the user can keep
      // listening to what was already synthesized.
      setStatus("Cancelled.");
    } else {
      setStatus(`Failed: ${err.message}`, true);
    }
  } finally {
    _synthController = null;
    exitBusyState();
    // Always clear regen state on exit so a stale resume-at doesn't
    // leak into a fresh, unrelated generate. The "success" path inside
    // the result event already clears these, but cancellation /
    // synthesis errors land here without going through that branch.
    _regenResumeAtSec = null;
    _regenSuppressStreaming = false;
    // v220w: same — a cancelled library re-narrate would otherwise
    // leave the no-autoplay flag stuck for the next manual generate.
    _libraryRenarrateNoAutoPlay = false;
  }
}

function download() {
  if (!lastBlob) return;
  const a = document.createElement("a");
  a.href = lastBlobUrl;
  // Pick extension from the blob's MIME so we keep working with WAV clips
  // saved before MP3 export landed. (audio/mpeg → .mp3, audio/wav → .wav.)
  const ext = (lastBlob && lastBlob.type === "audio/mpeg") ? "mp3" : "wav";
  a.download = `narrative.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

generateBtn.addEventListener("click", () => {
  if (_synthController) {
    // Button is in "Cancel" mode — abort the in-flight request.
    _synthController.abort();
  } else {
    generate();
  }
});
downloadBtn.addEventListener("click", download);

// Cmd/Ctrl+Enter to generate from the textarea
textEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    generate();
  }
});

// ---- Custom audio player wiring ----------------------------------------
// Bind the visible play/pause/scrubber/mute to the underlying <audio>
// element. The native element handles MediaSession, blob loading, and
// chained per-sentence playback unchanged; we just replace its visible
// chrome. Pause/play events from MediaSession, the keyboard, or our
// other handlers all flow through the audio element's event stream,
// so the UI stays in sync automatically.

function _cpFormatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

// Format a duration as "Xh Ym" (or just "Ym" / "Ys" when shorter) for
// the speed-effective annotation and tooltip. The cp-time M:SS format
// is too cramped for long audiobooks ("203:14" reads worse than
// "3h 23m"), and at wall-clock granularity seconds aren't useful.
function _fmtDurationCoarse(sec) {
  if (!isFinite(sec) || sec < 0) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// SVG-safe hidden toggle. `svg.hidden = true` sets the IDL property
// but doesn't reflect to the content attribute the way it does for
// HTMLElement, so the [hidden] CSS selector never matches and our
// `display: block` rule keeps the icon visible. setAttribute /
// removeAttribute is the explicit workaround. (HTML elements work
// fine with .hidden = ..., this helper just handles SVG too.)
function _setSvgHidden(el, hide) {
  if (hide) el.setAttribute("hidden", "");
  else el.removeAttribute("hidden");
}

function _cpRefreshPlayIcon() {
  const playing = !playerEl.paused && !playerEl.ended;
  _setSvgHidden(cpPlayIcon, playing);
  _setSvgHidden(cpPauseIcon, !playing);
  cpPlayBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  // v188: mirror the same state on the hero play button. Same icon
  // swap, same aria. The two buttons feed the same playback so they
  // always agree.
  const heroPlay = document.getElementById("hero-play-icon");
  const heroPause = document.getElementById("hero-pause-icon");
  const heroBtn = document.getElementById("hero-play-btn");
  if (heroPlay && heroPause) {
    _setSvgHidden(heroPlay, playing);
    _setSvgHidden(heroPause, !playing);
  }
  if (heroBtn) heroBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function _cpRefreshTime() {
  const cur = playerEl.currentTime || 0;
  const dur = isFinite(playerEl.duration) ? playerEl.duration : 0;
  cpTimeCurrent.textContent = _cpFormatTime(cur);
  cpTimeDuration.textContent = _cpFormatTime(dur);
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  cpProgress.style.width = `${pct}%`;
  cpThumb.style.left = `${pct}%`;
  cpScrubber.setAttribute("aria-valuenow", String(Math.round(pct)));
  // Wall-clock-remaining annotation. Only shown at non-1× speed —
  // at 1× the M:SS duration above already answers it.
  if (cpTimeEffective) {
    const speed = _playbackRate || 1;
    if (speed !== 1 && dur > 0) {
      const remaining = Math.max(0, (dur - cur) / speed);
      cpTimeEffective.textContent = `· ${_fmtDurationCoarse(remaining)} left`;
      cpTimeEffective.hidden = false;
    } else {
      cpTimeEffective.hidden = true;
      cpTimeEffective.textContent = "";
    }
  }
}

function _cpRefreshBuffered() {
  const dur = isFinite(playerEl.duration) ? playerEl.duration : 0;
  if (dur <= 0 || !playerEl.buffered.length) {
    cpBuffered.style.width = "0%";
    return;
  }
  let end = 0;
  for (let i = 0; i < playerEl.buffered.length; i++) {
    end = Math.max(end, playerEl.buffered.end(i));
  }
  cpBuffered.style.width = `${Math.min(100, (end / dur) * 100)}%`;
}

function _cpRefreshMute() {
  const muted = playerEl.muted || playerEl.volume === 0;
  _setSvgHidden(cpVolIcon, muted);
  _setSvgHidden(cpMuteIcon, !muted);
  cpMuteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
}

cpPlayBtn.addEventListener("click", () => {
  if (playerEl.paused) {
    playerEl.play().catch(() => {});
  } else {
    _pauseAsUser();
  }
});

// v188: hero Play/Pause button — same toggle as cp-play-btn so a
// user can drive playback from the top of the page without
// scrolling to the player card. _cpRefreshPlayIcon keeps the
// icons in sync. Wire here (vs in the migration block below) so
// the click handler is bound to the actual DOM node, not a clone.
const heroPlayBtn = document.getElementById("hero-play-btn");
if (heroPlayBtn) {
  heroPlayBtn.addEventListener("click", () => {
    if (playerEl.paused) {
      playerEl.play().catch(() => {});
    } else {
      _pauseAsUser();
    }
  });
}

// v198: phones bypass the v188/v195 dual-strip system entirely.
// The user wanted the hero-inline + floating-clone behavior for
// tablet and desktop only; on phones the chips stay where they
// always were — in .player-actions inside the player card, as a
// horizontal-scrolling row. This shared gate runs ONCE so both
// the migration and the clone-build IIFEs see the same answer
// (a viewport resize across the breakpoint isn't handled
// post-init; assumed stable for the session).
const _heroStripsActive = !window.matchMedia("(max-width: 720px)").matches;

// v195: dual chip strips with cross-fade. The hero strip
// (#hero-controls) lives inside .hero-row's flex middle slot and
// is visible when the user is at the top of the page — sitting in
// the otherwise-empty space between the "Narrative" wordmark and
// the icon rail. When the user scrolls past the player card, the
// hero strip naturally scrolls out of view; at that point the
// floating clone (#hero-controls-float) fades in at top: 6px so
// the controls remain reachable. The two strips share state via:
//   - one set of ORIGINAL chip DOM nodes inside #hero-controls
//     (event handlers bound here as usual)
//   - CLONED chip nodes inside #hero-controls-float that forward
//     clicks to the originals and mirror the originals' textContent
//     / class / [hidden] state via MutationObserver
// This avoids touching the existing per-chip event handlers — they
// stay bound to the originals and Just Work.
(() => {
  if (!_heroStripsActive) return;  // v198: phones keep chips in player card
  const heroControls = document.getElementById("hero-controls");
  const playerActions = document.querySelector("section.player .player-actions");
  if (!heroControls || !playerActions) return;
  const toMove = [
    "skip-back-btn",
    "skip-forward-btn",
    "bookmark-add-btn",
    "sleep-btn",
    "ab-loop-btn",
    "speed-btn",
    "notes-btn",
  ];
  for (const id of toMove) {
    const el = document.getElementById(id);
    if (el) heroControls.appendChild(el);
  }
})();

// v195: build the floating clone strip.
(() => {
  if (!_heroStripsActive) return;  // v198: phones bypass
  const heroControls = document.getElementById("hero-controls");
  const floatStrip = document.getElementById("hero-controls-float");
  const playerCard = document.getElementById("player-card");
  if (!heroControls || !floatStrip || !playerCard) return;

  // Mirror originals → clones inside the float container. For each
  // child of #hero-controls we make a deep clone, strip duplicate
  // IDs (browsers tolerate dupes but they break getElementById and
  // any future a11y label lookup), forward clicks, and observe the
  // original for state changes.
  const pairs = [];
  Array.from(heroControls.children).forEach((original) => {
    const clone = original.cloneNode(true);
    // Strip ID on the clone root + any descendants (the SVG icons
    // inside the round play button each carry an ID).
    if (clone.id) clone.id = clone.id + "-fl";
    clone.querySelectorAll("[id]").forEach((el) => {
      el.id = el.id + "-fl";
    });
    floatStrip.appendChild(clone);
    pairs.push({ original, clone });

    // Forward clicks. preventDefault/stopPropagation so the
    // clone's own bubbling doesn't double-fire if any ancestor
    // delegate listens for chip events.
    clone.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      original.click();
    });

    // Mirror state. Watching the original for any textContent /
    // attribute / subtree mutation, we resync the clone's innerHTML
    // + className. The click listener stays on the clone root
    // (innerHTML only replaces descendants), so forwarding survives.
    const sync = () => {
      // Bail if nothing actually changed visually — avoids needless
      // reflows when the cycle handler touches a sibling.
      if (clone.innerHTML !== original.innerHTML) {
        clone.innerHTML = original.innerHTML;
        // Re-mangle IDs that just came back via innerHTML so we
        // never reintroduce duplicates.
        clone.querySelectorAll("[id]").forEach((el) => {
          if (!el.id.endsWith("-fl")) el.id = el.id + "-fl";
        });
      }
      if (clone.className !== original.className) {
        clone.className = original.className;
      }
      if (clone.hidden !== original.hidden) {
        clone.hidden = original.hidden;
      }
      if (clone.disabled !== original.disabled) {
        clone.disabled = original.disabled;
      }
    };
    new MutationObserver(sync).observe(original, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
  });

  // Hero strip visibility (clip loaded vs not) tracks the player
  // card's [hidden] state — same v188 model. Float visibility
  // additionally requires the player card to have scrolled off
  // the top of the viewport.
  const syncHidden = () => {
    heroControls.hidden = playerCard.hidden;
    // If the clip just got cleared, hide the float immediately
    // regardless of scroll state.
    if (playerCard.hidden) {
      floatStrip.hidden = true;
      floatStrip.dataset.visible = "false";
    }
  };
  syncHidden();
  new MutationObserver(syncHidden).observe(playerCard, {
    attributes: true,
    attributeFilter: ["hidden"],
  });

  // IntersectionObserver: fade float in when the HERO STRIP has
  // entirely scrolled above the viewport. Watching the hero (not
  // the player card) closes the v195a gap — there's a stretch
  // where the hero has scrolled out but the player card is still
  // visible below, and watching the player card meant the float
  // sat hidden during that stretch. Watching the hero strip
  // itself triggers the float the moment the inline strip leaves
  // the viewport top.
  const observerTarget = heroControls;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const scrolledPast = entry.boundingClientRect.bottom < 0;
        const shouldShow = scrolledPast && !playerCard.hidden;
        if (shouldShow) {
          floatStrip.hidden = false;
          // Force a layout pass so the initial opacity transition
          // actually animates on first show.
          void floatStrip.offsetHeight;
          floatStrip.dataset.visible = "true";
        } else {
          floatStrip.dataset.visible = "false";
          // Wait for the fade-out before hiding so the transition
          // can run; matches the CSS duration.
          setTimeout(() => {
            if (floatStrip.dataset.visible !== "true") {
              floatStrip.hidden = true;
            }
          }, 240);
        }
      }
    },
    { threshold: 0 }
  );
  observer.observe(observerTarget);

  // Initial state.
  floatStrip.dataset.visible = "false";
})();

cpMuteBtn.addEventListener("click", () => {
  playerEl.muted = !playerEl.muted;
  _cpRefreshMute();
});

// Scrubber: click anywhere on the track to seek; drag the thumb to scrub.
// Uses Pointer Events so the same code path handles mouse, touch, and
// stylus without three implementations.
let _cpScrubbing = false;
function _cpSeekFromPointer(ev) {
  const rect = cpScrubber.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, x / rect.width));
  const dur = isFinite(playerEl.duration) ? playerEl.duration : 0;
  if (dur > 0) {
    playerEl.currentTime = pct * dur;
    _cpRefreshTime();
  }
}
cpScrubber.addEventListener("pointerdown", (ev) => {
  _cpScrubbing = true;
  cpScrubber.classList.add("dragging");
  cpScrubber.setPointerCapture(ev.pointerId);
  _cpSeekFromPointer(ev);
});
cpScrubber.addEventListener("pointermove", (ev) => {
  if (_cpScrubbing) _cpSeekFromPointer(ev);
});
cpScrubber.addEventListener("pointerup", (ev) => {
  if (!_cpScrubbing) return;
  _cpScrubbing = false;
  cpScrubber.classList.remove("dragging");
  try { cpScrubber.releasePointerCapture(ev.pointerId); } catch {}
});
cpScrubber.addEventListener("pointercancel", () => {
  _cpScrubbing = false;
  cpScrubber.classList.remove("dragging");
});
// Keyboard: ← / → seek by 5s; Home / End jump to start / end.
cpScrubber.addEventListener("keydown", (ev) => {
  const dur = isFinite(playerEl.duration) ? playerEl.duration : 0;
  if (!dur) return;
  if (ev.key === "ArrowLeft") {
    playerEl.currentTime = Math.max(0, playerEl.currentTime - 5);
    ev.preventDefault();
  } else if (ev.key === "ArrowRight") {
    playerEl.currentTime = Math.min(dur, playerEl.currentTime + 5);
    ev.preventDefault();
  } else if (ev.key === "Home") {
    playerEl.currentTime = 0;
    ev.preventDefault();
  } else if (ev.key === "End") {
    playerEl.currentTime = dur;
    ev.preventDefault();
  }
});

// Mirror native events into the custom UI. All four are needed: play/
// pause for the icon, timeupdate for the scrubber, durationchange so
// freshly-loaded clips show their length immediately, progress so the
// buffered fill catches up as the audio downloads.
playerEl.addEventListener("play", _cpRefreshPlayIcon);
playerEl.addEventListener("pause", _cpRefreshPlayIcon);
playerEl.addEventListener("ended", _cpRefreshPlayIcon);
playerEl.addEventListener("timeupdate", _cpRefreshTime);
playerEl.addEventListener("durationchange", _cpRefreshTime);
playerEl.addEventListener("loadedmetadata", () => {
  _cpRefreshTime();
  _cpRefreshBuffered();
});
playerEl.addEventListener("progress", _cpRefreshBuffered);
playerEl.addEventListener("volumechange", _cpRefreshMute);
// Initial paint so the controls don't show blank before any audio loads.
_cpRefreshPlayIcon();
_cpRefreshTime();
_cpRefreshMute();

loadVoices();
setupMediaSession();

// ---- Media Session API ----------------------------------------------------
// Surfaces play/pause/seek controls on the phone lock screen, Control Center
// (iOS), and notification shade (Android). Also makes the app respond to
// physical media keys on desktop. Falls back silently if unsupported.

function makeTitle(text) {
  const firstLine = (text || "").trim().split(/\r?\n/, 1)[0];
  const trimmed = firstLine.slice(0, 60).trim();
  if (!trimmed) return "Narrative";
  return firstLine.length > 60 ? `${trimmed}…` : trimmed;
}

// ---- Chapter auto-split --------------------------------------------------
// When a paste / file-load / URL-fetch lands in the textarea, scan for
// chapter markers. If 2+ are found, surface a banner offering to split
// the text into separate clips. On Split: chapter 1 goes into the
// textarea, the rest queue up, generate() picks them off one by one and
// auto-continues until the queue drains. Single button push, walk away,
// come back to a fully-narrated book.

const chapterBanner = $("chapter-banner");
const chapterBannerCount = $("chapter-banner-count");
const chapterBannerSplit = $("chapter-banner-split");
const chapterBannerDismiss = $("chapter-banner-dismiss");
const chapterQueueEl = $("chapter-queue");
const chapterQueueText = $("chapter-queue-text");
const chapterQueueCancel = $("chapter-queue-cancel");

let _chapterQueue = [];          // [{title, text}] still to synthesize
let _chapterTotalCount = 0;      // fixed for the life of the queue
let _chapterCurrentIndex = 0;    // 1-based; what's loaded in the textarea right now
let _pendingChapterTitle = null; // consumed by generate() in place of makeTitle
let _detectedChapters = null;    // hangs around between banner show and Split click
// v139: background-mode queue. When true, _startBackgroundChapterQueue
// drives the chapter loop via _preSynthesizeChapter sequentially; no
// audio ever loads into the player, and _advanceChapterQueue (the
// foreground autoplay path) is bypassed entirely.
let _silentChapterQueue = false;
// v141: live per-chapter progress for the silent queue, sourced from
// the synthesizer's SSE `sentence` events. Without these the pill
// only ticked once per chapter (which can be MINUTES for a long
// one), making the queue look stuck. _bgSynthCurrentTitle holds the
// chapter whose synthesis is in flight; _bgSynthSentence /
// _bgSynthTotal are the latest counter and target.
let _bgSynthCurrentTitle = "";
let _bgSynthSentence = 0;
let _bgSynthTotal = 0;

// Pre-synthesis lookahead: chapter N+1 gets synthesized in the background
// while the user listens to chapter N, then loaded instantly from the
// library when chapter N's audio ends. _preSynthChapter holds {clipId,
// title} of the ready chapter; _preSynthController aborts any in-flight
// background fetch (used by cancel / regen / clear paths).
let _preSynthChapter = null;
let _preSynthController = null;

// Try each chapter-marker family in priority order. First family with
// 2+ matches wins; later families are ignored to avoid double-splitting.
// Returns null when nothing structured was found.
// Front-matter titles whose body content is reference / list / metadata
// and not worth synthesizing as audio. Match is case-insensitive against
// the heading text after the v84 normalization (so "## CONTENTS" lands
// here as "CONTENTS", and a "Table of Contents" header on another source
// also matches). PREFACE / FOREWORD / INTRODUCTION are intentionally
// NOT in this set — those are usually real prose.
const FRONT_MATTER_TITLES = new Set([
  "contents",
  "table of contents",
  "list of contents",
  "illustrations",
  "list of illustrations",
  "index",
  "glossary",
  "bibliography",
  "references",
  "colophon",
  "imprint",
  "copyright",
  "acknowledgements",
  "acknowledgments",
  "about the author",
  "about this book",
]);

function _isSkippableFrontMatter(title, body) {
  const t = (title || "").trim().toLowerCase().replace(/[:\-—.]+\s*$/, "");
  if (FRONT_MATTER_TITLES.has(t)) return true;
  // Belt-and-suspenders: if the body is dominated by short "CHAPTER N"
  // lines (a flattened TOC that escaped the title filter — happens when
  // a source uses a non-standard heading like "Table" instead of
  // "Contents"), treat it as front matter. Threshold: more than half the
  // non-blank lines are bare chapter references.
  const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const chapterishRe = /^(chapter|part|book|section)\s+[0-9ivxlcdm]+/i;
  const chapterish = lines.filter((ln) => chapterishRe.test(ln)).length;
  return chapterish / lines.length > 0.5;
}

function _detectChapters(text) {
  if (!text || text.length < 400) return null;
  const lines = text.split(/\r?\n/);

  // Pattern families. Each function maps a line to either null (no
  // match) or a title string.
  const families = [
    // Markdown ATX headings (# / ## / ###).
    (line) => {
      const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (!m) return null;
      const raw = m[2].trim();
      // Standard Ebooks renders chapter headings as bare Roman numerals
      // (## I, ## II, ## III) — a title of just "I" is useless in the
      // library, so promote it to "Chapter I" / "Chapter 12".
      if (/^[0-9]+$/.test(raw) || /^[ivxlcdm]+$/i.test(raw)) {
        return `Chapter ${raw.toUpperCase()}`;
      }
      // "CHAPTER I" / "Chapter II" / "PART 3" / "Part Three" — Project
      // Gutenberg headings injected server-side land here in ALL CAPS.
      // Title-case the keyword and keep whatever comes after it
      // (numeral + optional subtitle) intact so the library cards read
      // as "Chapter I" not "CHAPTER I".
      const k = raw.match(
        /^(chapter|part|book|section)\b\s*(.*)$/i
      );
      if (k) {
        const word = k[1].charAt(0).toUpperCase() + k[1].slice(1).toLowerCase();
        const rest = (k[2] || "").trim();
        return rest ? `${word} ${rest}` : word;
      }
      // Real titles like "Preface", "The Garden Party" flow through.
      return raw;
    },
    // "Chapter N" / "CHAPTER 12" / "Chapter One" / "Part 3" — optional
    // subtitle after a colon, em-dash, period, or just a space.
    (line) => {
      const m = line
        .trim()
        .match(
          /^(chapter|part|book|section)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b[\s.:—–-]*(.*)$/i
        );
      if (!m) return null;
      const word = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      const num = m[2].trim();
      const subtitle = (m[3] || "").trim();
      const head = `${word} ${num}`;
      return subtitle ? `${head}: ${subtitle}` : head;
    },
  ];

  for (const match of families) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const t = match(lines[i]);
      if (t) hits.push({ lineIdx: i, title: t });
    }
    if (hits.length < 2) continue;

    // Build chapters: body of chapter i is lines (hits[i]+1 .. hits[i+1]-1).
    const chapters = [];
    for (let h = 0; h < hits.length; h++) {
      const startLine = hits[h].lineIdx + 1;
      const endLine = h + 1 < hits.length ? hits[h + 1].lineIdx : lines.length;
      const body = lines.slice(startLine, endLine).join("\n").trim();
      // Skip chapters with nothing in them (a stray "Chapter 1" with no
      // following prose isn't worth a clip — saves the user from a junk
      // entry in their library).
      if (!body) continue;
      // Skip common front-matter sections that aren't worth listening to
      // as audio. The Project Gutenberg heading-injection pass surfaces
      // these as their own "chapters" — without the filter, TOC content
      // (35 "CHAPTER N." entries, each treated as a sentence with a
      // pause after it) ends up as the second clip in the queue.
      // PREFACE deliberately omitted — it's real prose worth hearing.
      if (_isSkippableFrontMatter(hits[h].title, body)) continue;
      chapters.push({ title: hits[h].title, text: body });
    }
    if (chapters.length < 2) continue;

    // Preamble before chapter 1: if it's shortish, fold into chapter 1.
    // If it's substantial (likely real prose like a foreword), promote
    // it to its own segment with an auto-suggested title.
    const preamble = lines.slice(0, hits[0].lineIdx).join("\n").trim();
    if (preamble) {
      if (preamble.length < 800) {
        chapters[0].text = preamble + "\n\n" + chapters[0].text;
      } else {
        chapters.unshift({ title: makeTitle(preamble), text: preamble });
      }
    }
    return chapters;
  }
  return null;
}

function _showChapterBanner(chapters) {
  _detectedChapters = chapters;
  chapterBannerCount.textContent =
    chapters.length === 1 ? "1 chapter" : `${chapters.length} chapters`;
  chapterBanner.hidden = false;
}

function _hideChapterBanner() {
  _detectedChapters = null;
  chapterBanner.hidden = true;
}

function _updateChapterQueueUI() {
  // v162: silent queue may be active even when _chapterTotalCount is
  // 0 (a single job was queued, picked up, and is in flight; the
  // queue array is empty but _bgCurrent isn't). Treat either signal
  // as "we have something to show in the pill."
  const silentActive = _silentChapterQueue || _bgCurrent;
  if (_chapterTotalCount <= 0 && !silentActive) {
    chapterQueueEl.hidden = true;
    return;
  }
  chapterQueueEl.hidden = false;
  const idx = _chapterCurrentIndex;
  const total = _chapterTotalCount;
  const nextTitle = _chapterQueue.length > 0 ? _chapterQueue[0].title : null;
  // v139: background-mode pill makes it explicit that nothing's
  // about to play — the user opted in for silent upload while away.
  // v141: add the current chapter's title + live sentence progress
  // (sourced from SSE in _preSynthesizeChapter) so a long chapter
  // doesn't look stuck. Also mark the pill .background-active so
  // the CSS pulse dot kicks in.
  if (silentActive) {
    chapterQueueEl.classList.add("background-active");
    const curTitle = _bgSynthCurrentTitle || (_bgCurrent && _bgCurrent.title) || "";
    const progress = _bgSynthTotal > 0
      ? ` · ${_bgSynthSentence}/${_bgSynthTotal} sentences`
      : "";
    const curLabel = curTitle ? `: ${curTitle}` : "";
    // v162: drop "X of Y" — the persistent queue can grow mid-flight,
    // so a fixed-total count goes stale. Show the current title +
    // sentence progress + pending count instead.
    const pendingTail = _chapterQueue.length
      ? ` · ${_chapterQueue.length} more queued`
      : "";
    chapterQueueText.textContent =
      `Background · Synthesizing${curLabel}${progress}${pendingTail}`;
    return;
  }
  // Foreground mode: drop the active class so the pulse dot doesn't
  // bleed across modes (e.g. if a foreground queue starts after a
  // background queue completes within the same session).
  chapterQueueEl.classList.remove("background-active");
  const head = `Chapter ${idx} of ${total}`;
  chapterQueueText.textContent = nextTitle
    ? `${head} · Next: ${nextTitle}`
    : `${head} · last one`;
}

function _startChapterQueue(chapters) {
  if (!chapters || chapters.length < 2) return;
  _chapterTotalCount = chapters.length;
  _chapterCurrentIndex = 1;
  const first = chapters[0];
  _chapterQueue = chapters.slice(1);
  _pendingChapterTitle = first.title;
  // Carry the first chapter's gitRef into _pendingGitRef so generate()'s
  // save callback pins it onto the clip. Subsequent chapters set their
  // own gitRef from _advanceChapterQueue.
  _pendingGitRef = first.gitRef || null;
  textEl.value = first.text;
  updateCounts();
  _hideChapterBanner();
  _updateChapterQueueUI();
  setStatus(
    `Chapter 1 of ${_chapterTotalCount} loaded. Click Generate — the rest will auto-continue.`
  );
}

// v161: post-queue failures banner. _silentQueueFailures persists the
// chapter objects across the queue's exit so the Retry button can
// re-run them; the banner element shows the chapter names and the
// Retry / Dismiss actions.
let _silentQueueFailures = [];
const silentQueueFailuresEl = $("silent-queue-failures");
const silentQueueFailuresCount = $("silent-queue-failures-count");
const silentQueueFailuresList = $("silent-queue-failures-list");
const silentQueueFailuresRetry = $("silent-queue-failures-retry");
const silentQueueFailuresLog = $("silent-queue-failures-log");
const silentQueueFailuresDismiss = $("silent-queue-failures-dismiss");

function _showSilentQueueFailuresBanner(failed) {
  if (!silentQueueFailuresEl) return;
  _silentQueueFailures = failed.slice();
  const n = failed.length;
  silentQueueFailuresCount.textContent =
    n === 1 ? "1 chapter" : `${n} chapters`;
  silentQueueFailuresList.innerHTML = "";
  for (const ch of failed) {
    const code = document.createElement("code");
    code.textContent = ch.title || "(untitled)";
    silentQueueFailuresList.appendChild(code);
  }
  silentQueueFailuresEl.hidden = false;
}
function _hideSilentQueueFailuresBanner() {
  if (!silentQueueFailuresEl) return;
  silentQueueFailuresEl.hidden = true;
  _silentQueueFailures = [];
}
if (silentQueueFailuresRetry) {
  silentQueueFailuresRetry.addEventListener("click", () => {
    if (!_silentQueueFailures.length) return;
    const retry = _silentQueueFailures.slice();
    _hideSilentQueueFailuresBanner();
    _startBackgroundChapterQueue(retry);
  });
}
if (silentQueueFailuresDismiss) {
  silentQueueFailuresDismiss.addEventListener(
    "click",
    _hideSilentQueueFailuresBanner,
  );
}
if (silentQueueFailuresLog) {
  // v177: one-click jump from "2 chapters failed" → debug log with
  // the per-chapter error context already captured.
  silentQueueFailuresLog.addEventListener("click", () => {
    if (typeof openDebugLog === "function") openDebugLog();
  });
}

// v162: persistent background queue + reorder + add-while-running.
//
// _chapterQueue (existing array) holds PENDING jobs only. _bgCurrent
// holds the job currently being synthesized (peeled off before
// processing so the queue is exclusively "what's next"). The worker
// is a simple while-loop fed from the front of the queue; when
// _chapterQueue gains items via _enqueueBg, the worker resumes (or
// restarts if it had drained) automatically.
//
// Each enqueued job snapshots its voice / rate / volume / speaker so
// the user can change the voice between queueings without
// retroactively affecting jobs already in the queue.
//
// Use case: "I'm reading article A; I find article B I'd rather get
// to first; I queue B at the top, drag B above A in the queue, and
// keep working." Or "queue 8 chapters then drag chapters 6-7 to
// the top because those are the ones I want to listen to tonight."

let _bgCurrent = null;       // job in flight, or null
let _bgRunning = false;      // worker loop active
let _bgOkCount = 0;          // saved successfully this run
let _bgFailures = [];        // accumulate persistent failures for the banner
// v169: elapsed-time clock for the current job. _bgCurrentStartedAt
// is set each time _bgRunWorker shifts a new job onto _bgCurrent;
// _bgCurrentTimerId polls every second so the queue panel can show
// a live "elapsed 0:45 · ~0:12 left" line on the in-flight row.
let _bgCurrentStartedAt = 0;
let _bgCurrentTimerId = null;
function _fmtMmSs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function _startBgCurrentTimer() {
  _stopBgCurrentTimer();
  _bgCurrentTimerId = setInterval(() => {
    // Cheap re-render: only the current row's meta needs to refresh
    // each second. Full panel rerender is fine — pending rows hash
    // by jobId, so the dragging session (if any) is untouched.
    _renderBgQueuePanel();
  }, 1000);
}
function _stopBgCurrentTimer() {
  if (_bgCurrentTimerId !== null) {
    clearInterval(_bgCurrentTimerId);
    _bgCurrentTimerId = null;
  }
}

function _bgJobFromUi(text, title) {
  const trimmed = (text || "").trim();
  return {
    id: `bgjob_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    title: (title || makeTitle(trimmed) || "(untitled)").trim(),
    text: trimmed,
    voiceId: voiceEl.value,
    voiceName: voiceEl.selectedOptions[0]?.textContent || voiceEl.value || "",
    rate: Number(rateEl.value),
    volume: Number(volumeEl.value) / 100,
    speakerId: speakerRow.hidden ? null : Number(speakerEl.value || 0),
  };
}

// Public-ish API: add one or many jobs to the background queue.
// Starts the worker if it isn't running yet. Captures the CURRENT
// voice settings into each job at enqueue time.
function _enqueueBg(jobsOrChapters) {
  const arr = Array.isArray(jobsOrChapters) ? jobsOrChapters : [jobsOrChapters];
  if (!arr.length) return;
  if (!voiceEl.value) {
    setStatus("Pick a voice before queueing silently.", true);
    return;
  }
  for (const j of arr) {
    // Accept either a fully-built job OR a {title, text, ...chapter}
    // shape. Snapshot voice settings if missing.
    _chapterQueue.push({
      id: j.id || `bgjob_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      title: (j.title || makeTitle(j.text || "") || "(untitled)").trim(),
      text: (j.text || "").trim(),
      voiceId: j.voiceId || voiceEl.value,
      voiceName: j.voiceName || (voiceEl.selectedOptions[0]?.textContent || voiceEl.value || ""),
      rate: typeof j.rate === "number" ? j.rate : Number(rateEl.value),
      volume: typeof j.volume === "number" ? j.volume : Number(volumeEl.value) / 100,
      speakerId:
        j.speakerId !== undefined
          ? j.speakerId
          : speakerRow.hidden
          ? null
          : Number(speakerEl.value || 0),
      // v176: source provenance so the picker can flag "this file is
      // already in the queue" with a ✓ badge. gitRef carries repoUrl
      // + path; targetClipId, when set, tells _bgTrySynth/saveClip to
      // overwrite an existing clip instead of creating a new one (used
      // by the v176 "Re-narrate outdated" path).
      gitRef: j.gitRef || null,
      targetClipId: j.targetClipId || null,
    });
  }
  _hideSilentQueueFailuresBanner();
  _renderBgQueuePanel();
  _updateChapterQueueUI();
  if (!_bgRunning) _bgRunWorker();
}

// Try one job through the existing pre-synthesis pipeline.
// _preSynthesizeChapter takes a {title, text} object — pass through.
// It captures voice/rate/volume from the UI at synthesis time, so we
// briefly swap UI values to the job's snapshot before calling, then
// restore (the user might be changing settings mid-queue for the
// next item they're about to queue).
async function _bgTrySynth(job) {
  _preSynthChapter = null;
  // Snapshot the UI so we can restore after.
  const prev = {
    voice: voiceEl.value,
    rate: rateEl.value,
    volume: volumeEl.value,
    speaker: speakerEl.value,
  };
  // Best-effort: only swap if the values are actually different (avoids
  // dispatching a stream of change events when most queued items share
  // the user's current voice).
  let swapped = false;
  if (job.voiceId && job.voiceId !== voiceEl.value) {
    voiceEl.value = job.voiceId;
    swapped = true;
  }
  if (typeof job.rate === "number" && String(job.rate) !== rateEl.value) {
    rateEl.value = String(job.rate);
    swapped = true;
  }
  const volPct = String(Math.round((job.volume || 1) * 100));
  if (volPct !== volumeEl.value) {
    volumeEl.value = volPct;
    swapped = true;
  }
  if (job.speakerId !== null && job.speakerId !== undefined) {
    speakerEl.value = String(job.speakerId);
  }
  try {
    // v177: log the job's preflight state — voice, lengths, gitRef —
    // so a "chapter 2 keeps failing" report contains everything
    // needed to reproduce. Title + chars almost always pin the cause.
    _dlog("bg-queue", `synth start: ${job.title}`, {
      chars: (job.text || "").length,
      voiceId: job.voiceId,
      rate: job.rate,
      volume: job.volume,
      speakerId: job.speakerId,
      targetClipId: job.targetClipId || null,
      gitRefPath: job.gitRef ? job.gitRef.path : null,
    });
    // v176: thread targetClipId + gitRef so the synth path can
    // overwrite an existing clip (Re-narrate outdated) instead of
    // creating a new one. Re-imports preserve title/notes/bookmarks
    // through saveClip below.
    // v220t: fromBgQueue tells _preSynthesizeChapter to skip the
    // end-of-chapter sleep check (that check only makes sense for
    // the foreground lookahead caller; for bg-queue it would kill
    // every job in the batch silently).
    await _preSynthesizeChapter(
      {
        title: job.title,
        text: job.text,
        targetClipId: job.targetClipId || null,
        gitRef: job.gitRef || null,
      },
      { fromBgQueue: true }
    );
  } catch (err) {
    _dlog("bg-queue", `synth threw: ${job.title}`, {
      errName: err && err.name,
      errMsg: err && err.message,
      stack: err && err.stack,
    });
    console.warn("[bg queue] synth threw:", job.title, err);
    if (swapped) {
      voiceEl.value = prev.voice;
      rateEl.value = prev.rate;
      volumeEl.value = prev.volume;
      speakerEl.value = prev.speaker;
    }
    return false;
  }
  if (swapped) {
    voiceEl.value = prev.voice;
    rateEl.value = prev.rate;
    volumeEl.value = prev.volume;
    speakerEl.value = prev.speaker;
  }
  const ok = !!(
    _preSynthChapter && _preSynthChapter.title === job.title
  );
  _preSynthChapter = null;
  return ok;
}

// The worker. Pulls jobs off the front of _chapterQueue one at a
// time, runs them through _bgTrySynth with one auto-retry on
// failure, and continues until the queue drains or is cancelled.
// New items added via _enqueueBg while the worker is running just
// land at the queue's back and get processed when their turn comes.
async function _bgRunWorker() {
  if (_bgRunning) return;
  if (_chapterQueue.length === 0) return;
  _bgRunning = true;
  _silentChapterQueue = true;
  _chapterTotalCount = _chapterQueue.length;
  _chapterCurrentIndex = 0;
  _bgOkCount = 0;
  _bgFailures = [];
  _hideSilentQueueFailuresBanner();
  generateBtn.disabled = true;
  generateBtn.title = "Background queue is running — cancel it to generate manually.";
  _renderBgQueuePanel();
  setStatus(
    `Background queue started — ${_chapterQueue.length} item${_chapterQueue.length === 1 ? "" : "s"} pending.`
  );
  while (_chapterQueue.length > 0 && _silentChapterQueue) {
    _bgCurrent = _chapterQueue.shift();
    _chapterCurrentIndex += 1;
    _bgSynthCurrentTitle = _bgCurrent.title || "";
    _bgSynthSentence = 0;
    _bgSynthTotal = 0;
    // v169: record start time + run a 1s tick so the queue panel
    // shows live "elapsed 0:45" + ETA from sentence progress.
    _bgCurrentStartedAt = Date.now();
    _startBgCurrentTimer();
    _updateChapterQueueUI();
    _renderBgQueuePanel();
    let success = await _bgTrySynth(_bgCurrent);
    if (!success && _silentChapterQueue) {
      _dlog("bg-queue", `RETRY ${_bgCurrent.title} after 1.5s`, {
        chars: (_bgCurrent.text || "").length,
      });
      console.warn(
        `[bg queue] retrying "${_bgCurrent.title}" after 1.5s…`
      );
      await new Promise((r) => setTimeout(r, 1500));
      if (_silentChapterQueue) success = await _bgTrySynth(_bgCurrent);
    }
    if (success) {
      _dlog("bg-queue", `OK ${_bgCurrent.title}`, {
        chars: (_bgCurrent.text || "").length,
      });
      _bgOkCount += 1;
    } else if (_silentChapterQueue) {
      _dlog("bg-queue", `FAIL ${_bgCurrent.title} (both attempts)`, {
        chars: (_bgCurrent.text || "").length,
        gitRefPath: _bgCurrent.gitRef ? _bgCurrent.gitRef.path : null,
      });
      _bgFailures.push(_bgCurrent);
    }
    _bgCurrent = null;
    // v169: tear down the 1s tick when the job ends. If the worker
    // shifts another job on the next iteration, _startBgCurrentTimer
    // will restart it; otherwise the loop exits and the panel is hidden.
    _stopBgCurrentTimer();
    _renderBgQueuePanel();
  }
  const cancelled = !_silentChapterQueue;
  _silentChapterQueue = false;
  _bgRunning = false;
  _chapterTotalCount = 0;
  _chapterCurrentIndex = 0;
  _preSynthChapter = null;
  _bgSynthCurrentTitle = "";
  _bgSynthSentence = 0;
  _bgSynthTotal = 0;
  generateBtn.disabled = false;
  generateBtn.title = "";
  _updateChapterQueueUI();
  _renderBgQueuePanel();
  if (cancelled) {
    setStatus(`Background queue cancelled — ${_bgOkCount} saved.`);
  } else if (_bgFailures.length > 0) {
    _showSilentQueueFailuresBanner(_bgFailures);
    setStatus(
      `Background queue done — ${_bgOkCount} saved, ${_bgFailures.length} need a retry.`,
      false
    );
  } else if (_bgOkCount > 0) {
    setStatus(`Background queue done — ${_bgOkCount} chapter${_bgOkCount === 1 ? "" : "s"} in your library.`);
  }
}

// v139 compat: keeps the existing import-picker callers
// (_startBackgroundChapterQueue) working — they just enqueue and
// trust the worker to run.
async function _startBackgroundChapterQueue(chapters) {
  if (!chapters || chapters.length === 0) return;
  _enqueueBg(chapters);
}

// v162: render the queue panel — current job (if any) + the pending
// list. Idempotent; safe to call from anywhere the queue state
// changes (enqueue, dequeue, reorder, remove, cancel).
const bgQueuePanel = $("bg-queue-panel");
const bgQueueCurrent = $("bg-queue-current");
const bgQueuePending = $("bg-queue-pending");
const bgQueueFooter = $("bg-queue-footer");
function _renderBgQueuePanel() {
  if (!bgQueuePanel) return;
  const hasCurrent = !!_bgCurrent;
  const pendingCount = _chapterQueue.length;
  bgQueuePanel.hidden = !hasCurrent && pendingCount === 0;
  if (hasCurrent) {
    bgQueueCurrent.hidden = false;
    bgQueueCurrent.innerHTML = "";
    const title = document.createElement("span");
    title.className = "bg-queue-title";
    title.textContent = _bgCurrent.title || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "bg-queue-meta";
    // v169: live elapsed + ETA. ETA is derived from sentence-rate
    // (elapsed / sentences_done * sentences_remaining), so it only
    // shows up once at least a few sentences have completed — early
    // estimates from "0 sentences done" would be infinite or wildly
    // off and read as confusing noise.
    const parts = [];
    if (_bgSynthTotal > 0) {
      parts.push(`${_bgSynthSentence}/${_bgSynthTotal} sentences`);
    } else {
      parts.push("synthesizing…");
    }
    const elapsedMs = _bgCurrentStartedAt > 0 ? Date.now() - _bgCurrentStartedAt : 0;
    parts.push(`elapsed ${_fmtMmSs(elapsedMs)}`);
    if (
      _bgSynthSentence >= 5 &&
      _bgSynthTotal > _bgSynthSentence &&
      elapsedMs > 1000
    ) {
      const perSent = elapsedMs / _bgSynthSentence;
      const remaining = (_bgSynthTotal - _bgSynthSentence) * perSent;
      parts.push(`~${_fmtMmSs(remaining)} left`);
    }
    meta.textContent = parts.join(" · ");
    bgQueueCurrent.append(title, meta);
  } else {
    bgQueueCurrent.hidden = true;
    bgQueueCurrent.innerHTML = "";
  }
  bgQueuePending.innerHTML = "";
  for (let i = 0; i < _chapterQueue.length; i++) {
    const job = _chapterQueue[i];
    const row = document.createElement("div");
    row.className = "bg-queue-item";
    row.dataset.jobId = job.id;
    const drag = document.createElement("span");
    drag.className = "bg-queue-drag";
    drag.setAttribute("aria-label", "Drag to reorder");
    drag.title = "Drag to reorder";
    drag.textContent = "⋮⋮";
    _attachBgDragHandle(drag, row);
    const title = document.createElement("span");
    title.className = "bg-queue-title";
    title.textContent = job.title || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "bg-queue-meta";
    const words = Math.max(1, Math.round((job.text || "").length / 5));
    const mins = Math.max(1, Math.round(words / 180));
    meta.textContent = `~${mins} min`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "bg-queue-remove";
    remove.setAttribute("aria-label", "Remove from queue");
    remove.title = "Remove from queue";
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = _chapterQueue.findIndex((j) => j.id === job.id);
      if (idx >= 0) {
        _chapterQueue.splice(idx, 1);
        _renderBgQueuePanel();
        _updateChapterQueueUI();
      }
    });
    row.append(drag, title, meta, remove);
    bgQueuePending.appendChild(row);
  }
  // v163 / v176: recent-repos shortcut row at the bottom of the
  // queue panel. v163 showed a single "+ Add more from owner/repo"
  // link for the most recent. v176 surfaces up to RECENT_REPOS_MAX
  // (5) past repos as chips so a user juggling multiple book projects
  // can flip between them without re-pasting URLs.
  if (bgQueueFooter) {
    const recents = _getRecentGithubRepos();
    if (recents.length > 0) {
      bgQueueFooter.hidden = false;
      bgQueueFooter.innerHTML = "";
      // Section label so the chip row reads as deliberate UI, not
      // mystery buttons hanging off the queue.
      const label = document.createElement("span");
      label.className = "bg-queue-recents-label";
      label.textContent =
        recents.length === 1 ? "Recent repo:" : "Recent repos:";
      bgQueueFooter.appendChild(label);
      const chipRow = document.createElement("div");
      chipRow.className = "bg-queue-recents-chips";
      for (const r of recents) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "bg-queue-recent-chip";
        chip.title = `Re-open the GitHub picker for ${r.owner}/${r.repo}`;
        chip.textContent = `${r.owner}/${r.repo}`;
        chip.addEventListener("click", () => {
          // Defer to openGithubBrowser so the chip flows through the
          // same picker / background-mode path as a fresh Import →
          // GitHub. _pushRecentGithubRepo on the fetch will bubble
          // this entry back to the front of the list.
          openGithubBrowser(r.url);
        });
        chipRow.appendChild(chip);
      }
      bgQueueFooter.appendChild(chipRow);
    } else {
      bgQueueFooter.hidden = true;
      bgQueueFooter.innerHTML = "";
    }
  }
}

// Drag-to-reorder for pending queue rows. Mirrors the library card
// drag pattern (Pointer Events + visual translateY + midpoint-based
// insertion math), just scoped to .bg-queue-pending.
let _bgDragSession = null;
function _attachBgDragHandle(handle, rowEl) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== undefined && e.pointerType === "mouse") {
      return;
    }
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    _bgDragSession = {
      rowEl,
      pointerId: e.pointerId,
      startY: e.clientY,
      jobId: rowEl.dataset.jobId,
    };
    rowEl.classList.add("dragging");
    handle.addEventListener("pointermove", _onBgDragMove);
    handle.addEventListener("pointerup", _onBgDragEnd);
    handle.addEventListener("pointercancel", _onBgDragEnd);
  });
}
function _onBgDragMove(e) {
  if (!_bgDragSession || e.pointerId !== _bgDragSession.pointerId) return;
  e.preventDefault();
  const dy = e.clientY - _bgDragSession.startY;
  _bgDragSession.rowEl.style.transform = `translateY(${dy}px)`;
}
function _onBgDragEnd(e) {
  if (!_bgDragSession || e.pointerId !== _bgDragSession.pointerId) return;
  const { rowEl, jobId } = _bgDragSession;
  const handle = e.currentTarget;
  try { handle.releasePointerCapture(e.pointerId); } catch {}
  handle.removeEventListener("pointermove", _onBgDragMove);
  handle.removeEventListener("pointerup", _onBgDragEnd);
  handle.removeEventListener("pointercancel", _onBgDragEnd);
  const draggedRect = rowEl.getBoundingClientRect();
  const draggedMid = draggedRect.top + draggedRect.height / 2;
  rowEl.style.transform = "";
  rowEl.classList.remove("dragging");
  _bgDragSession = null;
  const siblings = Array.from(bgQueuePending.children).filter(
    (c) => c !== rowEl
  );
  let insertIdx = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const r = siblings[i].getBoundingClientRect();
    if (draggedMid < r.top + r.height / 2) {
      insertIdx = i;
      break;
    }
  }
  const fromIdx = _chapterQueue.findIndex((j) => j.id === jobId);
  if (fromIdx === -1) return;
  const [job] = _chapterQueue.splice(fromIdx, 1);
  _chapterQueue.splice(insertIdx, 0, job);
  _renderBgQueuePanel();
  _updateChapterQueueUI();
}

// "Queue silently" button — captures the current textarea as a job
// and clears the textarea so the next paste starts fresh.
const queueSilentlyBtn = $("queue-silently");
if (queueSilentlyBtn) {
  queueSilentlyBtn.addEventListener("click", () => {
    const text = (textEl.value || "").trim();
    if (!text) {
      setStatus("Type or paste some text first to queue it.", true);
      textEl.focus();
      return;
    }
    if (!voiceEl.value) {
      setStatus("Pick a voice before queueing silently.", true);
      return;
    }
    const title = _pendingChapterTitle || makeTitle(text);
    _enqueueBg([{ title, text }]);
    textEl.value = "";
    updateCounts();
    _pendingChapterTitle = null;
    _hideChapterBanner();
    setStatus(
      `Queued "${title}" silently — ${_chapterQueue.length} in the queue.`
    );
    if (typeof _updateEmptyState === "function") _updateEmptyState();
  });
}

// Called from generate()'s save path. If there are more chapters waiting,
// load the next, set its pending title, and re-fire generate(). Returns
// true when it advanced (caller can suppress "ready to Play" UI), false
// when the queue is drained / not active.
function _advanceChapterQueue() {
  if (_chapterTotalCount <= 0) return false;
  if (_chapterQueue.length === 0) {
    // Last chapter just finished. Wipe state.
    const done = _chapterTotalCount;
    _chapterTotalCount = 0;
    _chapterCurrentIndex = 0;
    _pendingChapterTitle = null;
    _abortPreSynth();
    _updateChapterQueueUI();
    setStatus(`All ${done} chapters synthesized.`);
    return false;
  }
  const next = _chapterQueue.shift();
  _chapterCurrentIndex += 1;
  _pendingChapterTitle = next.title;
  _pendingGitRef = next.gitRef || null;
  _updateChapterQueueUI();

  // Fast path: chapter was pre-synthesized in the background while the
  // user listened to the previous one. Load it instantly from the
  // library and immediately kick off pre-synth for the chapter AFTER
  // this one so the chain continues. Save was done during pre-synth, so
  // mark the queue's save flag complete now (no generate() callback
  // will fire for this chapter).
  if (_preSynthChapter && _preSynthChapter.title === next.title) {
    const clipId = _preSynthChapter.clipId;
    _preSynthChapter = null;
    _pendingChapterTitle = null;
    _queueSaveComplete = true;
    setTimeout(() => loadClip(clipId), 50);
    if (_chapterQueue.length > 0) {
      _preSynthesizeChapter(_chapterQueue[0]);
    }
    return true;
  }

  // Slow path: pre-synth wasn't ready (first chapter, or a regen
  // interrupted the chain). Fall back to inline synthesis.
  textEl.value = next.text;
  updateCounts();
  // Defer so library re-render / save side effects from the previous
  // chapter complete before the next synthesis starts.
  setTimeout(() => generate(), 150);
  return true;
}

// Headless background synthesis of a queued chapter. Collects the SSE
// stream events into a buffer (no reading-view / player updates) and
// saves the result to IndexedDB as a regular clip. Sets _preSynthChapter
// when the result is ready; _advanceChapterQueue picks it up from there.
async function _preSynthesizeChapter(chapter, opts) {
  // v220t: bg-queue (silent batch import) shares this function with the
  // foreground lookahead caller. The end-of-chapter sleep check was a
  // foreground-lookahead optimization ("don't pre-synth N+1 if we're
  // stopping at N") — applying it to a user-triggered bg-queue batch is
  // a bug: every job in the queue fails silently if the user had
  // end-of-chapter sleep armed at any point. Caller passes
  // `fromBgQueue: true` to bypass.
  const fromBgQueue = !!(opts && opts.fromBgQueue);
  if (_sleepEndOfChapter && !fromBgQueue) {
    _dlog("synth", "pre-synth skipped: end-of-chapter sleep armed", {
      title: chapter && chapter.title,
    });
    return;
  }
  // Abort any in-flight pre-synth — we only ever look ahead one chapter.
  _abortPreSynth();
  _preSynthController = new AbortController();
  const myController = _preSynthController;
  const voiceId = voiceEl.value;
  if (!voiceId || !chapter || !chapter.text) {
    // v220t: log this — bg-queue otherwise sees a silent "no result"
    // and can't tell whether the voice picker got cleared or whether
    // the queue item itself was empty.
    _dlog("synth", "pre-synth bailed: missing voice/text", {
      title: chapter && chapter.title,
      hasVoice: !!voiceId,
      hasChapter: !!chapter,
      chars: (chapter && chapter.text || "").length,
    });
    _preSynthController = null;
    return;
  }
  const rate = Number(rateEl.value);
  const volume = Number(volumeEl.value) / 100;
  const speakerId = speakerRow.hidden ? null : Number(speakerEl.value || 0);
  const voiceName = voiceEl.selectedOptions[0]?.textContent || voiceEl.value || "";
  try {
    const res = await fetch("/api/synthesize/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: chapter.text,
        voice_id: voiceId,
        rate,
        volume,
        speaker_id: speakerId,
      }),
      signal: myController.signal,
    });
    if (!res.ok) {
      // v177: capture the response body — synthesis errors often
      // include the actual reason (voice not found, OOM, etc.) in
      // the JSON detail. Clone so the read here doesn't block the
      // synth path's own reader.
      let body = "";
      try { body = await res.clone().text(); } catch {}
      _dlog("synth", `HTTP ${res.status} for chapter`, {
        status: res.status,
        title: chapter.title,
        chars: (chapter.text || "").length,
        body: body.slice(0, 500),
      });
      throw new Error(`HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let combinedMp3 = null;
    let sentenceOffsetsMs = [];

    // v204: SSE watchdog. The server emits ': keepalive\n\n' comment
    // lines every 15s during synth so intermediaries (Fly's proxy,
    // nginx) see live traffic. If we go 30s (2x slack) without ANY
    // bytes on the stream, the upstream is almost certainly dead —
    // abort the fetch so we get a clear error to surface, rather
    // than silently waiting on a never-arriving response. The fetch
    // abort propagates as a reader.read() rejection caught by
    // _bgTrySynth's outer try/catch, which already triggers the
    // 1.5s-then-retry path. A failed retry lands in _bgFailures and
    // shows the "needs a retry" banner.
    let _watchdogFired = false;
    let _watchdogTimer = null;
    const SSE_WATCHDOG_MS = 30000;
    // v216: pause the watchdog while the tab is hidden. Mobile
    // browsers throttle background tabs — JS execution slows or
    // halts, so incoming SSE bytes don't get processed, the
    // watchdog's timer keeps running on the real clock, and at
    // 30s it aborts a fetch that the server is happily still
    // streaming to. The user comes back to a synth that "died" —
    // because we killed it. Tab-visibility-aware reset fixes that:
    //   - tab hidden  → don't schedule abort
    //   - tab visible → schedule abort as normal
    // Triggered by:
    //   1. opening the manual / What's new in a new tab (which sets
    //      the original tab to hidden on phone)
    //   2. switching to another app
    //   3. locking the phone
    const _isVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const _resetWatchdog = () => {
      if (_watchdogTimer) clearTimeout(_watchdogTimer);
      if (!_isVisible()) return;  // suspend
      _watchdogTimer = setTimeout(() => {
        _watchdogFired = true;
        try { myController.abort(); } catch {}
      }, SSE_WATCHDOG_MS);
    };
    const _onVisibility = () => {
      if (!_isVisible()) {
        // Going hidden — drop the in-flight timer so it doesn't
        // fire while the tab is throttled.
        if (_watchdogTimer) {
          clearTimeout(_watchdogTimer);
          _watchdogTimer = null;
        }
      } else {
        // Coming back — restart with a fresh 30s window. Any
        // server-side keepalive that piled up while we were
        // hidden will tick the wire soon and reset us again.
        _resetWatchdog();
      }
    };
    document.addEventListener("visibilitychange", _onVisibility);
    _resetWatchdog();

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (err) {
        if (_watchdogTimer) clearTimeout(_watchdogTimer);
        // v216: drop the visibility handler now that we're done
        // with this chapter's watchdog. Otherwise each chapter
        // queue run leaks a listener.
        document.removeEventListener("visibilitychange", _onVisibility);
        if (_watchdogFired) {
          _dlog("synth", "SSE watchdog timeout — no bytes for 30s", {
            title: chapter.title,
            atSentence: _bgSynthSentence,
            ofTotal: _bgSynthTotal,
          });
          throw new Error(
            "connection lost — server may be restarting or unreachable"
          );
        }
        throw err;
      }
      // Reset on ANY incoming bytes — including the keepalive comment
      // lines, which won't parse as `data:` events but still tick the
      // wire.
      _resetWatchdog();
      const { done, value } = readResult;
      if (done) {
        if (_watchdogTimer) clearTimeout(_watchdogTimer);
        document.removeEventListener("visibilitychange", _onVisibility);
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          // v141: surface per-sentence progress into the silent-queue
          // pill so the user has something to watch during a long
          // chapter. Skip when the silent queue isn't active so the
          // lookahead pre-synth path (during a foreground queue)
          // doesn't fight the foreground status text.
          if (event.type === "sentence" && _silentChapterQueue) {
            _bgSynthSentence = (event.index || 0) + 1;
            _bgSynthTotal = event.total || 0;
            _updateChapterQueueUI();
          }
          if (event.type === "result") {
            combinedMp3 = new Blob([base64ToBytes(event.mp3_b64)], {
              type: "audio/mpeg",
            });
            sentenceOffsetsMs = event.sentence_offsets_ms || [];
          } else if (event.type === "error") {
            // v177: log the SSE error message + position so a "chapter
            // 2 fails" report contains the sentence number where it
            // broke (useful for "the third sentence has a weird char").
            _dlog("synth", `SSE error: ${event.message || "(no msg)"}`, {
              title: chapter.title,
              atSentence: _bgSynthSentence,
              ofTotal: _bgSynthTotal,
            });
            // v204: stop the watchdog so it doesn't fire abort after
            // we've already thrown.
            if (_watchdogTimer) clearTimeout(_watchdogTimer);
            // v216: clean up the visibility listener too.
            document.removeEventListener("visibilitychange", _onVisibility);
            throw new Error(event.message || "synthesis error");
          }
        }
      }
    }
    if (!combinedMp3) {
      // v177: the SSE stream ended without a result event. Almost
      // always means upstream sent only `sentence` events that
      // produced no audio (all-whitespace text, voice misroute,
      // server crashed mid-stream). Log everything we know.
      _dlog("synth", "no audio in result", {
        title: chapter.title,
        chars: (chapter.text || "").length,
        sentencesSeen: _bgSynthSentence,
        totalAdvertised: _bgSynthTotal,
      });
      throw new Error("no audio in result");
    }

    // Get duration via a throwaway <audio> element so the saved clip
    // has accurate metadata for the library card.
    const tmpUrl = URL.createObjectURL(combinedMp3);
    const tmpAudio = new Audio();
    const duration = await new Promise((resolve) => {
      tmpAudio.addEventListener(
        "loadedmetadata",
        () => resolve(isFinite(tmpAudio.duration) ? tmpAudio.duration : 0),
        { once: true }
      );
      tmpAudio.addEventListener("error", () => resolve(0), { once: true });
      tmpAudio.src = tmpUrl;
    });
    URL.revokeObjectURL(tmpUrl);

    // Cancelled mid-flight (user cancelled queue, started a regen, etc.)?
    // Don't write a stale clip to the library.
    if (myController.signal.aborted || _preSynthController !== myController) {
      // v220t: log so a "FAIL ... (both attempts)" report can pin
      // whether the controller was replaced (another _preSynthesize
      // call landed) vs explicitly aborted (queue cancel, regen).
      _dlog("synth", "pre-synth aborted mid-flight (post-stream)", {
        title: chapter && chapter.title,
        signalAborted: myController.signal.aborted,
        controllerSwapped: _preSynthController !== myController,
      });
      return;
    }

    // v176: if the queue item carries a targetClipId (Re-narrate
    // outdated), overwrite that clip instead of creating a new one.
    // Carry the existing clip's title/note/bookmarks/cover so a
    // re-narrate is transparent — only text + audio + gitRef change.
    let existingClip = null;
    if (chapter.targetClipId) {
      try { existingClip = await getClip(chapter.targetClipId); } catch {}
    }
    const newClipId = existingClip
      ? existingClip.id
      : Date.now() + Math.floor(Math.random() * 1000);
    await saveClip({
      id: newClipId,
      title: existingClip ? existingClip.title : chapter.title,
      note: existingClip ? existingClip.note || "" : "",
      // v176: re-narrate updates the source text and audio in place;
      // everything else (notes, tags, cover, bookmarks) is the user's
      // metadata and must survive the refresh untouched.
      notes: existingClip ? existingClip.notes || "" : "",
      tags: existingClip ? existingClip.tags || [] : [],
      cover: existingClip ? existingClip.cover || undefined : undefined,
      text: chapter.text,
      voiceId,
      voiceName,
      rate,
      volume,
      speakerId,
      sentenceOffsetsSec: sentenceOffsetsMs.map((ms) => ms / 1000),
      blob: combinedMp3,
      durationSec: duration,
      // Reset playhead on a re-narrate — the new audio's timeline is
      // different from the old one, so the old position is meaningless.
      progressSec: 0,
      // Carry bookmarks: text didn't fundamentally change, just got
      // re-fetched. User's marks are too valuable to wipe.
      bookmarks: existingClip && Array.isArray(existingClip.bookmarks)
        ? existingClip.bookmarks
        : [],
      images: existingClip && Array.isArray(existingClip.images)
        ? existingClip.images
        : [],
      // gitRef: prefer the fresh one from the re-narrate fetch so
      // the new SHA is recorded; fall back to the existing clip's
      // ref if for some reason we don't have a new one.
      gitRef: chapter.gitRef || (existingClip ? existingClip.gitRef : null),
      createdAt: existingClip
        ? existingClip.createdAt
        : new Date().toISOString(),
    });
    if (existingClip) {
      // Drop the outdated flag now that the clip is current.
      _outdatedClipIds.delete(existingClip.id);
    }
    renderLibrary();
    _preSynthChapter = { clipId: newClipId, title: chapter.title };
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn("[pre-synth] failed:", err);
      // v220t: log the real exception too. Previously only HTTP / SSE
      // errors got their own dlog and other errors (network, parse,
      // saveClip throw) were console-only — invisible in the debug log.
      _dlog("synth", `pre-synth threw: ${err.name || "Error"}`, {
        title: chapter && chapter.title,
        errMsg: err && err.message,
      });
    } else {
      // v220t: log aborts too so a "FAIL ... (both attempts)" report
      // tells us whether the bg-queue job was killed externally
      // (regen, manual cancel, page hidden retry).
      _dlog("synth", "pre-synth aborted", {
        title: chapter && chapter.title,
      });
    }
    _preSynthChapter = null;
  } finally {
    if (_preSynthController === myController) _preSynthController = null;
  }
}

function _abortPreSynth() {
  if (_preSynthController) {
    _preSynthController.abort();
    _preSynthController = null;
  }
  _preSynthChapter = null;
}

function _cancelChapterQueue() {
  if (_chapterTotalCount <= 0) return;
  // Wipe ALL queue state, not just the pending list. Previously we
  // only cleared _chapterQueue; the next save callback then ran
  // _advanceChapterQueue, hit the empty-queue branch, and flashed a
  // misleading "All N chapters synthesized" status (the user just
  // cancelled — they didn't synthesize all of them). Also clear the
  // pending-advance flag so a later 'ended' event doesn't try to
  // resume the cancelled queue.
  // v139: flip the silent flag so a running background loop bails out
  // of its next iteration. _abortPreSynth (below) terminates the
  // in-flight fetch so the current chapter aborts immediately rather
  // than running to completion. The "current chapter will still save"
  // language stays for foreground queues — in background mode, an
  // in-flight aborted chapter does NOT save (pre-synth bails before
  // saveClip on AbortError), which matches user expectation: they
  // hit cancel because they don't want it.
  const wasSilent = _silentChapterQueue;
  _silentChapterQueue = false;
  _chapterQueue = [];
  _chapterTotalCount = 0;
  _chapterCurrentIndex = 0;
  _pendingChapterTitle = null;
  _resetQueueAdvanceFlags();
  _abortPreSynth();
  // v141: restore Generate when cancelling a background queue. (For
  // foreground queues these are already at the right state.)
  if (wasSilent) {
    _bgSynthCurrentTitle = "";
    _bgSynthSentence = 0;
    _bgSynthTotal = 0;
    generateBtn.disabled = false;
    generateBtn.title = "";
    // v162: clear the persistent-worker state so the next enqueue
    // starts a fresh run instead of resuming with a stale current.
    _bgCurrent = null;
    _bgRunning = false;
    // v169: stop the elapsed-time tick so it doesn't keep firing
    // _renderBgQueuePanel after the panel is hidden.
    _stopBgCurrentTimer();
    if (typeof _renderBgQueuePanel === "function") _renderBgQueuePanel();
  }
  _updateChapterQueueUI();
  setStatus(
    wasSilent
      ? "Background queue cancelled."
      : "Chapter queue cancelled — current chapter will still save."
  );
}

// Single entry point for "text just arrived from outside; check it." All
// three import paths (paste / file upload / URL fetch) call this.
// 200 covers virtually every novel; books with more (War & Peace at 365,
// serialized works, devotionals) are rare enough that requiring a manual
// split is acceptable for them. Original cap of 30 was set thinking of
// markdown docs with subheadings; turned out to silently swallow real
// novels like Tom Sawyer (35 chapters) extracted from URLs.
const MAX_AUTO_DETECT = 200;

function _checkForChapters() {
  // Don't re-banner if a queue is already running — the user has already
  // decided to split a chunk and we shouldn't second-guess them.
  if (_chapterTotalCount > 0) return;
  const chapters = _detectChapters(textEl.value);
  if (
    chapters &&
    chapters.length >= 2 &&
    chapters.length <= MAX_AUTO_DETECT
  ) {
    _showChapterBanner(chapters);
  } else {
    _hideChapterBanner();
  }
}

// Paste fires BEFORE the textarea value updates, so defer to a tick.
textEl.addEventListener("paste", () => {
  setTimeout(_checkForChapters, 0);
});

chapterBannerSplit.addEventListener("click", () => {
  if (_detectedChapters) _startChapterQueue(_detectedChapters);
});

chapterBannerDismiss.addEventListener("click", _hideChapterBanner);

chapterQueueCancel.addEventListener("click", _cancelChapterQueue);

// ---- Reading view --------------------------------------------------------
// After Generate, the editable textarea is hidden and the input text is
// rendered as a stack of <span class="sentence"> elements. As audio plays,
// the span matching the current playback time is marked `.active`; spans
// before it get `.played` so the user can see how far they've gotten at a
// glance. Mirrors the backend's split_sentences regex so the per-sentence
// offsets emitted by /api/synthesize/stream line up with what we render.

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

function splitSentencesClient(text) {
  return (text || "")
    .trim()
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Author-mode threshold for the long-sentence highlighter. 35 words is
// the standard "is this becoming a run-on?" line — short enough to flag
// real candidates without painting half a chapter amber. CSS gating
// means this attribute is inert for readers who never turn Author mode
// on, so we always tag and let the stylesheet decide.
const LONG_SENTENCE_WORD_THRESHOLD = 35;

// v211 (M7.1): cached highlights for the reading-view sentence
// builder. Populated by loadClip and updated by _saveHighlight.
let _readingViewHighlights = [];

function enterReadingView(text, images, highlights) {
  if (Array.isArray(highlights)) {
    _readingViewHighlights = highlights;
  }
  // v185 (M1) fix: if the user is currently in book view and just
  // clicked a different clip in the library, they expect to stay in
  // book view — just with the new chapter's content. Capture the
  // state now; we'll honor it at the end by re-entering book view
  // against the freshly stashed _bookViewSource.
  const wasInBookView =
    typeof bookView !== "undefined" && bookView && !bookView.hidden;
  const sentences = splitSentencesClient(text);
  readingView.innerHTML = "";

  // Bucket images by the sentence they should appear *before*. Each entry
  // is {sentence_index, src, alt}; the extractor numbers them against the
  // *cleaned* text (same splitter the server runs), so indexes line up
  // with the spans we're about to create. Indexes past the last sentence
  // get appended at the end so a trailing picture isn't silently lost.
  const imgList = Array.isArray(images) ? images : [];
  const imgByIndex = new Map();
  for (const img of imgList) {
    if (!img || !img.src) continue;
    const raw = Number(img.sentence_index);
    const idx = Number.isFinite(raw)
      ? Math.max(0, Math.min(sentences.length, Math.floor(raw)))
      : sentences.length;
    if (!imgByIndex.has(idx)) imgByIndex.set(idx, []);
    imgByIndex.get(idx).push(img);
  }

  function flushImagesAt(idx) {
    const bucket = imgByIndex.get(idx);
    if (!bucket) return;
    for (const img of bucket) {
      const el = document.createElement("img");
      el.className = "inline-image";
      el.loading = "lazy";
      el.decoding = "async";
      el.src = img.src;
      el.alt = img.alt || "";
      // A broken image (404, blocked host, expired hotlink) shouldn't
      // leave an empty slot in the middle of the reading view — drop it.
      el.addEventListener("error", () => el.remove(), { once: true });
      readingView.appendChild(el);
    }
  }

  sentenceSpans = sentences.map((s, i) => {
    flushImagesAt(i);
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.index = String(i);
    // Long-sentence flag. Word count uses the same splitter as the
    // textarea meta line so an Author sees consistent numbers between
    // "247 words" in the meta and "this one's 41" in the reading view.
    const wc = _countWords(s);
    if (wc >= LONG_SENTENCE_WORD_THRESHOLD) {
      span.dataset.longSentence = "true";
      span.dataset.wordCount = String(wc);
      span.title = `${wc} words`;
    }
    // v211 (M7.1): use the shared content builder so reading view
    // sentences carry their highlights too. _readingViewHighlights
    // is populated by loadClip / generate when the clip's
    // highlights are read in.
    span.innerHTML = _buildSentenceContentHTML(s, i, _readingViewHighlights || []);
    span.addEventListener("click", () => {
      // v189: clicking a sentence reads as "engage here" — drop
      // any pinned scroll state so the auto-scroll resumes from
      // this point. Mirrors the book view's sentence-click behavior.
      _readingViewUserScrolled = false;
      // seekToSentence handles both streaming (jump into the per-sentence
      // queue) and post-swap (move the playhead in the combined WAV).
      seekToSentence(i);
      if (playerEl.paused) playerEl.play().catch(() => {});
    });
    readingView.appendChild(span);
    return span;
  });
  // Trailing images (anchored past the final sentence, or the catch-all
  // bucket for malformed indexes) — render them at the bottom.
  flushImagesAt(sentences.length);
  activeSentenceIdx = -1;
  // v189: new clip → fresh start. Clear any pinned scroll state
  // from a previous reading-view session so the auto-scroll
  // resumes correctly for the new content.
  _readingViewUserScrolled = false;
  if (readingViewReturnBtn) readingViewReturnBtn.hidden = true;
  textEl.hidden = true;
  readingView.hidden = false;
  editTextBtn.hidden = false;
  saveTextBtn.hidden = true;
  // v185 (M1): book view toggle is bound to "we have a loaded clip
  // with rendered sentences" — same lifecycle as the Edit button.
  if (bookViewToggle) bookViewToggle.hidden = false;
  // Stash the current text + images so the book view can paginate
  // without re-running the splitter. Title comes from the loaded
  // clip when available; falls back to "Untitled chapter".
  _bookViewSource = {
    sentences: sentences.slice(),
    images: imgList.slice(),
    title: "",
    cover: null,
  };
  textLabel.textContent = "Now reading";
  // Chip strip is editing-only; clear it while we're in playback so the
  // reading view sits cleanly below the .meta line.
  if (fillerCountsEl) {
    fillerCountsEl.hidden = true;
    fillerCountsEl.innerHTML = "";
  }
  // v185 (M1) fix: if the user was in book view before this clip
  // load, repaginate the book view against the new content and put
  // them back there. Without this, loading a different clip from the
  // library while in book view leaves both views rendered at the
  // same time (the reading view fires up; the book view never
  // notices the content changed).
  if (wasInBookView && typeof enterBookView === "function") {
    enterBookView();
  }
}

function exitReadingView() {
  textEl.hidden = false;
  readingView.hidden = true;
  editTextBtn.hidden = true;
  // v189: hide the return-current pill alongside the reading view.
  // (The pinned flag is reset on the next enter, so no need to
  // touch it here.)
  if (readingViewReturnBtn) readingViewReturnBtn.hidden = true;
  // v185 (M1): close book view alongside reading view — same loaded-
  // clip lifecycle. If the user pressed Edit text mid-book, the
  // book view also needs to fold away so they're back in the
  // textarea editing context.
  if (typeof exitBookView === "function" && bookView && !bookView.hidden) {
    exitBookView({ skipReadingView: true });
  }
  if (bookViewToggle) bookViewToggle.hidden = true;
  _bookViewSource = null;
  // Save text only makes sense when there's a loaded clip to save into —
  // freshly-typed text with no clip yet still needs Generate first.
  saveTextBtn.hidden = !_currentClipId;
  textLabel.textContent = "Your text";
  sentenceSpans.forEach((s) => s.classList.remove("active", "played"));
  activeSentenceIdx = -1;
  // The chip strip was hidden while reading; bring it back if the text
  // we're editing has filler words worth flagging.
  _renderFillerChips(textEl.value);
}

async function saveCurrentClipText() {
  if (!_currentClipId) {
    setStatus("Load a clip first — there's nothing to save into.", true);
    return;
  }
  saveTextBtn.disabled = true;
  const oldLabel = saveTextBtn.textContent;
  saveTextBtn.textContent = "Saving…";
  try {
    const clip = await getClip(_currentClipId);
    if (!clip) {
      setStatus("Clip not found — it may have been deleted in another tab.", true);
      return;
    }
    const oldText = clip.text || "";
    const newText = textEl.value;

    // Compare sentence counts to decide whether to trigger an auto-regen.
    // The karaoke highlight + sentence-skip lock-screen buttons map audio
    // time → sentence index, so as long as the number of sentences stays
    // the same the existing audio + offsets keep aligning. Add or remove
    // a sentence and every sentence past that point gets highlighted in
    // the wrong place — only a fresh synthesis can fix that.
    const oldSentenceCount = splitSentencesClient(oldText).length;
    const newSentenceCount = splitSentencesClient(newText).length;
    const needsRegen = oldSentenceCount !== newSentenceCount;

    clip.text = newText;
    if (needsRegen) {
      // Old resume position likely doesn't map cleanly to the new audio,
      // so reset it before we save and kick off the regen.
      clip.progressSec = 0;
    }
    await saveClip(clip);

    if (!needsRegen) {
      // Typo / capitalization / whitespace fix — same sentence boundaries,
      // audio still aligns. Just refresh the reading-view spans.
      setStatus(`Saved text changes to "${clip.title || "(untitled)"}."`);
      enterReadingView(newText, Array.isArray(clip.images) ? clip.images : []);
      renderLibrary();
      return;
    }

    // Sentence count changed — tell generate() to overwrite this clip's
    // audio in place. The text was already saved above; if the regen
    // is cancelled or fails, the old audio is still on disk and the
    // new text is preserved.
    setStatus(
      `Sentence count changed (${oldSentenceCount} → ${newSentenceCount}) — regenerating audio…`
    );
    _regenTargetClipId = _currentClipId;
    // Re-enter the reading view so the user can watch the new sentences
    // light up as the per-sentence streaming arrives. Sentence count
    // changed, so any URL-anchored image positions are stale — drop them.
    enterReadingView(newText, []);
    // Fire and forget — generate() drives its own status / progress UI.
    generate();
  } catch (e) {
    console.warn("save text failed:", e);
    setStatus(`Save failed: ${e.message}`, true);
  } finally {
    saveTextBtn.disabled = false;
    saveTextBtn.textContent = oldLabel;
  }
}

saveTextBtn.addEventListener("click", saveCurrentClipText);

// ---- Clear (start a new clip) -------------------------------------------
// Empty the textarea + drop the "currently-loaded clip" binding so the next
// Generate creates a fresh row instead of overwriting / saving-into the
// previous one. Deliberately *doesn't* touch the player, the library, or
// the voice/preset settings — so you can keep listening to clip A while
// typing the text for clip B, and the voice you just dialed in carries
// forward to the next generation.
function clearForNewClip() {
  // Cancel any pending auto-advance — the user is clearly starting fresh.
  _cancelAutoAdvance();

  // v205: stop audio + hide the player card. Previously Clear would
  // wipe the textarea and decouple Save text from the clip, but leave
  // the audio playing and the player card visible — which felt wrong
  // (workspace looks empty while the previous clip narrates on). The
  // user is signaling "fresh slate", so the audio is part of what
  // gets cleared.
  if (!playerEl.paused) _pauseAsUser();
  playerCard.hidden = true;

  // Clear text mid-queue also cancels the queue. Otherwise the next
  // chapter would auto-load into the just-cleared textarea and surprise
  // the user. Hide the banner too in case a detection was lingering.
  if (_chapterTotalCount > 0) {
    _chapterQueue = [];
    _chapterTotalCount = 0;
    _chapterCurrentIndex = 0;
    _pendingChapterTitle = null;
    _abortPreSynth();
    _updateChapterQueueUI();
  }
  _hideChapterBanner();

  // If we were in the reading view, drop back to the textarea so the user
  // can actually type into the (about to be empty) editor.
  if (!readingView.hidden) exitReadingView();

  textEl.value = "";
  updateCounts();

  // Decouple from the previously-loaded clip: Save text + the regen path
  // both look at _currentClipId, so leaving it pointed at the old clip
  // would mean "Save text" silently saves into the wrong row.
  _currentClipId = null;
  _currentPlayingVoiceId = null;
  _lastProgressSaveAt = 0;
  saveTextBtn.hidden = true;
  // Fade out the cover backdrop — no clip = no atmosphere.
  _setBackgroundArt(null);
  // No clip → no re-narrate banner. Reset the dismiss tracker too so a
  // future load of a different clip can prompt again.
  renarrateBanner.hidden = true;
  _renarrateDismissedClipId = null;
  // Drop any pending images from a URL fetch so they don't sneak onto
  // a freshly-typed clip.
  _pendingImages = [];
  _pendingGitRef = null;
  // v149: textarea + clip just got wiped — give the empty-state card
  // a chance to re-appear if the library is also empty.
  _updateEmptyState();

  // Wipe the sentence state so any leftover highlight from the previous
  // clip doesn't bleed into the next reading view.
  sentenceOffsetsSec = [];
  sentenceSpans = [];
  activeSentenceIdx = -1;

  textLabel.textContent = "Your text";
  textEl.focus();
  // Clear out the previously-loaded clip's bookmarks display too — they
  // belong to the clip we just decoupled from, not whatever the user
  // generates next.
  renderBookmarks();
  setStatus("Cleared. Ready for new text.");
}

clearBtn.addEventListener("click", clearForNewClip);

// v189: same pinned-scrub pattern as the book view (v187) — when the
// user manually scrolls the reading view to scan ahead, suppress
// the auto-scroll-to-active so the page stays where they put it.
// Flag flips on via wheel/touch/keyboard input on readingView;
// clears on Return-button click, sentence click, or auto-catch-up
// (audio reads forward until the active sentence is back in the
// visible portion of the reading view).
let _readingViewUserScrolled = false;
const readingViewReturnBtn = document.getElementById("reading-view-return");

// Sentence-in-viewport check. Both rects use viewport coordinates so
// a partial overlap counts as visible — same threshold the old
// auto-scroll used, just inverted.
function _readingViewActiveSpanVisible(span) {
  if (!span || !readingView) return false;
  const cRect = readingView.getBoundingClientRect();
  const sRect = span.getBoundingClientRect();
  return sRect.bottom > cRect.top && sRect.top < cRect.bottom;
}

function _readingViewUpdateReturnBtn() {
  if (!readingViewReturnBtn) return;
  // Hidden when: reading view not visible, no active sentence yet,
  // not pinned, or active sentence is already on screen.
  if (
    !readingView ||
    readingView.hidden ||
    activeSentenceIdx < 0 ||
    !_readingViewUserScrolled
  ) {
    readingViewReturnBtn.hidden = true;
    return;
  }
  const activeSpan = sentenceSpans[activeSentenceIdx];
  readingViewReturnBtn.hidden = _readingViewActiveSpanVisible(activeSpan);
}

// User-input listeners. Each pins the scroll position. Programmatic
// scrolls (the existing scrollBy in highlightCurrentSentence) DON'T
// trigger any of these, so the pin only catches real user intent.
if (readingView) {
  readingView.addEventListener("wheel", () => {
    _readingViewUserScrolled = true;
    _readingViewUpdateReturnBtn();
  }, { passive: true });
  readingView.addEventListener("touchstart", () => {
    _readingViewUserScrolled = true;
    _readingViewUpdateReturnBtn();
  }, { passive: true });
  readingView.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      _readingViewUserScrolled = true;
      _readingViewUpdateReturnBtn();
    }
  });
}
if (readingViewReturnBtn) {
  readingViewReturnBtn.addEventListener("click", () => {
    const activeSpan = sentenceSpans[activeSentenceIdx];
    if (!activeSpan) return;
    _readingViewUserScrolled = false;
    // Smooth scroll the active sentence to roughly center-vertical
    // of the reading view's visible region — feels less abrupt than
    // the original "snap to top/bottom edge" behavior.
    const cRect = readingView.getBoundingClientRect();
    const sRect = activeSpan.getBoundingClientRect();
    const target =
      sRect.top - cRect.top - cRect.height / 2 + sRect.height / 2;
    readingView.scrollBy({ top: target, behavior: "smooth" });
    _readingViewUpdateReturnBtn();
  });
}

function highlightCurrentSentence() {
  if (!sentenceSpans.length) return;
  // Use virtualTime() so the highlight tracks the right sentence even while
  // we're playing per-sentence blobs (where player.currentTime is local to
  // the current blob, not the whole document).
  const idx = currentSentenceIndex(virtualTime());
  if (idx === activeSentenceIdx) return;
  activeSentenceIdx = idx;
  sentenceSpans.forEach((span, i) => {
    span.classList.toggle("active", i === idx);
    span.classList.toggle("played", i < idx);
  });
  // v185 (M1): mirror the karaoke into the book view.
  // v187: respect the "pinned" state. When the user has manually
  // paged ahead to scan, the highlight still advances per the audio,
  // but the spread stays where they put it. Only when the active
  // sentence happens to land on the visible spread do we re-apply
  // the .active class. The nav row's "Return to current" button
  // (driven by _bookViewUpdateNav) gives the user a one-click way
  // back to the audio's location.
  if (bookView && !bookView.hidden && _bookSentenceToPage.length > 0) {
    const ppr = _bookViewPagesPerSpread();
    const desired = _bookViewSpreadOfSentence(idx, ppr);
    if (desired === _bookViewCurrentSpread) {
      // Audio caught up to where the user scrubbed to — drop the
      // pinned flag silently so the next manual-nav re-arms it.
      _bookViewUserPaged = false;
      _bookViewApplyActive(idx);
      _bookViewUpdateNav();
    } else if (_bookViewUserPaged) {
      // Pinned: leave the spread alone but refresh the nav so the
      // "Return to current" button reflects the new distance.
      _bookViewUpdateNav();
    } else {
      _bookViewRenderSpread(desired);
    }
  }
  const activeSpan = sentenceSpans[idx];
  if (activeSpan) {
    // v189: respect the pinned state. When the user has manually
    // scrolled to scan ahead, the highlight still tracks the audio
    // (above) but the scroll position stays where they put it. The
    // floating "Return to current" pill (driven by
    // _readingViewUpdateReturnBtn) gives them a one-click way back.
    if (_readingViewUserScrolled) {
      // Auto-catch-up: if the audio has read forward (or the user
      // scrolled back to where the audio is) until the active
      // sentence is now visible, silently clear the pin so the
      // auto-scroll resumes following from here.
      if (_readingViewActiveSpanVisible(activeSpan)) {
        _readingViewUserScrolled = false;
      }
      _readingViewUpdateReturnBtn();
    } else {
      // Scroll only the reading-view's own scrollbar, never the document.
      // scrollIntoView({block:"nearest"}) walks ALL scroll ancestors, so
      // when the user has scrolled the page down to reorder library cards,
      // it yanks the document back up to show the active sentence. Doing
      // the math manually with scrollBy keeps the action contained.
      const cRect = readingView.getBoundingClientRect();
      const sRect = activeSpan.getBoundingClientRect();
      if (sRect.top < cRect.top) {
        readingView.scrollBy({ top: sRect.top - cRect.top, behavior: "smooth" });
      } else if (sRect.bottom > cRect.bottom) {
        readingView.scrollBy({ top: sRect.bottom - cRect.bottom, behavior: "smooth" });
      }
    }
  }
}

editTextBtn.addEventListener("click", exitReadingView);

// ---- Book view (M1) ----------------------------------------------------
// v185 (M1): a paginated two-page spread companion to the reading
// view. Same sentence content (we re-render the same text into book-
// shaped pages), same karaoke highlight, same click-to-seek
// semantics — different layout. Pages are computed by an off-screen
// measurement pass so prose breaks on sentence boundaries, never
// mid-sentence.
//
// State:
//   _bookViewSource — {sentences, images, title, cover} stash set by
//     enterReadingView so the book view can paginate the same data
//     without redoing the splitter.
//   _bookViewPages — array of arrays; _bookViewPages[p] is the
//     sentence indices that belong on page p.
//   _bookSentenceToPage — sentence-index -> page-index lookup so
//     highlightCurrentSentence can auto-flip to the active page.
//   _bookSentenceSpans — the actual span elements rendered inside
//     book pages, mirroring sentenceSpans (the reading-view array).
//     Karaoke logic updates both arrays in lockstep.
//   _bookViewCurrentSpread — index of the currently-visible spread
//     (0 = cover + first text page on desktop).
const bookView = $("book-view");
const bookViewSpread = $("book-view-spread");
const bookViewPrev = $("book-view-prev");
const bookViewNext = $("book-view-next");
const bookViewIndicator = $("book-view-indicator");
const bookViewReturn = $("book-view-return");
const bookViewToggle = $("book-view-toggle");
const bookViewPrintBtn = $("book-view-print");
const bookViewTocBtn = $("book-view-toc");
const bookViewTocDialog = $("book-view-toc-dialog");
const bookViewTocList = $("book-view-toc-list");
const bookViewTocClose = $("book-view-toc-close");
// v208 (M6.2/M6.3) refs.
const bookViewFind = $("book-view-find");
const bookViewFindInput = $("book-view-find-input");
const bookViewFindCount = $("book-view-find-count");
const bookViewFindPrev = $("book-view-find-prev");
const bookViewFindNext = $("book-view-find-next");
const bookViewFindClose = $("book-view-find-close");
// v208 (M6.2): flag set while the indicator is in click-to-edit mode
// so _bookViewUpdateNav doesn't clobber the input's value mid-typing.
let _bookViewIndicatorEditing = false;
// v208 (M6.3): current find-mode state. matches is sentence indices.
let _bookViewFindMatches = [];
let _bookViewFindCursor = 0;
// v187: "pinned" state — when the user manually pages (prev/next,
// arrow keys, swipe), suppress the auto-flip-on-active-sentence
// behavior so the spread stays where the reader put it while scanning
// ahead. The "Return to current" button shows whenever the audio's
// active sentence lives on a different spread. Reset to false when
// the user clicks that button or clicks a sentence on the visible
// spread (they're indicating they want to engage here).
let _bookViewUserPaged = false;
let _bookViewSource = null;
let _bookViewPages = [];           // [[sentenceIdx, ...], ...]
let _bookSentenceToPage = [];      // sentenceIdx -> pageIdx
let _bookSentenceSpans = [];       // sentenceIdx -> <span> in book DOM
let _bookViewCurrentSpread = 0;
let _bookViewSpreadsCount = 1;
// Desktop = two-page spread; mobile = single page. We compute this
// per-render from a media query so a window resize across the
// breakpoint just triggers a re-pagination on the next open.
function _bookViewPagesPerSpread() {
  return window.matchMedia("(max-width: 720px)").matches ? 1 : 2;
}

// v200 (M3.2): bucket clip.images by sentence_index. Mirrors the
// reading-view's reading-time logic so the book view places images
// against the same sentence the reading view does. Indexes beyond
// sentences.length collapse to a trailing bucket keyed at
// sentences.length, rendered after the final sentence on the last
// text page.
function _bookViewBucketImages(images, sentenceCount) {
  const m = new Map();
  if (!Array.isArray(images)) return m;
  for (const img of images) {
    if (!img || !img.src) continue;
    const raw = Number(img.sentence_index);
    const idx = Number.isFinite(raw)
      ? Math.max(0, Math.min(sentenceCount, Math.floor(raw)))
      : sentenceCount;
    if (!m.has(idx)) m.set(idx, []);
    m.get(idx).push(img);
  }
  return m;
}

// v200 (M3.2): preload natural dimensions for every image so the
// paginator's probe can reserve correct vertical space — without
// known dimensions, an <img> in the probe contributes 0 to
// scrollHeight until it loads asynchronously, and pagination races
// the network. Resolved-from-cache loads are near-instant on the
// second open since the reading view already fetched these.
// Failed loads stash null so the renderer can drop them.
function _bookViewPreloadImages(images) {
  return new Promise((resolve) => {
    const dims = new Map();
    if (!Array.isArray(images) || !images.length) return resolve(dims);
    let pending = 0;
    for (const img of images) {
      if (!img || !img.src || dims.has(img.src)) continue;
      pending++;
      const probe = new Image();
      probe.onload = () => {
        dims.set(img.src, { width: probe.naturalWidth, height: probe.naturalHeight });
        if (--pending === 0) resolve(dims);
      };
      probe.onerror = () => {
        dims.set(img.src, null);
        if (--pending === 0) resolve(dims);
      };
      probe.src = img.src;
    }
    if (pending === 0) resolve(dims);
  });
}

// v200 (M3.2): make an <img> element for a book-view page, sized
// to fit the page's content area. Explicit width/height attrs make
// the browser allocate the right vertical space immediately — the
// probe doesn't need to wait for the network. Clamp display height
// to half the page so an image never dominates. numColumns isn't
// reflected here yet; magazine 2-column will let images span the
// gutter (CSS column-span: all) instead of squeezing into one col.
function _bookViewMakeImageEl(imgRecord, dims, pageWidth, pageHeight) {
  const el = document.createElement("img");
  el.className = "book-inline-image";
  el.src = imgRecord.src;
  el.alt = imgRecord.alt || "";
  el.decoding = "async";
  el.loading = "eager";
  const d = dims.get(imgRecord.src);
  const contentWidth = pageWidth - 64;  // .book-page padding 32×2
  const maxHeight = Math.round(pageHeight * 0.5);
  // v207 (M5.3): in magazine theme, content flows in 2 columns. By
  // default an image gets column-span: all (spans both columns) which
  // suits chapter-opening figures but is overkill for small inline
  // graphics. Detect "small" via natural width < 1× single column;
  // mark via data-single-col so CSS skips the column-span override
  // and the image renders inside whichever column it landed in.
  const isMagazine =
    bookView && bookView.dataset.bookTheme === "magazine" && pageWidth > 480;
  const singleColumnContentWidth =
    isMagazine ? Math.round((pageWidth - 64 - 24) / 2) : contentWidth;
  if (d && d.width && d.height) {
    // M5.3: route small-in-magazine images into a single column.
    if (isMagazine && d.width < singleColumnContentWidth * 1.1) {
      el.dataset.singleCol = "true";
    }
    const targetMaxWidth = el.dataset.singleCol
      ? singleColumnContentWidth
      : contentWidth;
    const scale = Math.min(1, targetMaxWidth / d.width);
    const displayWidth = Math.round(d.width * scale);
    let displayHeight = Math.round(d.height * scale);
    if (displayHeight > maxHeight) {
      // Letterbox: cap height, scale width to match natural aspect.
      const verticalScale = maxHeight / displayHeight;
      displayHeight = maxHeight;
    }
    el.width = displayWidth;
    el.height = displayHeight;
  } else if (d === null) {
    // Known-failed load. Don't reserve space — renderer will drop.
    el.style.display = "none";
  } else {
    // Unknown dims (image not in preload map). Reserve a placeholder.
    el.height = 240;
  }
  // Failed loads: drop from DOM so they don't leave a void.
  el.addEventListener("error", () => el.remove(), { once: true });
  return el;
}

// v201 (M5.1): overflow predicate. The previous paginator only
// checked vertical overflow via `body.scrollHeight > pageHeight - 1`,
// which works for single-column themes (paperback, manuscript) where
// body's min-height: auto lets it grow past its flex allocation when
// content is too tall. Multi-column themes (magazine) overflow
// DIFFERENTLY: with column-count > 1 + column-fill: auto inside a
// fixed-height flex child, content past the last column extends
// horizontally to the right of the body, so scrollWidth grows but
// scrollHeight stays at clientHeight. The previous check would never
// fire in magazine, and the paginator would pack every sentence on
// page 1 (visually clipped by .book-page overflow: hidden).
//
// The hybrid below catches both cases. The +1 / -1 tolerances absorb
// sub-pixel rounding so a body whose content fits exactly to the
// pixel doesn't get a spurious overflow signal.
function _bookViewBodyOverflows(body, pageHeight) {
  if (body.scrollHeight > pageHeight - 1) return true;
  if (body.scrollWidth > body.clientWidth + 1) return true;
  return false;
}

// v211 (M7.1): text highlights. Selection within a single .sentence
// span surfaces a floating toolbar; clicking a color saves a highlight
// to clip.highlights[] and re-renders the affected sentence wrapped
// in coloured spans. Works in both book view and reading view —
// _buildSentenceContent() is the shared renderer.
//
// Storage shape: clip.highlights = [{
//   id: number (Date.now() unique key),
//   sentence_index: number,
//   char_start: number, char_end: number,
//   color: "yellow" | "pink" | "blue",
//   createdAt: ISO string,
// }, ...]
//
// Multi-sentence selections are not supported in v1 — the toolbar
// stays hidden. Users adapt quickly; complex multi-span highlight
// math can wait for a later iteration.
const highlightToolbar = $("highlight-toolbar");
let _highlightActiveSelectionInfo = null;

function _getSelectionInsideSentence() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const endEl = range.endContainer.nodeType === Node.TEXT_NODE
    ? range.endContainer.parentElement
    : range.endContainer;
  if (!startEl || !endEl) return null;
  const sentenceSpan = startEl.closest(".sentence");
  if (!sentenceSpan) return null;
  // Multi-sentence selections: punt for v1.
  if (endEl.closest(".sentence") !== sentenceSpan) return null;
  const sIdx = parseInt(sentenceSpan.dataset.index, 10);
  if (Number.isNaN(sIdx)) return null;
  // Compute offset within the sentence's textContent. The sentence
  // span may contain mixed text + highlight spans (re-rendered). We
  // walk the span's text nodes summing lengths until we hit the
  // range's start/end containers.
  const offsetIn = (container, offset) => {
    let pos = 0;
    const walker = document.createTreeWalker(
      sentenceSpan, NodeFilter.SHOW_TEXT, null
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node === container) return pos + offset;
      pos += node.nodeValue.length;
    }
    return pos;
  };
  let start = offsetIn(range.startContainer, range.startOffset);
  let end = offsetIn(range.endContainer, range.endOffset);
  if (start > end) [start, end] = [end, start];
  if (start === end) return null;
  return {
    sentence_index: sIdx,
    char_start: start,
    char_end: end,
    rect: range.getBoundingClientRect(),
  };
}

function _showHighlightToolbar(info) {
  if (!highlightToolbar || !info) return;
  highlightToolbar.hidden = false;
  // Position above the selection, clipped to viewport.
  const r = info.rect;
  const toolbarH = 36;
  let top = r.top + window.scrollY - toolbarH - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
  let left = r.left + window.scrollX + r.width / 2 - 80;
  if (left < 8) left = 8;
  if (left + 160 > window.innerWidth) left = window.innerWidth - 168;
  highlightToolbar.style.top = `${top}px`;
  highlightToolbar.style.left = `${left}px`;
  _highlightActiveSelectionInfo = info;
}

function _hideHighlightToolbar() {
  if (highlightToolbar) highlightToolbar.hidden = true;
  _highlightActiveSelectionInfo = null;
}

async function _saveHighlight(info, color) {
  if (!_currentClipId) return;
  try {
    const clip = await getClip(_currentClipId);
    if (!clip) return;
    if (!Array.isArray(clip.highlights)) clip.highlights = [];
    if (color === null) {
      // Remove: drop any highlight that overlaps the selected range
      // on the same sentence. v1: simple inclusive overlap check.
      clip.highlights = clip.highlights.filter((h) =>
        !(h.sentence_index === info.sentence_index &&
          h.char_end > info.char_start && h.char_start < info.char_end)
      );
    } else {
      clip.highlights.push({
        id: Date.now(),
        sentence_index: info.sentence_index,
        char_start: info.char_start,
        char_end: info.char_end,
        color,
        createdAt: new Date().toISOString(),
      });
    }
    await saveClip(clip);
    // Re-render affected views.
    if (sentenceSpans && sentenceSpans[info.sentence_index]) {
      const span = sentenceSpans[info.sentence_index];
      span.innerHTML = _buildSentenceContentHTML(
        _bookViewSource && _bookViewSource.sentences
          ? _bookViewSource.sentences[info.sentence_index]
          : span.textContent.replace(/ $/, ""),
        info.sentence_index,
        clip.highlights
      );
    }
    if (typeof bookView !== "undefined" && bookView && !bookView.hidden) {
      if (_bookViewSource) _bookViewSource.highlights = clip.highlights;
      _bookViewRenderSpread(_bookViewCurrentSpread);
    }
  } catch (e) {
    console.warn("highlight save failed:", e);
  }
}

// Build the HTML for a sentence span's content, with any highlight
// ranges wrapped in <span class="text-highlight" data-color="...">.
// Used by both book-view sentence rendering and reading-view sentence
// rendering. Returns a string of innerHTML (caller assigns to span).
// Highlights are clamped to the sentence's text bounds + de-overlapped
// by selecting the latest highlight on overlap (last-write-wins).
function _buildSentenceContentHTML(text, sentenceIdx, highlights) {
  const myHighlights = (Array.isArray(highlights) ? highlights : [])
    .filter((h) => h.sentence_index === sentenceIdx)
    .map((h) => ({
      ...h,
      char_start: Math.max(0, Math.min(text.length, h.char_start)),
      char_end: Math.max(0, Math.min(text.length, h.char_end)),
    }))
    .filter((h) => h.char_end > h.char_start)
    .sort((a, b) => a.char_start - b.char_start || b.id - a.id);
  if (!myHighlights.length) {
    return _escapeHtmlForSentence(text);
  }
  // Walk text + highlight starts/ends, emitting either plain text or
  // wrapped highlight segments. Skip overlapping highlights past the
  // first one on a position.
  const out = [];
  let cursor = 0;
  for (const h of myHighlights) {
    if (h.char_start < cursor) continue;  // overlaps previously-emitted
    if (h.char_start > cursor) {
      out.push(_escapeHtmlForSentence(text.slice(cursor, h.char_start)));
    }
    out.push(
      `<span class="text-highlight" data-color="${h.color}">` +
      _escapeHtmlForSentence(text.slice(h.char_start, h.char_end)) +
      `</span>`
    );
    cursor = h.char_end;
  }
  if (cursor < text.length) {
    out.push(_escapeHtmlForSentence(text.slice(cursor)));
  }
  return out.join("");
}

function _escapeHtmlForSentence(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wire selection listeners + toolbar buttons.
document.addEventListener("pointerup", (e) => {
  // Defer to next tick so the selection is finalized.
  setTimeout(() => {
    // Ignore if the pointerup was inside the toolbar (color click).
    if (highlightToolbar && highlightToolbar.contains(e.target)) return;
    const info = _getSelectionInsideSentence();
    if (info) {
      _showHighlightToolbar(info);
    } else {
      _hideHighlightToolbar();
    }
  }, 0);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && highlightToolbar && !highlightToolbar.hidden) {
    _hideHighlightToolbar();
  }
});
if (highlightToolbar) {
  highlightToolbar.addEventListener("pointerdown", (e) => {
    // Prevent selection collapse when clicking a toolbar button.
    e.preventDefault();
  });
  highlightToolbar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || !_highlightActiveSelectionInfo) return;
    const action = btn.dataset.action;
    const color = btn.dataset.color;
    const info = _highlightActiveSelectionInfo;
    _hideHighlightToolbar();
    window.getSelection()?.removeAllRanges();
    await _saveHighlight(info, action === "remove" ? null : color);
  });
}

// v206 (M4.1): detect chapter boundaries inside a clip's sentence
// array. Returns [{sentence_index, title}, ...] for each detected
// chapter, sorted by sentence_index. The sentence at sentence_index
// IS the chapter heading (or whatever opens the chapter) — drop cap
// fires on it, running header on subsequent pages keys off it, TOC
// jumps to it.
//
// Patterns matched (in order, first hit wins per sentence):
//   1. Markdown ATX heading: # / ## / ### Title
//   2. "Chapter N" / "CHAPTER 12" / "Part Three" — number or
//      lowercase word, optional subtitle after :/—/.
//   3. Bare Roman numeral as a short standalone sentence ("II.")
//
// Numeric/Roman-only titles get auto-promoted to "Chapter <N>" so a
// table of contents reads sensibly.
function _bookViewDetectChapters(sentences) {
  if (!Array.isArray(sentences) || sentences.length < 4) return [];
  const ROMAN = /^[ivxlcdm]+\.?$/i;
  const NUMERIC = /^[0-9]+$/;
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const raw = (sentences[i] || "").trim();
    if (!raw) continue;
    let title = null;
    let m;
    // 1. Markdown ATX
    m = raw.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (m) title = m[2].trim();
    // 2. Chapter/Part/Book/Section + N
    if (!title) {
      m = raw.match(
        /^(chapter|part|book|section)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b[\s.:—–-]*(.*)$/i
      );
      if (m) {
        const word = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
        const num = m[2].trim();
        const subtitle = (m[3] || "").trim();
        title = subtitle ? `${word} ${num}: ${subtitle}` : `${word} ${num}`;
      }
    }
    // 3. Bare Roman numeral as a short sentence (Standard Ebooks
    //    convention). Cap at 20 chars so a regular sentence
    //    starting with "I" doesn't get treated as a chapter.
    if (!title && raw.length < 20 && ROMAN.test(raw)) {
      title = `Chapter ${raw.replace(/\.$/, "").toUpperCase()}`;
    }
    if (!title) continue;
    // Promote numeric / Roman-only titles to "Chapter <N>" — a TOC
    // entry of just "II" is useless.
    if (NUMERIC.test(title) || /^[ivxlcdm]+$/i.test(title)) {
      title = `Chapter ${title.toUpperCase()}`;
    }
    out.push({ sentence_index: i, title });
  }
  return out;
}

// v206 (M4.3): which chapter contains the given sentence index?
// Returns null if no chapters at all (single-clip mode), or if the
// sentence falls before the first detected chapter (clip preamble).
function _bookViewChapterAt(sentenceIdx) {
  const chapters = (_bookViewSource && _bookViewSource.chapters) || [];
  let last = null;
  for (const ch of chapters) {
    if (ch.sentence_index <= sentenceIdx) last = ch;
    else break;
  }
  return last;
}

// v210 (M6.1): which pages contain a bookmark? Returns a Set of
// page indices. Bookmarks are time-based; convert each timeSec to
// a sentence index via the sentenceOffsetsSec array (cumulative
// per-sentence start times), then lookup the page via
// _bookSentenceToPage. Returns empty if no bookmarks or no
// pagination yet.
function _bookViewBookmarkedPageSet() {
  const out = new Set();
  const bms = (_bookViewSource && _bookViewSource.bookmarks) || [];
  if (!bms.length || !sentenceOffsetsSec || !sentenceOffsetsSec.length) return out;
  for (const bm of bms) {
    const t = (bm && typeof bm.timeSec === "number") ? bm.timeSec : 0;
    let sIdx = 0;
    for (let i = 0; i < sentenceOffsetsSec.length; i++) {
      if (sentenceOffsetsSec[i] <= t) sIdx = i;
      else break;
    }
    const pageIdx = _bookSentenceToPage[sIdx];
    if (pageIdx !== undefined) out.add(pageIdx);
  }
  return out;
}

// v206 (M4.2): is the given sentence index the first sentence of a
// chapter? Used by the renderer to decide drop-cap placement.
function _bookViewIsChapterStart(sentenceIdx) {
  const chapters = (_bookViewSource && _bookViewSource.chapters) || [];
  for (const ch of chapters) {
    if (ch.sentence_index === sentenceIdx) return true;
    if (ch.sentence_index > sentenceIdx) return false;
  }
  return false;
}

// Pure helper: split a list of sentences into per-page buckets by
// measuring how many fit in a given page height. Uses a hidden
// measurement container styled identically to a real .book-page so
// font metrics + hyphenation match exactly. Returns an array of
// [sentenceIndex, ...] for each page.
//
// v197 (M2): the probe page now includes the same header + footer
// elements that the renderer produces, so the body's available
// height reflects the actual rendered page. Without these stand-ins,
// the paginator would over-fill pages by ~50px each (header height +
// footer height + their borders/margins) and rendered pages would
// silently overflow.
//
// v200 (M3.2): optional imgByIdx (sentence_index → [imgRecord, ...])
// and imgDims (src → {width, height} | null) interleave images with
// sentences. An image attached to sentence N renders BEFORE that
// sentence; if image + sentence don't fit on the current page,
// both move to the next page together (the image is "anchored" to
// its sentence and never separates from it).
function _bookViewPaginate(sentences, pageWidth, pageHeight, imgByIdx, imgDims) {
  if (!sentences.length) return [[]];

  // Build the off-screen measurement page.
  const probe = document.createElement("div");
  probe.className = "book-view-measure";
  // v199 (M3.1): copy the book-view's current theme onto the probe
  // so measurement uses the same font family / line-height /
  // column-count as the live render. Without this, switching themes
  // would paginate against paperback metrics but render with
  // magazine metrics, and pages would visibly overflow.
  if (bookView && bookView.dataset.bookTheme) {
    probe.dataset.bookTheme = bookView.dataset.bookTheme;
  }
  // v199 (M3.1): also copy the font-size custom property — it's set
  // on bookView's style attribute (not a CSS rule), so it doesn't
  // cascade to the probe unless the probe is mounted inside bookView
  // or the var is restated here.
  if (bookView) {
    const fs = bookView.style.getPropertyValue("--book-font-size");
    if (fs) probe.style.setProperty("--book-font-size", fs);
  }
  const page = document.createElement("div");
  page.className = "book-page";
  page.style.width = `${pageWidth}px`;
  page.style.height = `${pageHeight}px`;
  // Header probe — same class as the real header, populated with a
  // 1-char placeholder so the line-height + padding compute (an
  // empty element collapses to 0 height in some font stacks).
  const probeHeader = document.createElement("div");
  probeHeader.className = "book-page-header";
  probeHeader.textContent = "·";
  page.appendChild(probeHeader);
  const body = document.createElement("div");
  body.className = "book-page-body";
  page.appendChild(body);
  // Footer probe.
  const probeFooter = document.createElement("div");
  probeFooter.className = "book-page-footer";
  probeFooter.textContent = "·";
  page.appendChild(probeFooter);
  probe.appendChild(page);
  document.body.appendChild(probe);

  const pages = [[]];
  let current = pages[0];
  // v200 (M3.2): each iteration places an image-anchored unit
  // (= zero or more images attached to sentence i, then the sentence
  // itself). The unit is atomic — if any part overflows, the whole
  // unit moves to the next page so the image stays with its sentence.
  for (let i = 0; i < sentences.length; i++) {
    // v206 (M4.2): force a page break BEFORE a chapter start so each
    // chapter opens on a fresh page (book convention). Skip when the
    // current page is empty — chapter 1 is allowed to lead the first
    // page. _bookViewIsChapterStart reads from _bookViewSource.chapters
    // which enterBookView populates before calling the paginator.
    if (current.length > 0 && _bookViewIsChapterStart(i)) {
      pages.push([]);
      current = pages[pages.length - 1];
      body.innerHTML = "";
    }
    const imgs = imgByIdx ? (imgByIdx.get(i) || []) : [];
    const placedImgEls = [];
    for (const img of imgs) {
      const el = _bookViewMakeImageEl(img, imgDims, pageWidth, pageHeight);
      body.appendChild(el);
      placedImgEls.push(el);
    }
    const span = document.createElement("span");
    span.className = "sentence";
    span.textContent = sentences[i] + " ";
    body.appendChild(span);
    if (_bookViewBodyOverflows(body, pageHeight)) {
      // Roll the entire unit off the current page.
      for (const el of placedImgEls) body.removeChild(el);
      body.removeChild(span);
      // Edge case: current page is empty AND the unit still won't
      // fit. Accept it on its own page (overflow visually trimmed
      // by CSS overflow: hidden on .book-page). Without this the
      // loop would infinite-loop on an oversize-image scenario.
      if (current.length === 0) {
        for (const img of imgs) {
          body.appendChild(_bookViewMakeImageEl(img, imgDims, pageWidth, pageHeight));
        }
        body.appendChild(span);
        current.push(i);
        pages.push([]);
        current = pages[pages.length - 1];
        body.innerHTML = "";
        continue;
      }
      // Start a new page with this unit.
      pages.push([i]);
      current = pages[pages.length - 1];
      body.innerHTML = "";
      for (const img of imgs) {
        body.appendChild(_bookViewMakeImageEl(img, imgDims, pageWidth, pageHeight));
      }
      const span2 = document.createElement("span");
      span2.className = "sentence";
      span2.textContent = sentences[i] + " ";
      body.appendChild(span2);
    } else {
      current.push(i);
    }
  }
  if (current.length === 0 && pages.length > 1) pages.pop();
  // v207 (M5.2): trailing images (sentence_index >= sentences.length)
  // get their own paginated section. Previously the renderer just
  // dumped them on the last text page without an overflow check —
  // a chapter with many or oversize trailing figures would silently
  // clip. Now we measure each, fitting on the current (last text)
  // page first; on overflow, spill into new pages.
  //
  // Per-page trailing-image bucket lives on _bookViewSource so the
  // renderer can look it up by page index without changing the
  // _bookViewPages return shape. Cleared at the start of every
  // paginate so a previous run's data doesn't leak in.
  const trailingByPage = new Map();
  if (_bookViewSource) _bookViewSource.trailingByPage = trailingByPage;
  const trailing = imgByIdx ? (imgByIdx.get(sentences.length) || []) : [];
  if (trailing.length) {
    // current/body still reflect the state of the last text page
    // from the loop above. Try fitting each trailing image there
    // before spilling.
    for (const img of trailing) {
      let el = _bookViewMakeImageEl(img, imgDims, pageWidth, pageHeight);
      body.appendChild(el);
      if (_bookViewBodyOverflows(body, pageHeight)) {
        body.removeChild(el);
        // Spill: create a fresh trailing page (empty sentence list).
        pages.push([]);
        current = pages[pages.length - 1];
        body.innerHTML = "";
        el = _bookViewMakeImageEl(img, imgDims, pageWidth, pageHeight);
        body.appendChild(el);
      }
      const pageIdx = pages.length - 1;
      if (!trailingByPage.has(pageIdx)) trailingByPage.set(pageIdx, []);
      trailingByPage.get(pageIdx).push(img);
    }
  }
  probe.remove();
  return pages;
}

// Build the actual book DOM from the paginated buckets. Renders one
// or two pages at a time (driven by _bookViewPagesPerSpread) into
// the spread container. The cover takes slot 0 on the first spread;
// text pages flow into the remaining slots. Returns the total spread
// count so the indicator + nav state can update.
function _bookViewRenderSpread(spreadIdx, flipDirection = null) {
  if (!bookViewSpread) return 0;
  // v220: capture the page that's about to flip out BEFORE we wipe
  // the DOM. We'll re-attach it as an absolutely-positioned overlay
  // after the new spread is rendered, then animate it rotating
  // around the spine. backface-visibility: hidden in the CSS makes
  // the overlay disappear at the 90° mark, revealing the new content
  // underneath without us having to render anything to the back side.
  let _flipOverlay = null;
  if (
    flipDirection &&
    bookViewSpread.children.length > 0 &&
    _bookViewAnimationsEnabled()
  ) {
    // forward: the right page flips away; back: the left page does.
    // On mobile (single-page spreads) there's just one slot, which
    // is the page we flip regardless of direction.
    const ppr = _bookViewPagesPerSpread();
    const flipSlot = ppr === 2 ? (flipDirection === "forward" ? 1 : 0) : 0;
    const oldPage = bookViewSpread.children[flipSlot];
    if (oldPage) {
      _flipOverlay = oldPage.cloneNode(true);
      _flipOverlay.classList.add("book-page-flipping");
      _flipOverlay.classList.add(`flip-${flipDirection}`);
    }
  }
  bookViewSpread.innerHTML = "";
  _bookSentenceSpans = [];
  const ppr = _bookViewPagesPerSpread();
  // Spread 0 reserves the left slot for the cover; subsequent spreads
  // pack page content into all slots. So total spreads is
  // ceil((textPages + 1coverSlot) / ppr) on desktop, or
  // 1coverSpread + ceil(textPages/1) on mobile.
  const textPageCount = _bookViewPages.length;
  let totalSpreads;
  if (ppr === 2) {
    totalSpreads = Math.ceil((textPageCount + 1) / 2);
  } else {
    // Mobile: cover gets its own spread, then one text page per spread.
    totalSpreads = textPageCount + 1;
  }
  if (totalSpreads < 1) totalSpreads = 1;
  _bookViewSpreadsCount = totalSpreads;
  if (spreadIdx < 0) spreadIdx = 0;
  if (spreadIdx >= totalSpreads) spreadIdx = totalSpreads - 1;
  _bookViewCurrentSpread = spreadIdx;

  // Compute which "slot" of the global flow we're rendering. Slot 0
  // is always the cover; slots 1..N are text page indexes 0..N-1.
  const startSlot = spreadIdx * ppr;
  for (let s = 0; s < ppr; s++) {
    const slot = startSlot + s;
    const pageEl = document.createElement("div");
    pageEl.className = "book-page";
    if (slot === 0) {
      // Cover page.
      pageEl.classList.add("book-page-cover");
      const src = _bookViewSource;
      if (src && src.cover && src.cover.blob) {
        const img = document.createElement("img");
        img.className = "book-page-cover-art";
        img.alt = src.title || "Cover";
        try {
          img.src = URL.createObjectURL(src.cover.blob);
          img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
        } catch {}
        pageEl.appendChild(img);
      } else {
        // Hash-gradient fallback. Uses the same title-hash color the
        // library card swatch derives so the cover matches the card.
        const fb = document.createElement("div");
        fb.className = "book-page-cover-fallback";
        const seed = (src && src.title) || "Untitled";
        fb.style.background = _coverFallbackGradient(seed);
        fb.textContent = seed.trim().slice(0, 1).toUpperCase() || "•";
        pageEl.appendChild(fb);
      }
      if (src && src.title) {
        const t = document.createElement("div");
        t.className = "book-page-cover-title";
        t.textContent = src.title;
        pageEl.appendChild(t);
      }
    } else {
      // Text page. slot 1 → text page 0; slot 2 → text page 1; ...
      const textPageIdx = slot - 1;
      const sentenceIdxs = _bookViewPages[textPageIdx] || [];

      // v210 (M6.1): bookmarked-page ribbon. A small accent-coloured
      // pennant in the top-right corner appears on every page that
      // contains a saved bookmark (resolved via timeSec → sentence
      // → page). Placed at the page level (not body) so it survives
      // body re-renders and doesn't get caught in column flow.
      if (_bookViewBookmarkedPageSet().has(textPageIdx)) {
        const ribbon = document.createElement("div");
        ribbon.className = "book-page-bookmark";
        ribbon.setAttribute("aria-label", "Bookmarked page");
        ribbon.title = "Bookmarked";
        pageEl.appendChild(ribbon);
      }

      // v197 (M2) + v206 (M4.3): running header. When chapters are
      // detected, use the title of the chapter containing this
      // page's first sentence (book convention — left page would
      // ideally be the clip title, right page the chapter, but the
      // simpler "chapter on every page" reads cleanly in a single-
      // spread book view). Falls back to the clip title when no
      // chapter covers this page (preamble before chapter 1) OR
      // when there are no detected chapters at all.
      const _firstSentenceForHeader =
        (_bookViewPages[textPageIdx] && _bookViewPages[textPageIdx][0]) || 0;
      const _chapterForHeader = _bookViewChapterAt(_firstSentenceForHeader);
      const headerTitle =
        (_chapterForHeader && _chapterForHeader.title) ||
        (_bookViewSource && _bookViewSource.title) ||
        "";
      if (headerTitle) {
        const header = document.createElement("div");
        header.className = "book-page-header";
        header.textContent = headerTitle;
        pageEl.appendChild(header);
      }

      const body = document.createElement("div");
      body.className = "book-page-body";
      // v197 (M2) + v206 (M4.2): drop cap on the first page of
      // every chapter. The first text page is treated as chapter 0
      // even when no chapters are detected — single-clip fallback.
      const _firstSentence = sentenceIdxs[0];
      if (textPageIdx === 0 || _bookViewIsChapterStart(_firstSentence)) {
        body.dataset.dropCap = "true";
      }
      // v200 (M3.2): images for any sentence on this page render
      // inline before their anchor sentence. Source of truth is
      // _bookViewSource.imgByIdx (computed in enterBookView and
      // reused on repagination so the renderer never re-buckets).
      // v206 (M4.2): chapter-aware drop cap. Drop cap fires when
      // any sentence on this page is the start of a chapter (not
      // just textPageIdx === 0). The paginator forces a page break
      // before each chapter, so chapter-start is always the page's
      // FIRST sentence — that's where ::first-letter targets.
      const imgByIdx = (_bookViewSource && _bookViewSource.imgByIdx) || null;
      for (const sIdx of sentenceIdxs) {
        if (imgByIdx && imgByIdx.has(sIdx)) {
          for (const img of imgByIdx.get(sIdx)) {
            const el = document.createElement("img");
            el.className = "book-inline-image";
            el.src = img.src;
            el.alt = img.alt || "";
            el.loading = "lazy";
            el.decoding = "async";
            el.addEventListener("error", () => el.remove(), { once: true });
            body.appendChild(el);
          }
        }
        const span = document.createElement("span");
        span.className = "sentence";
        span.dataset.index = String(sIdx);
        const wc = _countWords(_bookViewSource.sentences[sIdx]);
        if (wc >= LONG_SENTENCE_WORD_THRESHOLD) {
          span.dataset.longSentence = "true";
          span.dataset.wordCount = String(wc);
          span.title = `${wc} words`;
        }
        // v211 (M7.1): use the shared content builder so any saved
        // highlights for this sentence render as wrapped spans.
        // Falls back to plain text when there are no highlights.
        const _hl = (_bookViewSource && _bookViewSource.highlights) || [];
        span.innerHTML = _buildSentenceContentHTML(
          _bookViewSource.sentences[sIdx], sIdx, _hl
        ) + " ";
        // Click → seek audio. Reuses the existing seekToSentence path.
        // v187: clicking a sentence on the visible spread means
        // "engage here" — drop the pinned state so the highlight
        // resumes auto-following.
        span.addEventListener("click", () => {
          _bookViewUserPaged = false;
          seekToSentence(sIdx);
          if (playerEl.paused) playerEl.play().catch(() => {});
        });
        body.appendChild(span);
        _bookSentenceSpans[sIdx] = span;
      }
      // v207 (M5.2): trailing images live in a per-page bucket on
      // _bookViewSource.trailingByPage (populated by the paginator).
      // Render whatever images this specific page got; if the
      // paginator put zero on this page, this is a no-op.
      const _trailingForThisPage =
        (_bookViewSource && _bookViewSource.trailingByPage &&
          _bookViewSource.trailingByPage.get(textPageIdx)) || [];
      for (const img of _trailingForThisPage) {
        const el = document.createElement("img");
        el.className = "book-inline-image";
        el.src = img.src;
        el.alt = img.alt || "";
        el.loading = "lazy";
        el.decoding = "async";
        el.addEventListener("error", () => el.remove(), { once: true });
        body.appendChild(el);
      }
      pageEl.appendChild(body);

      // v197 (M2): page-number footer. textPageIdx is 0-indexed;
      // human page numbers are 1-indexed. Skipping the "of N"
      // suffix avoids re-rendering every page when a single page's
      // count drifts (e.g., re-pagination at a new font size); a
      // single number is what real books show anyway.
      const footer = document.createElement("div");
      footer.className = "book-page-footer";
      footer.textContent = String(textPageIdx + 1);
      pageEl.appendChild(footer);
    }
    bookViewSpread.appendChild(pageEl);
  }
  _bookViewUpdateNav();
  // After re-render, re-apply the karaoke state for the currently-
  // active sentence (if any). The reading view's spans already carry
  // .active; the book view's freshly-minted spans need to catch up.
  if (activeSentenceIdx >= 0) {
    _bookViewApplyActive(activeSentenceIdx);
  }
  // v220: page-flip animation. _flipOverlay was captured at the top
  // of the function from the OLD spread, before this re-render wiped
  // it. Re-attach it as an absolute overlay over the spread; the CSS
  // keyframes rotate it around the spine, and backface-visibility:
  // hidden makes it disappear at the 90° mark — exposing the new
  // content (already rendered) underneath. We listen for animationend
  // so we can clean up the orphan node.
  if (_flipOverlay) {
    bookViewSpread.appendChild(_flipOverlay);
    const overlay = _flipOverlay;
    const cleanup = () => {
      overlay.removeEventListener("animationend", cleanup);
      overlay.removeEventListener("animationcancel", cleanup);
      overlay.remove();
    };
    overlay.addEventListener("animationend", cleanup);
    // Belt-and-suspenders: if a tab-switch or rapid re-render aborts
    // the animation, animationcancel fires and we still clean up.
    overlay.addEventListener("animationcancel", cleanup);
    // Hard fallback — if no event fires within 1.2s (animation is 0.6s),
    // assume something went wrong and yank the overlay anyway.
    setTimeout(cleanup, 1200);
  }
  return totalSpreads;
}

// v220: prefers-reduced-motion + an opt-out localStorage flag for
// users who find the flip distracting. Defaults to enabled.
function _bookViewAnimationsEnabled() {
  try {
    if (localStorage.getItem("narrative.bookFlipDisabled") === "1") return false;
  } catch {}
  if (typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  }
  return true;
}

function _bookViewUpdateNav() {
  if (bookViewPrev) bookViewPrev.disabled = _bookViewCurrentSpread <= 0;
  if (bookViewNext) bookViewNext.disabled = _bookViewCurrentSpread >= _bookViewSpreadsCount - 1;
  if (bookViewIndicator && !_bookViewIndicatorEditing) {
    // v208 (M6.2): guard textContent update during edit mode so the
    // user's input field isn't clobbered by a re-render mid-typing.
    bookViewIndicator.textContent =
      `Spread ${_bookViewCurrentSpread + 1} of ${_bookViewSpreadsCount}`;
  }
  // v187: show "Return to current" only when the user has scrubbed
  // away from where the audio is. Also requires actual audio
  // progress — no point offering a return when nothing's playing yet.
  if (bookViewReturn) {
    if (
      _bookViewUserPaged &&
      activeSentenceIdx >= 0 &&
      _bookSentenceToPage.length > 0
    ) {
      const ppr = _bookViewPagesPerSpread();
      const activeSpread = _bookViewSpreadOfSentence(activeSentenceIdx, ppr);
      bookViewReturn.hidden = activeSpread === _bookViewCurrentSpread;
    } else {
      bookViewReturn.hidden = true;
    }
  }
}

// v187: helper called from every manual-nav path (prev/next buttons,
// arrow keys, swipe). Renders the requested spread + flips the
// pinned flag on so subsequent active-sentence updates don't yank
// the spread back. Centralized so a future fourth manual-nav path
// (keyboard shortcuts overlay, gestures, etc.) just calls this.
function _bookViewNavigateManual(targetSpread) {
  if (targetSpread < 0 || targetSpread >= _bookViewSpreadsCount) return;
  _bookViewUserPaged = true;
  // v220: pass the direction so _bookViewRenderSpread can play the
  // page-flip animation. Same-spread or jump-by-N (e.g. page-jump,
  // TOC) skip the animation by passing null.
  const dir = targetSpread > _bookViewCurrentSpread ? "forward"
    : targetSpread < _bookViewCurrentSpread ? "backward"
    : null;
  // Only animate single-step transitions; multi-spread jumps (TOC,
  // page-jump, return-to-current) would look weird with a flip.
  const animate = dir !== null && Math.abs(targetSpread - _bookViewCurrentSpread) === 1;
  _bookViewRenderSpread(targetSpread, animate ? dir : null);
}

// v208 (M6.2): click the spread indicator to enter page-jump mode.
// Indicator's textContent is replaced with a number input; Enter
// commits, Esc / blur cancels. Guards against _bookViewUpdateNav
// overwriting the input mid-edit via _bookViewIndicatorEditing.
// v209 (M6.4): touch swipe for spread navigation. Pointer Events
// captures horizontal swipes on the spread element. Swipes that
// start on an interactive child (sentence span, image, button)
// don't trigger — that preserves click-to-seek and text selection.
// Distance threshold 80px keeps accidental drags from paging.
// Time threshold 800ms keeps slow scroll-and-rest from triggering.
function _bookViewWireSwipe() {
  if (!bookViewSpread) return;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let tracking = false;
  bookViewSpread.addEventListener("pointerdown", (e) => {
    // Don't swallow swipes that begin on interactive content. Sentence
    // spans handle click-to-seek; respecting their target lets the
    // existing click logic fire on tap.
    const target = e.target;
    if (
      target.closest("button") ||
      target.closest(".sentence") ||
      target.closest("img")
    ) {
      tracking = false;
      return;
    }
    if (e.pointerType !== "touch") return;  // mouse drag = text selection
    startX = e.clientX;
    startY = e.clientY;
    startTime = Date.now();
    tracking = true;
  });
  bookViewSpread.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const elapsed = Date.now() - startTime;
    if (elapsed > 800) return;  // too slow
    if (Math.abs(dx) < 80) return;  // too short
    if (Math.abs(dy) > Math.abs(dx)) return;  // vertical, not horizontal
    if (dx < 0) {
      // Swipe left → next spread (page advancing direction).
      _bookViewNavigateManual(_bookViewCurrentSpread + 1);
    } else {
      _bookViewNavigateManual(_bookViewCurrentSpread - 1);
    }
  });
  bookViewSpread.addEventListener("pointercancel", () => {
    tracking = false;
  });
}
_bookViewWireSwipe();

function _bookViewBeginPageJump() {
  if (!bookViewIndicator || _bookViewIndicatorEditing) return;
  if (_bookViewSpreadsCount <= 1) return;  // nothing to jump to
  _bookViewIndicatorEditing = true;
  const currentSpread = _bookViewCurrentSpread + 1;
  bookViewIndicator.innerHTML = "";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = String(_bookViewSpreadsCount);
  input.value = String(currentSpread);
  input.className = "book-view-indicator-input";
  input.setAttribute("aria-label", "Spread number");
  bookViewIndicator.appendChild(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    if (!_bookViewIndicatorEditing) return;
    _bookViewIndicatorEditing = false;
    if (commit) {
      const n = parseInt(input.value, 10);
      if (!Number.isNaN(n)) {
        const target = Math.max(1, Math.min(_bookViewSpreadsCount, n)) - 1;
        _bookViewNavigateManual(target);
      }
    }
    _bookViewUpdateNav();  // restore the textContent
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(false));
}

// v208 (M6.3): find within book view. Reads from
// _bookViewSource.sentences; case-insensitive substring match;
// matches stored as sentence indices. Cursor cycles through them
// via prev/next. Jumping to a match scrolls to the spread containing
// that sentence via _bookViewNavigateManual.
function _bookViewOpenFind() {
  if (!bookViewFind || !bookViewFindInput) return;
  if (!_bookViewSource || !_bookViewSource.sentences.length) return;
  bookViewFind.hidden = false;
  bookViewFindInput.focus();
  bookViewFindInput.select();
}
function _bookViewCloseFind() {
  if (!bookViewFind) return;
  bookViewFind.hidden = true;
  if (bookViewFindInput) bookViewFindInput.value = "";
  _bookViewFindMatches = [];
  _bookViewFindCursor = 0;
  _bookViewUpdateFindCount();
}
function _bookViewUpdateFindCount() {
  if (!bookViewFindCount) return;
  const total = _bookViewFindMatches.length;
  const cur = total ? _bookViewFindCursor + 1 : 0;
  bookViewFindCount.textContent = `${cur} / ${total}`;
}
function _bookViewRunFind(query) {
  _bookViewFindMatches = [];
  _bookViewFindCursor = 0;
  if (!query || !_bookViewSource) {
    _bookViewUpdateFindCount();
    return;
  }
  const q = query.toLowerCase();
  const sentences = _bookViewSource.sentences;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].toLowerCase().includes(q)) {
      _bookViewFindMatches.push(i);
    }
  }
  _bookViewUpdateFindCount();
  // Jump to the first match if any.
  if (_bookViewFindMatches.length) {
    _bookViewJumpToFindMatch();
  }
}
function _bookViewJumpToFindMatch() {
  const sIdx = _bookViewFindMatches[_bookViewFindCursor];
  if (sIdx === undefined) return;
  const ppr = _bookViewPagesPerSpread();
  const targetSpread = _bookViewSpreadOfSentence(sIdx, ppr);
  _bookViewNavigateManual(targetSpread);
}
function _bookViewCycleFind(delta) {
  if (!_bookViewFindMatches.length) return;
  _bookViewFindCursor =
    (_bookViewFindCursor + delta + _bookViewFindMatches.length) %
    _bookViewFindMatches.length;
  _bookViewUpdateFindCount();
  _bookViewJumpToFindMatch();
}

// Title-hash → CSS gradient. Same hash → same colors → same swatch
// as the library card, so a chapter's cover page tone matches its
// row in the library list. Kept inline (rather than reused from the
// library helper) so this module stays self-contained.
function _coverFallbackGradient(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const h1 = hash % 360;
  const h2 = (h1 + 35) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 60%, 28%) 0%, hsl(${h2}, 55%, 18%) 100%)`;
}

// Apply the karaoke state to whichever book span matches the given
// sentence index. Cheaper than the reading-view's full forEach since
// only the active sentence changes per frame.
function _bookViewApplyActive(idx) {
  // Clear stale state on the book spans we touched last frame.
  for (const span of _bookSentenceSpans) {
    if (!span) continue;
    span.classList.remove("active");
  }
  // Mark "played" up to the current cursor + "active" on the cursor.
  for (let i = 0; i < _bookSentenceSpans.length; i++) {
    const span = _bookSentenceSpans[i];
    if (!span) continue;
    if (i < idx) span.classList.add("played");
    else span.classList.remove("played");
  }
  const activeSpan = _bookSentenceSpans[idx];
  if (activeSpan) activeSpan.classList.add("active");
}

// Public: enter book view. Reads the stashed _bookViewSource (set by
// enterReadingView). Mid-clip pivots — user can flip back to reading
// view at any time and pick up exactly where they were.
async function enterBookView() {
  if (!_bookViewSource || !_bookViewSource.sentences.length) {
    setStatus("Generate or load a clip first.", true);
    return;
  }
  // Populate title + cover from the currently-loaded clip if we have
  // its id (otherwise leave the fallback gradient + a generic title).
  if (_currentClipId) {
    getClip(_currentClipId).then((clip) => {
      if (!clip) return;
      _bookViewSource.title = clip.title || "Untitled chapter";
      _bookViewSource.cover = clip.cover || null;
      // v210 (M6.1): stash bookmarks on the source so the page
      // renderer can mark bookmarked pages with a ribbon. Bookmarks
      // are time-based (timeSec); the ribbon helper resolves time →
      // sentence_index → page_index via sentenceOffsetsSec +
      // _bookSentenceToPage.
      _bookViewSource.bookmarks = clip.bookmarks || [];
      // v211 (M7.1): stash highlights too. The renderer wraps any
      // highlighted char range in <span class="text-highlight">.
      _bookViewSource.highlights = clip.highlights || [];
      // Re-render so the cover page updates if the user opens the book
      // view before getClip resolves.
      _bookViewRenderSpread(_bookViewCurrentSpread);
    }).catch(() => {});
  } else {
    _bookViewSource.title = "Untitled chapter";
  }
  // v187: opening the book view should always start unpinned —
  // user just toggled in; they want auto-flip until they decide to
  // scrub. Without this, a pinned state from a previous session
  // (after exit→re-enter) would persist and confuse.
  _bookViewUserPaged = false;

  // v206 (M4.1): detect chapter boundaries once per book-view
  // session. Cached on _bookViewSource so theme / font-size changes
  // don't re-run the detector. _bookViewRepaginate reads from the
  // same cache (paginator + renderer both call _bookViewIsChapterStart
  // / _bookViewChapterAt which read _bookViewSource.chapters).
  if (!_bookViewSource.chapters) {
    _bookViewSource.chapters = _bookViewDetectChapters(_bookViewSource.sentences);
  }

  // v200 (M3.2): preload image dimensions + bucket by sentence_index
  // before paginating. Without natural dimensions, an <img> in the
  // measurement probe contributes 0 to scrollHeight until it loads
  // asynchronously, racing the paginator. Cache the bucket + dims on
  // _bookViewSource so _bookViewRepaginate can reuse them when the
  // user changes theme / text-size without re-downloading.
  if (!_bookViewSource.imgByIdx) {
    _bookViewSource.imgByIdx = _bookViewBucketImages(
      _bookViewSource.images,
      _bookViewSource.sentences.length
    );
  }
  if (!_bookViewSource.imgDims) {
    // Show the spread skeleton during preload so the user sees that
    // something's happening (most clips have 0 images and this is
    // instant; URL-fetched chapters can have a dozen).
    bookView.style.visibility = "hidden";
    bookView.hidden = false;
    _bookViewSource.imgDims = await _bookViewPreloadImages(
      _bookViewSource.images || []
    );
  }

  // Pre-measure: temporarily reveal the spread so the page-shaped
  // probe inherits the real CSS metrics. Hidden visibility keeps the
  // user from seeing a flash of un-paginated content.
  bookView.style.visibility = "hidden";
  bookView.hidden = false;
  readingView.hidden = true;
  const spreadRect = bookViewSpread.getBoundingClientRect();
  const ppr = _bookViewPagesPerSpread();
  const pageWidth = ppr === 2 ? spreadRect.width / 2 : spreadRect.width;
  const pageHeight = spreadRect.height;
  _bookViewPages = _bookViewPaginate(
    _bookViewSource.sentences,
    pageWidth,
    pageHeight,
    _bookViewSource.imgByIdx,
    _bookViewSource.imgDims
  );
  _bookSentenceToPage = [];
  for (let p = 0; p < _bookViewPages.length; p++) {
    for (const sIdx of _bookViewPages[p]) {
      _bookSentenceToPage[sIdx] = p;
    }
  }
  // Default to the spread containing the current active sentence so
  // a user mid-listen who toggles into book view lands on the right
  // page. Falls back to spread 0 (cover + first page) otherwise.
  const startSpread = activeSentenceIdx >= 0
    ? _bookViewSpreadOfSentence(activeSentenceIdx, ppr)
    : 0;
  _bookViewRenderSpread(startSpread);
  // v206 (M4.4): the Contents button only shows once we've
  // confirmed chapters exist for THIS clip.
  _bookViewUpdateTocButton();
  bookView.style.visibility = "visible";
  if (bookViewToggle) bookViewToggle.textContent = "▶ Audio view";
}

// v202 (M3.3): build a single page element for the given slot
// (0 = cover, 1+ = text pages). Mirrors the per-page construction
// inside _bookViewRenderSpread but as a standalone function so the
// print path can build all pages at once without depending on the
// spread loop. Duplication is deliberate — the live renderer stays
// untouched.
function _bookViewBuildPageElement(slot) {
  const pageEl = document.createElement("div");
  pageEl.className = "book-page";

  if (slot === 0) {
    // Cover — same as the renderer's cover branch.
    pageEl.classList.add("book-page-cover");
    const src = _bookViewSource;
    if (src && src.cover && src.cover.blob) {
      const img = document.createElement("img");
      img.className = "book-page-cover-art";
      img.alt = src.title || "Cover";
      try {
        img.src = URL.createObjectURL(src.cover.blob);
        img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
      } catch {}
      pageEl.appendChild(img);
    } else {
      const fb = document.createElement("div");
      fb.className = "book-page-cover-fallback";
      const seed = (src && src.title) || "Untitled";
      fb.style.background = _coverFallbackGradient(seed);
      fb.textContent = seed.trim().slice(0, 1).toUpperCase() || "•";
      pageEl.appendChild(fb);
    }
    if (src && src.title) {
      const t = document.createElement("div");
      t.className = "book-page-cover-title";
      t.textContent = src.title;
      pageEl.appendChild(t);
    }
    return pageEl;
  }

  // Text page — mirrors the renderer's text-page branch.
  const textPageIdx = slot - 1;
  const sentenceIdxs = _bookViewPages[textPageIdx] || [];

  const headerTitle = (_bookViewSource && _bookViewSource.title) || "";
  if (headerTitle) {
    const header = document.createElement("div");
    header.className = "book-page-header";
    header.textContent = headerTitle;
    pageEl.appendChild(header);
  }

  const body = document.createElement("div");
  body.className = "book-page-body";
  if (textPageIdx === 0) {
    body.dataset.dropCap = "true";
  }

  const imgByIdx = (_bookViewSource && _bookViewSource.imgByIdx) || null;
  for (const sIdx of sentenceIdxs) {
    if (imgByIdx && imgByIdx.has(sIdx)) {
      for (const img of imgByIdx.get(sIdx)) {
        const el = document.createElement("img");
        el.className = "book-inline-image";
        el.src = img.src;
        el.alt = img.alt || "";
        el.loading = "lazy";
        el.decoding = "async";
        el.addEventListener("error", () => el.remove(), { once: true });
        body.appendChild(el);
      }
    }
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.index = String(sIdx);
    const wc = _countWords(_bookViewSource.sentences[sIdx]);
    if (wc >= LONG_SENTENCE_WORD_THRESHOLD) {
      span.dataset.longSentence = "true";
      span.dataset.wordCount = String(wc);
      span.title = `${wc} words`;
    }
    span.textContent = _bookViewSource.sentences[sIdx] + " ";
    span.addEventListener("click", () => {
      _bookViewUserPaged = false;
      seekToSentence(sIdx);
      if (playerEl.paused) playerEl.play().catch(() => {});
    });
    body.appendChild(span);
    _bookSentenceSpans[sIdx] = span;
  }
  const totalTextPages = _bookViewPages.length;
  if (textPageIdx === totalTextPages - 1 && imgByIdx) {
    const trailing = imgByIdx.get(_bookViewSource.sentences.length) || [];
    for (const img of trailing) {
      const el = document.createElement("img");
      el.className = "book-inline-image";
      el.src = img.src;
      el.alt = img.alt || "";
      el.loading = "lazy";
      el.decoding = "async";
      el.addEventListener("error", () => el.remove(), { once: true });
      body.appendChild(el);
    }
  }
  pageEl.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "book-page-footer";
  footer.textContent = String(textPageIdx + 1);
  pageEl.appendChild(footer);

  return pageEl;
}

// v202 (M3.3): print the entire book. Rebuilds the spread DOM with
// every page laid out flat, sets body[data-book-printing] so the
// @media print rules + the screen rule that moves the book offscreen
// can take over, fires window.print(). Restores the single-spread
// rendering on the afterprint event so the user lands back where
// they were when they came back from the print dialog.
function _bookViewPrintBook() {
  if (!_bookViewSource || !_bookViewSource.sentences.length) {
    setStatus("Load a clip first.", true);
    return;
  }
  if (!_bookViewPages.length) {
    setStatus("Open the book view first to paginate.", true);
    return;
  }
  const savedSpread = _bookViewCurrentSpread;

  // Switch CSS into "print prep" mode BEFORE rebuilding the DOM —
  // otherwise the user would briefly see the all-pages layout
  // crammed into the 2-column spread grid. The screen-mode CSS
  // rule on body[data-book-printing] positions the book view
  // off-screen so the rebuild is invisible.
  document.body.dataset.bookPrinting = "true";

  // Build all pages flat into bookViewSpread.
  bookViewSpread.innerHTML = "";
  _bookSentenceSpans = [];
  const totalSlots = 1 + _bookViewPages.length;  // cover + text pages
  for (let slot = 0; slot < totalSlots; slot++) {
    const pageEl = _bookViewBuildPageElement(slot);
    bookViewSpread.appendChild(pageEl);
  }

  // Restore on afterprint. Browsers fire this whether the user
  // confirms printing or cancels the dialog.
  const cleanup = () => {
    window.removeEventListener("afterprint", cleanup);
    delete document.body.dataset.bookPrinting;
    // Re-render the spread the user was on. This re-populates
    // _bookSentenceSpans correctly so click-to-seek + karaoke
    // resume working on the right nodes.
    _bookViewRenderSpread(savedSpread);
  };
  window.addEventListener("afterprint", cleanup);

  // requestAnimationFrame so the DOM rebuild commits before the
  // print dialog opens (some browsers snapshot at print() call time).
  requestAnimationFrame(() => {
    window.print();
  });
}

// v206 (M4.4): open the table-of-contents dialog. Populates the list
// from _bookViewSource.chapters (computed in enterBookView) with
// per-chapter page numbers looked up via _bookSentenceToPage. Each
// row jumps via _bookViewNavigateManual so the pinned-scrub flag
// behaves like a user-initiated paging action.
function _bookViewOpenToc() {
  if (!bookViewTocDialog || !bookViewTocList) return;
  if (!_bookViewSource || !_bookViewSource.chapters) return;
  const chapters = _bookViewSource.chapters;
  bookViewTocList.innerHTML = "";
  if (!chapters.length) {
    const li = document.createElement("li");
    li.className = "book-view-toc-empty";
    li.textContent = "No chapters detected in this clip.";
    bookViewTocList.appendChild(li);
  } else {
    const ppr = _bookViewPagesPerSpread();
    for (const ch of chapters) {
      const li = document.createElement("li");
      li.className = "book-view-toc-row";
      const titleEl = document.createElement("span");
      titleEl.className = "book-view-toc-title";
      titleEl.textContent = ch.title;
      const pageEl = document.createElement("span");
      pageEl.className = "book-view-toc-page";
      const pageIdx = _bookSentenceToPage[ch.sentence_index];
      pageEl.textContent = (pageIdx !== undefined) ? String(pageIdx + 1) : "—";
      li.appendChild(titleEl);
      li.appendChild(pageEl);
      li.addEventListener("click", () => {
        const targetSpread = _bookViewSpreadOfSentence(ch.sentence_index, ppr);
        _bookViewNavigateManual(targetSpread);
        bookViewTocDialog.close();
      });
      bookViewTocList.appendChild(li);
    }
  }
  try { bookViewTocDialog.showModal(); }
  catch { bookViewTocDialog.show && bookViewTocDialog.show(); }
}

// v206 (M4.4): show/hide the Contents button based on whether the
// current clip has detected chapters. Called from enterBookView after
// chapter detection runs and from exitBookView to reset.
function _bookViewUpdateTocButton() {
  if (!bookViewTocBtn) return;
  const has =
    !!(_bookViewSource && _bookViewSource.chapters && _bookViewSource.chapters.length > 0);
  bookViewTocBtn.hidden = !has;
}

function _bookViewSpreadOfSentence(sIdx, ppr) {
  const pageIdx = _bookSentenceToPage[sIdx];
  if (pageIdx === undefined) return 0;
  // Slot 0 is cover; slot N>=1 is text page N-1. Spread = floor(slot/ppr).
  const slot = pageIdx + 1;
  return Math.floor(slot / ppr);
}

// v197 (M2): re-paginate the current source and re-render. Called
// when the user changes Book View text size in Settings, so the
// page break points and the current spread both shift to match
// the new font. Anchors the post-repagination spread on whichever
// sentence was at the top of the visible spread before the change —
// otherwise jumping from S → L size could land the user dozens of
// pages off because the same spread index now points at different
// content.
function _bookViewRepaginate() {
  if (!bookView || bookView.hidden) return;
  if (!_bookViewSource || !_bookViewSource.sentences.length) return;
  // Remember a sentence from the visible spread so we can return to
  // it. Use the active (audio-playing) sentence if it's on this
  // spread; otherwise the first sentence of the current spread.
  const ppr = _bookViewPagesPerSpread();
  let anchor = -1;
  if (
    activeSentenceIdx >= 0 &&
    _bookViewSpreadOfSentence(activeSentenceIdx, ppr) === _bookViewCurrentSpread
  ) {
    anchor = activeSentenceIdx;
  } else {
    const firstSlot = _bookViewCurrentSpread * ppr;
    const firstTextPage = firstSlot === 0 ? 0 : firstSlot - 1;
    const firstPageSentences = _bookViewPages[firstTextPage] || [];
    if (firstPageSentences.length) anchor = firstPageSentences[0];
  }
  // Re-measure and re-paginate.
  const spreadRect = bookViewSpread.getBoundingClientRect();
  const pageWidth = ppr === 2 ? spreadRect.width / 2 : spreadRect.width;
  const pageHeight = spreadRect.height;
  _bookViewPages = _bookViewPaginate(
    _bookViewSource.sentences,
    pageWidth,
    pageHeight,
    // v200 (M3.2): reuse the cached image bucket + dims so theme /
    // font-size changes don't re-trigger image downloads.
    _bookViewSource && _bookViewSource.imgByIdx,
    _bookViewSource && _bookViewSource.imgDims
  );
  _bookSentenceToPage = [];
  for (let p = 0; p < _bookViewPages.length; p++) {
    for (const sIdx of _bookViewPages[p]) {
      _bookSentenceToPage[sIdx] = p;
    }
  }
  const targetSpread = anchor >= 0
    ? _bookViewSpreadOfSentence(anchor, ppr)
    : _bookViewCurrentSpread;
  _bookViewRenderSpread(targetSpread);
}

// v197 (M2): user-selectable book font size. Persists to localStorage
// and applies to .book-view via a CSS custom property. Re-paginates
// the current book view on the fly when the user changes the size.
const BOOK_FONT_SIZE_KEY = "bookFontSize";
const BOOK_FONT_SIZES = {
  small: "14px",
  medium: "16px",
  large: "18px",
  xlarge: "20px",
};
function _loadBookFontSize() {
  const v = localStorage.getItem(BOOK_FONT_SIZE_KEY);
  return BOOK_FONT_SIZES[v] ? v : "medium";
}
function _applyBookFontSize(size) {
  const px = BOOK_FONT_SIZES[size] || BOOK_FONT_SIZES.medium;
  if (bookView) bookView.style.setProperty("--book-font-size", px);
}
// Apply on initial load so the CSS var is set before the user
// opens book view (pagination uses the var, so it must be set first).
_applyBookFontSize(_loadBookFontSize());

// v199 (M3.1): book-view theme variant. Independent of the app-wide
// Dark/Light/Auto theme — this picks the typographic personality of
// the book pages (paperback / magazine / manuscript). CSS lives on
// data-book-theme attribute on .book-view, which the paginator probe
// also receives (set explicitly in _bookViewPaginate). On change we
// re-paginate because font-family + line-height shifts move the
// per-page break points.
const BOOK_THEME_KEY = "bookTheme";
const BOOK_THEMES = new Set(["paperback", "magazine", "manuscript"]);
function _loadBookTheme() {
  const v = localStorage.getItem(BOOK_THEME_KEY);
  return BOOK_THEMES.has(v) ? v : "paperback";
}
function _applyBookTheme(theme) {
  const t = BOOK_THEMES.has(theme) ? theme : "paperback";
  if (bookView) bookView.dataset.bookTheme = t;
}
_applyBookTheme(_loadBookTheme());

// Public: leave book view. Either back to reading view (default) or
// onward to the textarea (when called from exitReadingView itself).
function exitBookView(opts = {}) {
  bookView.hidden = true;
  bookView.style.visibility = "";
  _bookSentenceSpans = [];
  if (bookViewSpread) bookViewSpread.innerHTML = "";
  if (bookViewToggle) bookViewToggle.textContent = "📖 Book view";
  // v206 (M4.4): hide Contents until the next book view open.
  if (bookViewTocBtn) bookViewTocBtn.hidden = true;
  // v208 (M6.3): close the find bar so re-entering book view starts fresh.
  if (bookViewFind && !bookViewFind.hidden) _bookViewCloseFind();
  if (!opts.skipReadingView) {
    readingView.hidden = false;
  }
}

if (bookViewToggle) {
  bookViewToggle.addEventListener("click", () => {
    if (bookView.hidden) enterBookView();
    else exitBookView();
  });
}
// v202 (M3.3): print button. Direct call; the function handles
// the no-paginated-pages edge case via setStatus.
if (bookViewPrintBtn) {
  bookViewPrintBtn.addEventListener("click", () => _bookViewPrintBook());
}
// v206 (M4.4): table of contents button + dialog close.
if (bookViewTocBtn) {
  bookViewTocBtn.addEventListener("click", () => _bookViewOpenToc());
}
if (bookViewTocClose && bookViewTocDialog) {
  bookViewTocClose.addEventListener("click", () => bookViewTocDialog.close());
}
// v208 (M6.2): indicator click → page-jump.
if (bookViewIndicator) {
  bookViewIndicator.addEventListener("click", () => _bookViewBeginPageJump());
}
// v208 (M6.3): find input wiring + close/prev/next + Ctrl+F.
if (bookViewFindInput) {
  bookViewFindInput.addEventListener("input", () =>
    _bookViewRunFind(bookViewFindInput.value)
  );
  bookViewFindInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      _bookViewCycleFind(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      _bookViewCloseFind();
    }
  });
}
if (bookViewFindPrev) {
  bookViewFindPrev.addEventListener("click", () => _bookViewCycleFind(-1));
}
if (bookViewFindNext) {
  bookViewFindNext.addEventListener("click", () => _bookViewCycleFind(1));
}
if (bookViewFindClose) {
  bookViewFindClose.addEventListener("click", () => _bookViewCloseFind());
}
// Ctrl+F / Cmd+F → open the find bar when book view is visible.
// Override the browser's native find since the book view's text is
// already on screen and our match-aware paginator can jump to the
// page containing the hit (browser find can't do that).
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f" && bookView && !bookView.hidden) {
    e.preventDefault();
    _bookViewOpenFind();
  }
});
if (bookViewPrev) {
  bookViewPrev.addEventListener("click", () => {
    // v187: route through _bookViewNavigateManual so the pinned
    // state flips on and the auto-flip stops yanking the spread
    // back to the active sentence the next animation frame.
    _bookViewNavigateManual(_bookViewCurrentSpread - 1);
  });
}
if (bookViewNext) {
  bookViewNext.addEventListener("click", () => {
    _bookViewNavigateManual(_bookViewCurrentSpread + 1);
  });
}
// v187: "Return to current" — un-pins + flips to the spread holding
// the audio's currently-narrated sentence. Hidden by default; the
// nav-update path reveals it when the user has scrubbed away.
if (bookViewReturn) {
  bookViewReturn.addEventListener("click", () => {
    if (activeSentenceIdx < 0) return;
    const ppr = _bookViewPagesPerSpread();
    const target = _bookViewSpreadOfSentence(activeSentenceIdx, ppr);
    _bookViewUserPaged = false;
    _bookViewRenderSpread(target);
  });
}
// Keyboard nav — ← / → only when book view is the active surface.
// Guard against clobbering arrow-key seeking in the main audio
// player by checking the focused element.
document.addEventListener("keydown", (e) => {
  if (!bookView || bookView.hidden) return;
  const focused = document.activeElement;
  if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    _bookViewNavigateManual(_bookViewCurrentSpread - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    _bookViewNavigateManual(_bookViewCurrentSpread + 1);
  }
});
// Touch swipe — horizontal-only, with a generous threshold so the
// user can scroll the page vertically without accidentally paging.
let _bookSwipeStart = null;
if (bookViewSpread) {
  bookViewSpread.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    _bookSwipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  bookViewSpread.addEventListener("touchend", (e) => {
    if (!_bookSwipeStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - _bookSwipeStart.x;
    const dy = t.clientY - _bookSwipeStart.y;
    _bookSwipeStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0) {
      _bookViewNavigateManual(_bookViewCurrentSpread + 1);
    } else if (dx > 0) {
      _bookViewNavigateManual(_bookViewCurrentSpread - 1);
    }
  }, { passive: true });
}

// ---- Library (IndexedDB) -------------------------------------------------
// Every generated clip is persisted so it can be replayed without paying the
// synthesis cost again. Clips are stored as their original WAV blob plus the
// metadata needed to restore the reading view and sentence-skip behavior.

// Keep the legacy DB name even after the app was renamed to Narrative — IndexedDB
// is keyed on this string, and changing it would orphan any clips users already saved.
const DB_NAME = "audiable";
const DB_VERSION = 1;
const STORE = "clips";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function saveClip(clip) {
  const db = await openDB();
  return idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(clip));
}

async function listClips() {
  const db = await openDB();
  const all = await idbReq(
    db.transaction(STORE, "readonly").objectStore(STORE).getAll()
  );
  return all.sort((a, b) => b.id - a.id);
}

async function getClip(id) {
  const db = await openDB();
  return idbReq(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}

async function deleteClipById(id) {
  const db = await openDB();
  return idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
}

async function clearLibrary() {
  const db = await openDB();
  return idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
}

function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return "0:00";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClipMeta(clip) {
  const parts = [];
  // v220p: voice name moved out of the meta line into the title row,
  // where it has horizontal room to display without truncating to "A.".
  // See makeClipCard's titleTop construction. The meta line now just
  // carries word-count / duration / date.
  const wordCount = _countWords(clip.text);
  if (wordCount > 0) parts.push(`${wordCount.toLocaleString()}w`);
  // Show resume position if there's a meaningful in-progress checkpoint,
  // otherwise just show the duration.
  if (clip.durationSec) {
    const progress = Number(clip.progressSec) || 0;
    if (progress > 1 && progress < clip.durationSec - 1) {
      parts.push(`${formatTime(progress)} / ${formatTime(clip.durationSec)}`);
    } else {
      parts.push(formatTime(clip.durationSec));
    }
  }
  if (clip.createdAt) {
    const d = new Date(clip.createdAt);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    parts.push(
      sameDay
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString()
    );
  }
  return parts.join(" · ");
}

// ---- Library order, search, auto-advance --------------------------------
// _playMode controls BOTH the on-screen sort and the auto-advance order so
// "what plays next" matches "what you see next" — except for shuffle, which
// keeps the newest-first display but randomizes auto-advance.
//
// listClips() returns newest-first (id descending), so "newest" needs no
// extra work; sortClips() handles the others.
const PLAY_MODES = ["newest", "oldest", "longest", "shortest", "custom", "shuffle"];
const PLAY_MODE_LABELS = {
  newest: "Newest first",
  oldest: "Oldest first",
  longest: "Longest first",
  shortest: "Shortest first",
  custom: "Custom order",
  shuffle: "Shuffle",
};
const PLAY_MODE_KEY = "narrative.playMode";
const LIBRARY_ORDER_KEY = "narrative.libraryOrder";

function _loadLibraryOrder() {
  try {
    const raw = localStorage.getItem(LIBRARY_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function _saveLibraryOrder(ids) {
  try {
    localStorage.setItem(LIBRARY_ORDER_KEY, JSON.stringify(ids));
  } catch {}
}

let _playMode = PLAY_MODES.includes(localStorage.getItem(PLAY_MODE_KEY))
  ? localStorage.getItem(PLAY_MODE_KEY)
  : "newest";

// Search query is session-scoped (re-typing on reload is fine; remembering
// a stale filter past a refresh is annoying).
let _librarySearch = "";

function sortClips(clips, mode) {
  if (mode === "oldest") return [...clips].reverse();
  if (mode === "longest") {
    return [...clips].sort(
      (a, b) => (b.durationSec || 0) - (a.durationSec || 0)
    );
  }
  if (mode === "shortest") {
    return [...clips].sort(
      (a, b) => (a.durationSec || 0) - (b.durationSec || 0)
    );
  }
  if (mode === "custom") {
    // Honor the user-drag-defined order from localStorage. Clips not in
    // the order list (e.g. freshly generated after the last reorder) fall
    // through to newest-first behind whatever's been explicitly placed.
    const order = _loadLibraryOrder();
    const orderIdx = new Map(order.map((id, i) => [id, i]));
    return [...clips].sort((a, b) => {
      const ai = orderIdx.has(a.id) ? orderIdx.get(a.id) : Infinity;
      const bi = orderIdx.has(b.id) ? orderIdx.get(b.id) : Infinity;
      if (ai !== bi) return ai - bi;
      // Tie-breaker for unsorted clips: newest first.
      return b.id - a.id;
    });
  }
  // newest, shuffle → leave at listClips() default (newest-first)
  return clips;
}

function updatePlayModeBtn() {
  playModeBtn.textContent = PLAY_MODE_LABELS[_playMode];
}

playModeBtn.addEventListener("click", () => {
  const i = PLAY_MODES.indexOf(_playMode);
  _playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length];
  try { localStorage.setItem(PLAY_MODE_KEY, _playMode); } catch {}
  updatePlayModeBtn();
  // Re-render the library so the new sort applies immediately.
  renderLibrary();
  // v166: first-tap hint — the sort chip cycles through six modes
  // (Newest / Oldest / Longest / Shortest / Custom / Shuffle) but a
  // first-time tester sees the label change once and has no signal
  // that more taps keep cycling. Matches the v150 hint pattern.
  if (typeof _fireChipHint === "function") {
    _fireChipHint(
      "narrative.hintSeen.playMode",
      "💡 Tap the sort chip again to cycle: Newest · Oldest · Longest · Shortest · Custom · Shuffle.",
    );
  }
});

updatePlayModeBtn();

librarySearch.addEventListener("input", () => {
  _librarySearch = librarySearch.value;
  renderLibrary();
});

librarySearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    librarySearch.value = "";
    _librarySearch = "";
    renderLibrary();
    librarySearch.blur();
  }
});

// "Hide played" filter — toggles whether clips with a playedAt stamp are
// rendered. Persisted across reloads so the preference sticks.
const HIDE_PLAYED_KEY = "narrative.hidePlayed";
let _hidePlayed = (() => {
  try { return localStorage.getItem(HIDE_PLAYED_KEY) === "true"; }
  catch { return false; }
})();

function _updateHidePlayedBtn() {
  libraryHidePlayedBtn.textContent = _hidePlayed ? "Show all" : "Hide played";
  libraryHidePlayedBtn.setAttribute("aria-pressed", String(_hidePlayed));
}
_updateHidePlayedBtn();

libraryHidePlayedBtn.addEventListener("click", () => {
  _hidePlayed = !_hidePlayed;
  try { localStorage.setItem(HIDE_PLAYED_KEY, _hidePlayed ? "true" : "false"); }
  catch {}
  _updateHidePlayedBtn();
  renderLibrary();
  // v166: first-tap status confirms which state we just flipped into,
  // so a tester who can't tell whether they're now hiding or showing
  // gets an unambiguous signal once. CSS aria-pressed styling carries
  // the state visually after that.
  if (typeof _fireChipHint === "function") {
    _fireChipHint(
      "narrative.hintSeen.hidePlayed",
      _hidePlayed
        ? "💡 Played clips are now hidden — the button reads 'Show all' while filtered."
        : "💡 Showing every clip again. Tap 'Hide played' to filter finished ones out.",
    );
  }
});

// "Sync GitHub" — batch-check every git-sourced clip in the library
// against current GitHub SHAs. Groups by repoUrl+branch so a 35-chapter
// queue from one repo is one API call, not 35. Updates _outdatedClipIds
// then re-renders the library so cards flag themselves.
async function syncAllFromGithub() {
  const token = getGithubToken();
  if (!token) {
    setStatus("Set a GitHub PAT in Settings before syncing.", true);
    return;
  }
  const allClips = await listClips();
  const gitClips = allClips.filter((c) => c.gitRef && c.gitRef.repoUrl && c.gitRef.path);
  if (gitClips.length === 0) {
    setStatus("No GitHub-sourced clips in the library.");
    return;
  }
  // Group clips by repoUrl+branch so one tree call covers many clips.
  const groups = new Map(); // key = "url::branch" → {repoUrl, branch, clips: [{id, path, sha}]}
  for (const clip of gitClips) {
    const key = `${clip.gitRef.repoUrl}::${clip.gitRef.branch || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        repoUrl: clip.gitRef.repoUrl,
        branch: clip.gitRef.branch || null,
        clips: [],
      });
    }
    groups.get(key).clips.push({
      id: clip.id,
      path: clip.gitRef.path,
      sha: clip.gitRef.sha,
    });
  }
  librarySyncGithubBtn.disabled = true;
  const originalLabel = librarySyncGithubBtn.textContent;
  librarySyncGithubBtn.textContent = "Syncing…";
  setStatus(
    `Syncing ${gitClips.length} clip${gitClips.length === 1 ? "" : "s"} across ${groups.size} repo${groups.size === 1 ? "" : "s"}…`
  );
  try {
    const items = Array.from(groups.values()).map((g) => ({
      repoUrl: g.repoUrl,
      branch: g.branch,
      paths: Array.from(new Set(g.clips.map((c) => c.path))),
    }));
    const res = await fetch("/api/github/sync-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ github_token: token, items }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    // Walk results and flag outdated clip ids.
    const newOutdated = new Set();
    let errors = 0;
    for (const result of data.results || []) {
      if (result.error) {
        errors++;
        continue;
      }
      const key = `${result.repoUrl}::${result.branch || ""}`;
      const group = groups.get(key) || groups.get(`${result.repoUrl}::`);
      if (!group) continue;
      for (const c of group.clips) {
        const currentSha = (result.shas || {})[c.path] || "";
        if (currentSha && currentSha !== c.sha) {
          newOutdated.add(c.id);
        }
      }
    }
    _outdatedClipIds = newOutdated;
    renderLibrary();
    const outdatedCount = newOutdated.size;
    const summary = outdatedCount === 0
      ? `All ${gitClips.length} clip${gitClips.length === 1 ? "" : "s"} up to date.`
      : `${outdatedCount} of ${gitClips.length} clip${gitClips.length === 1 ? "" : "s"} have newer commits on GitHub.`;
    setStatus(errors ? `${summary} (${errors} repo${errors === 1 ? "" : "s"} failed)` : summary);
  } catch (err) {
    setStatus(`Sync failed: ${err.message}`, true);
  } finally {
    librarySyncGithubBtn.disabled = false;
    librarySyncGithubBtn.textContent = originalLabel;
  }
}

librarySyncGithubBtn.addEventListener("click", syncAllFromGithub);

// v176: companion to Sync all. The Sync flow populates
// _outdatedClipIds with library clips whose upstream SHA has moved.
// This handler closes the loop by refetching each outdated clip and
// dropping it into the background queue with targetClipId set, so
// _preSynthesizeChapter overwrites the existing clip rather than
// minting a new one. Title, notes, bookmarks, cover, tags all
// survive (see saveClip block in _preSynthesizeChapter).
async function renarrateAllOutdated() {
  if (!_outdatedClipIds || _outdatedClipIds.size === 0) return;
  const token = getGithubToken();
  if (!token) {
    setStatus("Set a GitHub PAT in Settings before re-narrating.", true);
    return;
  }
  if (!voiceEl.value) {
    setStatus("Pick a voice before re-narrating.", true);
    return;
  }
  // Snapshot so the iteration is stable even if the worker drops
  // entries from the set as each re-narrate lands.
  const ids = Array.from(_outdatedClipIds);
  libraryRenarrateOutdatedBtn.disabled = true;
  const originalLabel = libraryRenarrateOutdatedBtn.textContent;
  libraryRenarrateOutdatedBtn.textContent = "Refetching…";
  let enqueued = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    setStatus(`Refetching ${i + 1}/${ids.length} outdated clips…`);
    try {
      const clip = await getClip(id);
      if (!clip || !clip.gitRef || !clip.gitRef.repoUrl || !clip.gitRef.path) {
        failed++;
        continue;
      }
      const { repoUrl, branch, path } = clip.gitRef;
      const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!m) { failed++; continue; }
      const owner = m[1];
      const repo = m[2];
      const rawUrl =
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch || "main"}/${encodeURI(path)}`;
      const res = await fetch("/api/extract/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: rawUrl,
          github_token: token || undefined,
          // No git_sha here — we WANT the latest, not a pinned version.
        }),
      });
      if (!res.ok) { failed++; continue; }
      const data = await res.json();
      // Drop it into the background queue. _bgRunWorker will pick it
      // up, _preSynthesizeChapter will overwrite the existing clip
      // because targetClipId is set.
      _enqueueBg([{
        title: clip.title,
        text: (data.text || "").trim(),
        targetClipId: clip.id,
        gitRef: data.gitRef || clip.gitRef,
      }]);
      enqueued++;
    } catch (err) {
      console.warn("[renarrate] failed for clip", id, err);
      failed++;
    }
  }
  libraryRenarrateOutdatedBtn.disabled = false;
  libraryRenarrateOutdatedBtn.textContent = originalLabel;
  const tail = failed
    ? ` (${failed} couldn't be refetched)`
    : "";
  if (enqueued === 0) {
    setStatus(`No clips could be refetched.${tail}`, true);
  } else {
    setStatus(
      `Queued ${enqueued} re-narrate${enqueued === 1 ? "" : "s"} — watch the queue panel for progress.${tail}`
    );
  }
}
if (libraryRenarrateOutdatedBtn) {
  libraryRenarrateOutdatedBtn.addEventListener("click", renarrateAllOutdated);
}

// Returns the id of the clip that should play after `fromId` ends, or null
// if we're at the end of the queue (or shuffle has no other clips). Walks
// the same sort order the user sees in the library.
async function nextClipId(fromId) {
  let clips;
  try {
    clips = await listClips();
  } catch {
    return null;
  }
  if (!clips.length) return null;

  if (_playMode === "shuffle") {
    const others = clips.filter((c) => c.id !== fromId);
    if (!others.length) return null;
    return others[Math.floor(Math.random() * others.length)].id;
  }

  const ordered = sortClips(clips, _playMode);
  const idx = ordered.findIndex((c) => c.id === fromId);
  if (idx < 0 || idx + 1 >= ordered.length) return null;
  return ordered[idx + 1].id;
}

// A clip is "in progress" when its saved resume position is past the very
// first second AND not basically at the end. Matches the same threshold
// formatClipMeta uses to decide whether to render the "1:23 / 5:00" string.
function isClipInProgress(clip) {
  const p = Number(clip.progressSec) || 0;
  const d = Number(clip.durationSec) || 0;
  return p > 1 && p < d - 1;
}

// ---- Cover swatch helpers ----------------------------------------------
// Deterministic visual identity for clip cards. djb2-hash the title to
// two HSL hues, then build a 135° gradient between them. The first
// letter (or 1-2 characters) sits on top in semi-transparent white.
// Same title → same swatch on every render and every device, which
// makes the library scannable even with a hundred entries.

function _djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return h >>> 0;
}

function _clipSwatchGradient(title) {
  const t = (title || "untitled").trim() || "untitled";
  const h = _djb2Hash(t);
  // Two hues 30-90° apart for visible-but-harmonious gradients.
  const hue1 = h % 360;
  const hue2 = (hue1 + 30 + (Math.floor(h / 360) % 60)) % 360;
  return `linear-gradient(135deg, hsl(${hue1} 55% 45%), hsl(${hue2} 60% 35%))`;
}

// Accent color for the card's Libby-style background tint. Prefers the
// dominant color extracted from an uploaded cover; falls back to a
// title-hash-derived HSL so even un-covered clips have a per-title
// identity color. Returns {h, s, l} in HSL (h: 0-360, s/l: 0-100).
function _clipAccentColor(clip) {
  if (clip && clip.cover && clip.cover.color) return clip.cover.color;
  const h = _djb2Hash(((clip && clip.title) || "untitled").trim() || "untitled");
  return { h: h % 360, s: 55, l: 45 };
}

function _clipSwatchInitial(title) {
  const t = (title || "").trim();
  if (!t) return "·";
  // Use the first 1-2 letters of the first word, skipping leading
  // chapter-numbering noise like "01 - " or "Chapter 1: ".
  const cleaned = t
    .replace(/^chapter\s+\w+[:.\s-]*/i, "")
    .replace(/^\d+\s*[-—.]\s*/, "")
    .trim();
  const ch = (cleaned || t).match(/\p{L}/u);
  return ch ? ch[0].toUpperCase() : t[0].toUpperCase();
}

function makeClipCard(clip) {
  const item = document.createElement("div");
  const isSelected = _librarySelectedIds.has(clip.id);
  const isOutdated = _outdatedClipIds.has(clip.id);
  item.className =
    "clip" +
    (clip.id === _currentClipId ? " current" : "") +
    (_libraryMultiSelect && isSelected ? " selected" : "") +
    (isOutdated ? " outdated" : "");
  // Stamp the clip id onto the DOM node so the drag-commit pass can read
  // the visual order without looking anything up.
  item.dataset.clipId = String(clip.id);
  // Libby-style per-card accent (v125). Derived from the uploaded
  // cover's dominant color, or the title-hash if no cover. Two CSS
  // custom properties: --clip-accent (solid for borders if needed)
  // and --clip-accent-tint (10% alpha for the soft background wash).
  const accent = _clipAccentColor(clip);
  item.style.setProperty(
    "--clip-accent",
    `hsl(${accent.h} ${accent.s}% ${accent.l}%)`
  );
  item.style.setProperty(
    "--clip-accent-tint",
    `hsl(${accent.h} ${accent.s}% ${accent.l}% / 0.12)`
  );

  // In select mode the drag-handle slot is repurposed for a checkbox.
  // Reorder doesn't make sense during a selection pass — the user is
  // either committing to delete / export or cancelling out.
  let leftCell;
  if (_libraryMultiSelect) {
    leftCell = document.createElement("div");
    leftCell.className = "clip-select-checkbox";
    leftCell.textContent = isSelected ? "☑" : "☐";
    leftCell.setAttribute(
      "aria-label",
      isSelected ? "Deselect this clip" : "Select this clip"
    );
    // No listener here — the whole card toggles selection (see below).
  } else {
    leftCell = document.createElement("div");
    // Drag-to-reorder is a power-user feature; hide the grip in Simple
    // mode so casual readers don't see clutter for an interaction they
    // wouldn't use. The drag handler is wired anyway — harmless on a
    // hidden element.
    leftCell.className = "clip-drag advanced-only";
    leftCell.setAttribute("aria-label", "Drag to reorder");
    leftCell.title = "Drag to reorder";
    // Two stacked vertical ellipses render reliably as a "grip" affordance
    // across iOS / Android / Windows fonts.
    leftCell.textContent = "⋮⋮";
    _attachDragHandle(leftCell, item);
  }

  const playBtn = document.createElement("button");
  playBtn.className = "clip-play";
  playBtn.type = "button";
  playBtn.setAttribute("aria-label", `Play ${clip.title}`);
  // Show the full title on hover (desktop) / long-press (mobile) for
  // when the clamped 2-line title doesn't show the whole thing.
  if (clip.title) playBtn.title = clip.title;
  // Visual identity swatch — Hoopla-style cover-art tile. If the user
  // uploaded a cover (v125), render that as a background image. Otherwise
  // fall back to the title-hash gradient so every card still has an
  // identity. Object URLs created here are tracked on the card so they
  // can be revoked when the library re-renders (see below).
  const swatch = document.createElement("span");
  swatch.className = "clip-swatch";
  swatch.setAttribute("aria-hidden", "true");
  if (clip.cover && clip.cover.blob) {
    const url = URL.createObjectURL(clip.cover.blob);
    swatch.style.backgroundImage = `url("${url}")`;
    swatch.dataset.coverUrl = url;
    swatch.classList.add("has-cover");
  } else {
    swatch.style.background = _clipSwatchGradient(clip.title || "");
    swatch.textContent = _clipSwatchInitial(clip.title || "");
  }
  const titleStack = document.createElement("span");
  titleStack.className = "clip-title-stack";
  // v220o: title moved to its own row at the top of the card (see
  // _libraryTitleTop below). The inline titleEl that used to live
  // here got crushed to invisible width on cards with the full action
  // strip (↺ + Cover 🔄 ✎ ×) — tester reported "no title visible."
  // titleStack now carries only the note + indicators.
  //
  // v220u: dropped the meta line entirely. Tester reported "2." on
  // a card — that was the start of "2,500w · 18:42 · 5/30" getting
  // CSS-clipped to invisibility by the same narrow-width pressure
  // that killed the title in v220o. The duration moved into the
  // title row (next to voice) where there's actual room; word count
  // + date are gone from the card surface — Edit dialog still has
  // them if anyone wants the detail.
  playBtn.append(swatch, titleStack);
  // If the user added a note, render it as a small italic line below
  // the standard meta. Keeps the card a single tap-target.
  if (clip.note && clip.note.trim()) {
    const noteEl = document.createElement("span");
    noteEl.className = "clip-note";
    noteEl.textContent = clip.note.trim();
    titleStack.appendChild(noteEl);
  }
  // v138 notes indicator. Free-form scratchpad presence — just an
  // icon, no content preview, so the card stays compact and the
  // user opens Notes (Edit dialog or 📝 chip) to read or edit.
  if (clip.notes && clip.notes.trim()) {
    const notesEl = document.createElement("span");
    notesEl.className = "clip-notes-indicator";
    notesEl.title = "This clip has notes attached";
    notesEl.textContent = "📝 Notes";
    titleStack.appendChild(notesEl);
  }
  // Tag chips. Each chip carries the tag-hash color as a left border so
  // the same tag is always the same color across cards. Inside the play
  // button so a single tap still loads the clip (no nested interactives).
  if (Array.isArray(clip.tags) && clip.tags.length > 0) {
    const tagsRow = document.createElement("span");
    tagsRow.className = "clip-tags";
    for (const tag of clip.tags) {
      const chip = document.createElement("span");
      chip.className = "clip-tag";
      chip.textContent = tag;
      chip.style.borderColor = _tagColor(tag);
      tagsRow.appendChild(chip);
    }
    titleStack.appendChild(tagsRow);
  }
  // In select mode, tapping the card toggles selection — playing a clip
  // mid-bulk-action would be confusing.
  playBtn.addEventListener("click", () => {
    if (_libraryMultiSelect) {
      if (_librarySelectedIds.has(clip.id)) {
        _librarySelectedIds.delete(clip.id);
      } else {
        _librarySelectedIds.add(clip.id);
      }
      // Disarm the bulk delete confirm whenever the selection changes —
      // otherwise the count under "Tap again to delete N" could be stale.
      _disarmBulkDelete();
      _updateMultiSelectCounts();
      renderLibrary();
    } else {
      loadClip(clip.id);
    }
  });

  // Reset-to-start ↺ — shown only for clips that actually have a resume
  // position to wipe. Reading my book chapters back as I revise: I want
  // to restart from the top after editing the manuscript, not pick up
  // mid-paragraph from the version I heard last.
  const showReset = isClipInProgress(clip);
  let resetBtn = null;
  if (showReset) {
    resetBtn = document.createElement("button");
    resetBtn.className = "clip-reset";
    resetBtn.type = "button";
    resetBtn.setAttribute("aria-label", `Reset ${clip.title} to start`);
    resetBtn.title = "Reset to start";
    // Anticlockwise open circle arrow — the universal "reset" glyph.
    resetBtn.textContent = "↺";
    resetBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await resetClipProgress(clip.id);
    });
  }

  // v220n: Re-narrate chip. One-tap re-render with the voice currently
  // picked in the hero (which may differ from the clip's stored voice —
  // exactly the case after picking a new narrator and wanting to redo
  // old clips). Placed before Edit so it's reachable with thumb on
  // mobile without skipping past delete.
  //
  // v220q: pulses while the regen is in flight so the user knows it's
  // working. State lives in _renarratingClipIds; cleared by the
  // saveClip().then() in generate() when the new audio lands.
  const renarrateBtn = document.createElement("button");
  renarrateBtn.className = "clip-renarrate";
  if (_renarratingClipIds.has(clip.id)) {
    renarrateBtn.classList.add("busy");
  }
  renarrateBtn.type = "button";
  renarrateBtn.setAttribute(
    "aria-label",
    `Re-narrate ${clip.title} with the currently selected voice`
  );
  renarrateBtn.title = _renarratingClipIds.has(clip.id)
    ? "Re-narrating…"
    : "Re-narrate with current voice";
  renarrateBtn.textContent = "🔄";
  renarrateBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _libraryRenarrate(clip.id);
  });

  const editBtn = document.createElement("button");
  editBtn.className = "clip-edit";
  editBtn.type = "button";
  editBtn.setAttribute("aria-label", `Edit ${clip.title}`);
  editBtn.title = "Edit title + note";
  // Pencil glyph (U+270E) — renders consistently on Windows, macOS, iOS, Android.
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openClipEdit(clip.id);
  });

  const delBtn = document.createElement("button");
  delBtn.className = "clip-delete";
  delBtn.type = "button";
  delBtn.setAttribute("aria-label", `Delete ${clip.title}`);
  delBtn.textContent = "×";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deleteClipById(clip.id);
    renderLibrary();
  });

  // v150: "+ Cover" affordance — only rendered for clips that don't
  // have an uploaded cover yet. Cover upload was previously invisible
  // unless the user opened ✎ Edit and scrolled to the right row;
  // testers never knew the feature existed. The button is a quiet
  // dashed-border chip (low chrome) that opens Edit dialog and
  // scrolls the cover picker into view.
  let addCoverBtn = null;
  if (!clip.cover || !clip.cover.blob) {
    addCoverBtn = document.createElement("button");
    addCoverBtn.className = "clip-add-cover";
    addCoverBtn.type = "button";
    addCoverBtn.setAttribute("aria-label", `Add cover image to ${clip.title}`);
    addCoverBtn.title = "Add a cover image";
    addCoverBtn.textContent = "+ Cover";
    addCoverBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClipEdit(clip.id);
      // Let the dialog finish rendering, then nudge the cover picker
      // into view + focus so the user lands exactly at the next step.
      setTimeout(() => {
        const coverPick = document.getElementById("clip-edit-cover-pick");
        if (coverPick) {
          coverPick.scrollIntoView({ behavior: "smooth", block: "center" });
          coverPick.focus();
        }
      }, 120);
    });
  }

  // v220o: title row at top of the card, styled like the + Cover
  // chip (small, semibold, slight tracking, dim color). Clickable —
  // tapping the title loads the clip same as tapping the body.
  // The whole card is now flex-column: title row above, existing
  // body row below.
  //
  // v220p: title row now also carries the clip's voice name on the
  // right. Most useful signal during the narrator-audition cleanup
  // — at a glance you can see which clips were generated with the
  // old voice (Alan / Amy) vs the new one (LibriTTS spkr 7).
  const titleTop = document.createElement("button");
  titleTop.className = "clip-title-top";
  titleTop.type = "button";
  titleTop.setAttribute("aria-label", `Play ${clip.title}`);
  const titleText = document.createElement("span");
  titleText.className = "clip-title-top-text";
  titleText.textContent = clip.title || "(untitled)";
  titleTop.appendChild(titleText);
  // v220u: duration in the title row, just left of the voice. The
  // bottom meta line used to carry word count · duration · date, but
  // the action strip squeezed it to one-character clipping ("2.").
  // Title row has room for the one signal that actually helps the
  // user decide whether to play it now — duration. Resume-position
  // (`1:23 / 5:00`) renders for in-progress clips.
  if (clip.durationSec) {
    const durSpan = document.createElement("span");
    durSpan.className = "clip-title-top-duration";
    const progress = Number(clip.progressSec) || 0;
    if (progress > 1 && progress < clip.durationSec - 1) {
      durSpan.textContent = `${formatTime(progress)} / ${formatTime(clip.durationSec)}`;
    } else {
      durSpan.textContent = formatTime(clip.durationSec);
    }
    titleTop.appendChild(durSpan);
  }
  if (clip.voiceName) {
    const voiceSpan = document.createElement("span");
    voiceSpan.className = "clip-title-top-voice";
    // Short form — just the voice's first name segment, no quality
    // suffix. "Alan · medium" → "Alan", "LibriTTS · high · spkr 7" →
    // "LibriTTS". Speaker id (if any) appears as a trailing decimal.
    const shortVoice = (clip.voiceName.split(" · ")[0] || "").trim();
    const speakerSuffix = (typeof clip.speakerId === "number" && clip.speakerId > 0)
      ? ` #${clip.speakerId}` : "";
    voiceSpan.textContent = shortVoice + speakerSuffix;
    titleTop.appendChild(voiceSpan);
  }
  titleTop.addEventListener("click", (e) => {
    if (_libraryMultiSelect) {
      // Same toggle-selection behavior as tapping the body.
      if (_librarySelectedIds.has(clip.id)) {
        _librarySelectedIds.delete(clip.id);
      } else {
        _librarySelectedIds.add(clip.id);
      }
      _disarmBulkDelete();
      _updateMultiSelectCounts();
      renderLibrary();
    } else {
      loadClip(clip.id);
    }
  });

  // Inner row holds the handle / swatch / meta / actions — was the
  // entire card's children pre-v220o. Wrapping lets the card grow
  // a second row (the title above) without breaking flex layout.
  const row = document.createElement("div");
  row.className = "clip-row";

  // In select mode, hide the per-clip action buttons — bulk delete /
  // export live in the tools row instead. Just checkbox + body.
  if (_libraryMultiSelect) {
    row.append(leftCell, playBtn);
  } else if (resetBtn) {
    const tail = [resetBtn, addCoverBtn, renarrateBtn, editBtn, delBtn].filter(Boolean);
    row.append(leftCell, playBtn, ...tail);
  } else {
    const tail = [addCoverBtn, renarrateBtn, editBtn, delBtn].filter(Boolean);
    row.append(leftCell, playBtn, ...tail);
  }
  item.append(titleTop, row);
  return item;
}

// v220q: clips currently being re-narrated from a library card click.
// makeClipCard reads this set and applies the .busy class to the 🔄
// chip, which pulses via CSS. Cleared from the saveClip().then() path
// in generate() once the new audio lands; safety timeout below clears
// it if something goes wrong silently.
const _renarratingClipIds = new Set();
function _clearRenarrating(clipId) {
  if (!_renarratingClipIds.has(clipId)) return;
  _renarratingClipIds.delete(clipId);
  renderLibrary();
}

// v220n: re-narrate a library clip with the current voice picker state,
// even if it differs from the clip's stored voice. Use case: user picks
// a new narrator (e.g., LibriTTS speaker 7) and wants to redo the
// existing 11 Alan / Amy clips one by one.
//
// loadClip() overwrites the picker with the clip's stored voice, so we
// snapshot the user's preferred voice/speaker BEFORE loading and
// restore it AFTER. Then trigger the existing v200 regen machinery.
//
// v220r: synchronous re-entrancy guard. _synthController isn't set
// until generate() runs — there's a window during `await loadClip`
// where two rapid taps could BOTH proceed and end up calling
// generate() twice (= two SSE streams producing the same audio).
// User reported "double of the new voice + pause stops and goes" —
// classic two-parallel-streams symptom. Use a separate flag set
// synchronously at function entry.
async function _libraryRenarrate(clipId) {
  if (!clipId) return;
  // v220r: synchronous guard — set BEFORE any await.
  if (_libraryRenarrate._inFlight || _synthController) {
    setStatus("Wait for the current synthesis to finish first.", true);
    return;
  }
  _libraryRenarrate._inFlight = true;
  try {
    // v220s: bypass loadClip() entirely. The user reported "clicking
    // re-narrate also starts the reader in the old voice" — that's
    // because loadClip sets playerEl.src = old-clip-blob-url, and on
    // mobile (after the earlier user gesture) the audio element
    // autoplays on src change. Our subsequent pause + .currentTime=0
    // raced against the autoplay and lost.
    //
    // For a library-row re-narrate we don't need the old audio loaded
    // at all — we only need:
    //   - the clip's text (so generate() can synth it)
    //   - _currentClipId pointed at this row
    //   - voice picker already holding the user's preferred voice
    // generate() builds its own reading view + binds the new audio
    // to playerEl when synth completes. The old blob never enters
    // playerEl, so nothing can autoplay it.
    const clip = await getClip(clipId);
    if (!clip || !clip.text) {
      setStatus("Couldn't read that clip's text.", true);
      return;
    }

    // Defensive: pause + clear any audio currently on the player.
    if (!playerEl.paused) _pauseAsUser();
    try {
      playerEl.removeAttribute("src");
      playerEl.load();
    } catch {}

    // Minimal state setup — what loadClip would do, minus the blob
    // binding. _currentClipId is what the regen-save path uses to
    // know which row to overwrite.
    _cancelAutoAdvance();
    clearAbLoop();
    _currentClipId = clipId;

    // Feed the text to the textarea so generate() has something to
    // synth. updateCounts keeps the word-count badge accurate.
    textEl.value = clip.text;
    updateCounts();

    // v220q: mark this clip as in-flight so the chip pulses. Cleared
    // by the saveClip().then() in generate() when the new audio lands,
    // OR by the safety timeout below if something goes wrong silently.
    _renarratingClipIds.add(clipId);
    setTimeout(() => _clearRenarrating(clipId), 5 * 60 * 1000);
    renderLibrary();

    // Hand off to the regen path. generate() reads the picker for
    // voice/speaker/rate/volume + overwrites the targeted clip's blob
    // on completion.
    //
    // v220w: NO auto-resume. Previously `_regenResumeAtSec = 0` told
    // _maybeStartRenarrateResume to start playing from sentence 0 as
    // soon as it was queued, producing stop-and-go playback whenever
    // the player ran ahead of the server. For a library re-narrate
    // the user just wants the clip updated — set resumeAt to null so
    // streaming stays suppressed end-to-end, and set the
    // NoAutoPlay flag so the result handler also skips the auto-play
    // when the combined MP3 lands. User taps the card to play when
    // they want it.
    _regenResumeAtSec = null;
    _regenSuppressStreaming = true;
    _libraryRenarrateNoAutoPlay = true;
    _regenTargetClipId = clipId;
    if (renarrateBanner) renarrateBanner.hidden = true;
    generate();
  } catch (e) {
    console.warn("re-narrate failed:", e);
    setStatus(`Re-narrate failed: ${e.message}`, true);
    _clearRenarrating(clipId);
  } finally {
    _libraryRenarrate._inFlight = false;
  }
}

async function resetClipProgress(id) {
  try {
    const clip = await getClip(id);
    if (!clip) return;
    clip.progressSec = 0;
    // Manual reset means "I want this back in my listening queue" — clear
    // playedAt so the Hide-played filter shows it again.
    clip.playedAt = null;
    await saveClip(clip);
    // If the user is hitting reset on the clip they're currently listening
    // to, rewind the player itself too — otherwise the IndexedDB row says
    // 0 but the audio keeps playing from where it was.
    if (_currentClipId === id) {
      try { playerEl.currentTime = 0; } catch {}
    }
    renderLibrary();
    setStatus(`Reset "${clip.title || "clip"}" to start.`);
  } catch (e) {
    console.warn("reset progress failed:", e);
    setStatus(`Reset failed: ${e.message}`, true);
  }
}

// ---- Drag-to-reorder (Pointer Events) -----------------------------------
// Works for both mouse and touch via the unified Pointer Events API. The
// pointerdown handler captures the pointer so move/up events keep firing
// even if the user drags outside the original handle. On drop, we figure
// out where the card landed by walking its sibling clip cards top-to-
// bottom and looking for the first one whose vertical midpoint is BELOW
// the dragged card's midpoint.

let _dragSession = null; // {cardEl, pointerId, startY}

// v168: first-clip tour banner. Once-per-device, shown above the
// library list as soon as the user has at least one clip on file.
// Connects three discoverability surfaces in a single banner —
// covers (✎ Edit), drag-to-reorder, and the 📝 Notes chip — at the
// moment the user has a clip those features apply to.
const FIRST_CLIP_TOUR_KEY = "narrative.firstClipTourSeen";
// v175: separate flag for the confetti burst so it stays once-only
// even if the tour banner is re-dismissed or cleared. Cleared by the
// Settings "Replay onboarding tips" link (along with the tour flag).
const FIRST_CLIP_CONFETTI_KEY = "narrative.firstClipConfettiSeen";
function _isFirstClipTourSeen() {
  try { return localStorage.getItem(FIRST_CLIP_TOUR_KEY) === "1"; } catch { return false; }
}
function _dismissFirstClipTour() {
  try { localStorage.setItem(FIRST_CLIP_TOUR_KEY, "1"); } catch {}
  const el = document.getElementById("first-clip-tour");
  if (el) el.hidden = true;
}
// v175: track previous clip count across renderLibrary calls so we
// can detect the 0 → ≥1 transition. -1 sentinel = "first call this
// session, no transition info yet" — used to suppress confetti on
// page load with existing clips (returning user shouldn't celebrate
// every reload). Only the genuine 0 → 1 jump fires confetti.
let _lastSeenClipCount = -1;
function _updateFirstClipTour(clipCount) {
  const el = document.getElementById("first-clip-tour");
  if (!el) return;
  el.hidden = _isFirstClipTourSeen() || clipCount <= 0;

  // v175 / v178: confetti burst on the user's first ever clip save.
  // Two gates:
  // 1. Transition gate: prev === 0 AND new >= 1. Page-init calls
  //    arrive with prev === -1 and are ignored regardless of count
  //    (a returning user with 5 clips doesn't re-celebrate). The
  //    only path that satisfies prev === 0 is "user started this
  //    session empty, just saved their first clip."
  // 2. One-shot gate: localStorage flag. Once fired, never again
  //    (unless cleared by Settings → Replay onboarding tips).
  // v178: log every evaluation so a "confetti didn't pop" report has
  // diagnosis-ready entries showing which gate blocked the fire.
  const prev = _lastSeenClipCount;
  _lastSeenClipCount = clipCount;
  let confettiSeen = false;
  try {
    confettiSeen = localStorage.getItem(FIRST_CLIP_CONFETTI_KEY) === "1";
  } catch {}
  const transitionFires = prev === 0 && clipCount >= 1;
  if (transitionFires && !confettiSeen) {
    _dlog("confetti", `FIRE — first clip transition`, {
      prev, clipCount, confettiSeen,
    });
    try { localStorage.setItem(FIRST_CLIP_CONFETTI_KEY, "1"); } catch {}
    _playConfetti();
  } else if (transitionFires && confettiSeen) {
    _dlog("confetti", "skip — transition fires but flag already set", {
      prev, clipCount, flagKey: FIRST_CLIP_CONFETTI_KEY,
    });
  } else if (clipCount >= 1 && !confettiSeen) {
    // Most common "why didn't it pop?" cause: user upgraded to v175
    // with clips already on file, so prev jumps from -1 directly to
    // their existing count and the transition gate is impossible to
    // satisfy. Log it so the debug view surfaces the diagnosis.
    _dlog("confetti", "skip — no 0→≥1 transition (gate blocked)", {
      prev, clipCount, confettiSeen, hint: "use Settings → Replay onboarding tips to test"
    });
  }
}

// v175: lightweight canvas confetti — no dependency, ~140 paper
// rectangles falling from the top with gravity + drag + per-particle
// rotation. Fires once on the 0 → ≥1 clip transition. Respects
// prefers-reduced-motion (skips entirely). High-DPI canvas scaling
// via devicePixelRatio so it's crisp on retina screens. Particles
// auto-clean up after 4.5s — the canvas removes itself when the
// last particle is either offscreen or fully faded.
function _playConfetti() {
  // Accessibility: users who've asked for reduced motion get no
  // surprise animation. The tour banner still appears as their
  // first-clip cue.
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch {}
  // Don't stack bursts — if one is already mid-flight, leave it.
  if (document.getElementById("confetti-canvas")) return;

  const canvas = document.createElement("canvas");
  canvas.id = "confetti-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;" +
    "pointer-events:none;z-index:9999;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Accent-palette-aligned colors. The blue matches the app accent;
  // the other five give the burst variety without going garish.
  const COLORS = ["#6ea8fe", "#ffb86c", "#ff6b6b", "#a78bfa", "#34d399", "#fbbf24"];
  const COUNT = 140;
  const GRAVITY = 0.18;
  const DRAG = 0.003;
  const LIFETIME_MS = 4500;
  const FADE_FRACTION = 0.7; // start fading at 70% of lifetime

  // Spawn from the top — slightly biased toward center so the burst
  // reads as coming from "the page" rather than the edges. vy is
  // gentle (1.5-4.5) so they drift down rather than fall like rocks.
  const particles = [];
  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: W / 2 + (Math.random() - 0.5) * (W * 0.6),
      y: -20 - Math.random() * 80,
      vx: (Math.random() - 0.5) * 8,
      vy: 1.5 + Math.random() * 3,
      angle: Math.random() * Math.PI * 2,
      angVel: (Math.random() - 0.5) * 0.3,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      w: 5 + Math.random() * 5,
      h: 9 + Math.random() * 6,
    });
  }

  const start = performance.now();
  let rafId = 0;
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    const fadeStart = LIFETIME_MS * FADE_FRACTION;
    const alphaFromElapsed = elapsed > fadeStart
      ? Math.max(0, 1 - (elapsed - fadeStart) / (LIFETIME_MS * (1 - FADE_FRACTION)))
      : 1;
    for (const p of particles) {
      p.vy += GRAVITY;
      p.vx -= p.vx * DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.angVel;
      if (alphaFromElapsed > 0 && p.y < H + 50) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = alphaFromElapsed;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    if (alive && elapsed < LIFETIME_MS) {
      rafId = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(rafId);
      canvas.remove();
    }
  }
  rafId = requestAnimationFrame(frame);
}
const _firstClipTourDismissBtn = document.getElementById("first-clip-tour-dismiss");
if (_firstClipTourDismissBtn) {
  _firstClipTourDismissBtn.addEventListener("click", _dismissFirstClipTour);
}

// v149: one-time drag-to-reorder hint. Sits inside the library
// dialog and appears the first time the user has 2+ clips. Dismissed
// permanently on either the × button click or the user's first
// successful drag (set in _onDragEnd).
const DRAG_HINT_KEY = "narrative.dragHintDismissed";
function _isDragHintDismissed() {
  try { return localStorage.getItem(DRAG_HINT_KEY) === "1"; } catch { return false; }
}
function _dismissDragHint() {
  try { localStorage.setItem(DRAG_HINT_KEY, "1"); } catch {}
  const el = document.getElementById("drag-hint");
  if (el) el.hidden = true;
}
function _updateDragHint(clipCount) {
  const el = document.getElementById("drag-hint");
  if (!el) return;
  el.hidden = _isDragHintDismissed() || clipCount < 2;
}
const _dragHintDismissBtn = document.getElementById("drag-hint-dismiss");
if (_dragHintDismissBtn) {
  _dragHintDismissBtn.addEventListener("click", _dismissDragHint);
}

function _attachDragHandle(handle, cardEl) {
  handle.addEventListener("pointerdown", (e) => {
    // Ignore non-primary buttons (right-click etc).
    if (e.button !== 0 && e.button !== undefined && e.pointerType === "mouse") {
      return;
    }
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}

    _dragSession = {
      cardEl,
      pointerId: e.pointerId,
      startY: e.clientY,
    };
    cardEl.classList.add("dragging");

    handle.addEventListener("pointermove", _onDragMove);
    handle.addEventListener("pointerup", _onDragEnd);
    handle.addEventListener("pointercancel", _onDragEnd);
  });
}

function _onDragMove(e) {
  if (!_dragSession || e.pointerId !== _dragSession.pointerId) return;
  e.preventDefault();
  const dy = e.clientY - _dragSession.startY;
  _dragSession.cardEl.style.transform = `translateY(${dy}px)`;
}

async function _onDragEnd(e) {
  if (!_dragSession || e.pointerId !== _dragSession.pointerId) return;
  const { cardEl } = _dragSession;
  const handle = e.currentTarget;
  try { handle.releasePointerCapture(e.pointerId); } catch {}
  handle.removeEventListener("pointermove", _onDragMove);
  handle.removeEventListener("pointerup", _onDragEnd);
  handle.removeEventListener("pointercancel", _onDragEnd);

  // Where did the card visually land? Snapshot rect BEFORE we reset the
  // transform so it reflects the dragged position.
  const draggedRect = cardEl.getBoundingClientRect();
  const draggedMid = draggedRect.top + draggedRect.height / 2;

  cardEl.style.transform = "";
  cardEl.classList.remove("dragging");
  _dragSession = null;
  // v149: first successful drag = user discovered the feature, kill
  // the hint banner forever.
  if (!_isDragHintDismissed()) _dismissDragHint();

  // Find first sibling whose midpoint is below ours — that's the insertion
  // point. Only consider cards in the SAME parent (so the drag is bounded
  // by the section the card started in).
  const parent = cardEl.parentNode;
  const siblings = Array.from(parent.children).filter(
    (c) => c !== cardEl && c.classList.contains("clip")
  );
  let insertBefore = null;
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (draggedMid < mid) {
      insertBefore = sib;
      break;
    }
  }

  if (insertBefore) {
    parent.insertBefore(cardEl, insertBefore);
  } else {
    parent.appendChild(cardEl);
  }

  await _commitDragOrder();
}

async function _commitDragOrder() {
  // Walk the WHOLE library list (across both sections), record the visual
  // order of clip ids, persist to localStorage. We then re-render to make
  // sure the sectioned view is in the right shape — if a clip was dragged
  // across the Continue Listening / Other Clips boundary, the section
  // partition needs to re-run.
  const clipEls = Array.from(libraryList.querySelectorAll(".clip[data-clip-id]"));
  const order = clipEls.map((el) => Number(el.dataset.clipId)).filter(Number.isFinite);
  _saveLibraryOrder(order);

  // Switching to "custom" mode is the cleanest way to signal to the user
  // that their drag took effect — and it makes the sort consistent with
  // what they just dropped into place.
  if (_playMode !== "custom") {
    _playMode = "custom";
    try { localStorage.setItem(PLAY_MODE_KEY, _playMode); } catch {}
    updatePlayModeBtn();
  }

  renderLibrary();
}

function _appendSectionHeader(label, subtitle) {
  const h = document.createElement("div");
  h.className = "library-section";
  h.textContent = label;
  libraryList.appendChild(h);
  // v168: optional one-line subtitle under the section header. Used
  // to explain "Continue listening" to anyone who arrives at a
  // library that's been auto-split into two sections and doesn't
  // know why. Other sections just pass null and skip it.
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "library-section-subtitle";
    sub.textContent = subtitle;
    libraryList.appendChild(sub);
  }
}

// Build + render the tag-filter chip row above the library list.
//   allClips      — for the universe of tag chips to show
//   visibleClips  — for the count badge on each chip
// Side effect: prunes _libraryTagFilter of tags no clip carries anymore.
function _renderTagFilterRow(allClips, visibleClips) {
  if (!libraryTagFilters) return;
  // Collect distinct tags across all clips. Use an order-preserving
  // map so the chip order is stable: alphabetical, but ties broken by
  // first-appearance order in the library (which already follows the
  // user's sort).
  const allTags = new Set();
  for (const c of allClips) {
    if (Array.isArray(c.tags)) {
      for (const t of c.tags) allTags.add(t);
    }
  }
  // Prune stale filters.
  for (const t of _libraryTagFilter) {
    if (!allTags.has(t)) _libraryTagFilter.delete(t);
  }
  if (allTags.size === 0) {
    libraryTagFilters.hidden = true;
    libraryTagFilters.innerHTML = "";
    return;
  }
  libraryTagFilters.hidden = false;
  libraryTagFilters.innerHTML = "";

  // Per-tag count against the visible (post-search) set, so users
  // don't get "draft (12)" when only 2 of those 12 match the search.
  const counts = new Map();
  for (const c of visibleClips) {
    if (Array.isArray(c.tags)) {
      for (const t of c.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }

  const sorted = [...allTags].sort();
  for (const tag of sorted) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "library-tag-chip";
    const isActive = _libraryTagFilter.has(tag);
    if (isActive) chip.classList.add("active");
    chip.style.borderColor = _tagColor(tag);
    const n = counts.get(tag) || 0;
    chip.textContent = `${tag} · ${n}`;
    chip.setAttribute(
      "aria-pressed",
      isActive ? "true" : "false"
    );
    chip.addEventListener("click", () => {
      if (_libraryTagFilter.has(tag)) _libraryTagFilter.delete(tag);
      else _libraryTagFilter.add(tag);
      renderLibrary();
    });
    libraryTagFilters.appendChild(chip);
  }

  // "Clear" link appears only when a filter is active.
  if (_libraryTagFilter.size > 0) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "library-tag-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      _libraryTagFilter.clear();
      renderLibrary();
    });
    libraryTagFilters.appendChild(clear);
  }
}

async function renderLibrary() {
  let clips = [];
  try {
    clips = await listClips();
  } catch (e) {
    console.warn("library read failed:", e);
  }
  // v149: track whether any clip exists so _updateEmptyState can
  // hide the first-run starter card the moment the user has even
  // one clip in their library.
  _libraryHasClips = clips.length > 0;
  _updateEmptyState();
  // v149: drag-to-reorder discovery hint inside the library dialog.
  // Show only when there are 2+ clips (sorting one is meaningless)
  // and the user hasn't already dismissed or used the feature.
  _updateDragHint(clips.length);
  // v168: first-clip tour banner — bridges Edit / drag / Notes
  // discoverability the moment any clip lands in the library.
  _updateFirstClipTour(clips.length);
  // Snapshot the unfiltered list before sort/filter mutations so the tag
  // filter row can show every tag that exists (not just ones surviving
  // the current search). Prune _libraryTagFilter of any tag that no
  // clip carries anymore — otherwise a user who deletes the last
  // "draft" clip would see "0 clips with tag: draft" forever.
  const allClips = clips.slice();
  const totalCount = clips.length;
  // Revoke any cover object URLs from the previous render before we
  // wipe the DOM — each card's swatch may have created one. Without
  // this, repeated renderLibrary() calls slowly leak blob references.
  libraryList
    .querySelectorAll(".clip-swatch[data-cover-url]")
    .forEach((s) => {
      try { URL.revokeObjectURL(s.dataset.coverUrl); } catch {}
    });
  libraryList.innerHTML = "";
  // Library trigger badge in the hero. Shows total clip count, or
  // hides when the library is empty so first-time users see a clean
  // hero without a "0" sitting there.
  if (libraryTriggerCount) {
    if (totalCount > 0) {
      libraryTriggerCount.textContent = String(totalCount);
      libraryTriggerCount.hidden = false;
    } else {
      libraryTriggerCount.hidden = true;
    }
  }
  if (totalCount === 0) {
    // Empty-state stub — the dialog still opens, but the user gets a
    // friendly nudge instead of staring at a blank panel.
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent =
      "No clips yet — generate one or import a previous library zip.";
    libraryList.appendChild(empty);
    return;
  }

  // Show "Sync GitHub" only when at least one clip in the library has a
  // gitRef — no point offering it on a Tom Sawyer-only library.
  const hasGitClips = clips.some(
    (c) => c.gitRef && c.gitRef.repoUrl && c.gitRef.path
  );
  librarySyncGithubBtn.hidden = !hasGitClips;
  // v176: "Re-narrate outdated" surfaces only after Sync has actually
  // flagged something. Reading from the _outdatedClipIds Set keeps the
  // button honest — if a user re-imported a clip via another path, it
  // drops out of the set and the button hides.
  if (libraryRenarrateOutdatedBtn) {
    const outdatedCount = _outdatedClipIds ? _outdatedClipIds.size : 0;
    libraryRenarrateOutdatedBtn.hidden = outdatedCount === 0;
    libraryRenarrateOutdatedBtn.textContent =
      outdatedCount > 0
        ? `Re-narrate outdated (${outdatedCount})`
        : "Re-narrate outdated";
  }

  // "All bookmarks" only earns a slot in the tools row once there's at
  // least one bookmark somewhere — otherwise it's a dead button.
  const hasAnyBookmark = clips.some(
    (c) => Array.isArray(c.bookmarks) && c.bookmarks.length > 0
  );
  libraryAllBookmarksBtn.hidden = !hasAnyBookmark;

  // Sort first, then filter — that way the visible order matches what
  // auto-advance will play next.
  clips = sortClips(clips, _playMode);

  // "Hide played" filter — drop clips that have a playedAt stamp AND are
  // no longer in progress. In-progress clips (Continue Listening) stay
  // visible even if previously finished, since the user is replaying.
  if (_hidePlayed) {
    clips = clips.filter((c) => {
      const progress = Number(c.progressSec) || 0;
      const wasPlayed = !!c.playedAt;
      if (!wasPlayed) return true;
      return progress > 1; // played-and-restarted is still in rotation
    });
  }

  const query = _librarySearch.trim().toLowerCase();
  if (query) {
    clips = clips.filter((c) => {
      return (
        (c.title || "").toLowerCase().includes(query) ||
        (c.text || "").toLowerCase().includes(query) ||
        (c.voiceName || "").toLowerCase().includes(query) ||
        (c.note || "").toLowerCase().includes(query)
      );
    });
  }

  // Render the tag-filter chip row using ALL clips (so chips don't
  // disappear mid-interaction when a search hides their owners), with
  // counts computed against the post-search set so the numbers stay
  // meaningful.
  _renderTagFilterRow(allClips, clips);

  // Apply tag filter (AND across selected tags) AFTER search so the
  // header count below counts the actually-displayed clips.
  if (_libraryTagFilter.size > 0) {
    clips = clips.filter((c) => {
      const tags = Array.isArray(c.tags) ? c.tags : [];
      for (const wanted of _libraryTagFilter) {
        if (!tags.includes(wanted)) return false;
      }
      return true;
    });
  }

  // Header label reflects whether either filter is hiding anything.
  const filterActive = (query !== "" || _libraryTagFilter.size > 0);
  libraryLabel.textContent =
    filterActive && clips.length !== totalCount
      ? `Library · ${clips.length} of ${totalCount}`
      : "Library";

  if (clips.length === 0) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    if (_libraryTagFilter.size > 0) {
      const tags = [...(_libraryTagFilter)].join(", ");
      empty.textContent = query
        ? `No clips match "${query}" with tags: ${tags}`
        : `No clips with tags: ${tags}`;
    } else {
      empty.textContent = `No clips match "${query}"`;
    }
    libraryList.appendChild(empty);
    return;
  }

  // Split into "in progress" and "other" so resume-where-you-left-off
  // becomes a one-tap action at the top of the library. The in-progress
  // section ignores the user's sort mode and instead shows the most
  // recently created in-progress clip first (clip.id is a millis timestamp,
  // so newest-first is just descending id) — that's almost always the one
  // they want next.
  // `clips` is already sorted by the user's chosen mode (Custom / Newest /
  // Oldest / etc.). Continue Listening used to override that with a hard
  // id-desc sort, which silently ate any drag-to-reorder inside this
  // section — pick up the user's order here too so a Custom-order drag
  // sticks regardless of which section the card lives in.
  const inProgress = clips.filter(isClipInProgress);
  const inProgressIds = new Set(inProgress.map((c) => c.id));
  const others = clips.filter((c) => !inProgressIds.has(c.id));

  if (inProgress.length > 0) {
    _appendSectionHeader(
      `Continue listening · ${inProgress.length}`,
      "Clips you started but didn't finish — picks up where you left off.",
    );
    for (const clip of inProgress) libraryList.appendChild(makeClipCard(clip));
    if (others.length > 0) {
      _appendSectionHeader(`Other clips · ${others.length}`);
    }
  }

  for (const clip of others) libraryList.appendChild(makeClipCard(clip));
}

// ---- Edit clip (title + note + tags) ------------------------------------
// Opens the <dialog> with the current values, saves the new ones back into
// the same IndexedDB row. Audio blob and all the synthesis-side fields
// (voice, speaker, offsets, duration) are left untouched.
let _editingClipId = null;

// Tag normalization. The free-form comma-separated input becomes a clean
// array: trimmed, lowercased, deduped, empty entries dropped, max ~24
// chars per tag so the chip layout doesn't explode if someone pastes a
// paragraph in. Cap of 12 tags per clip — past that the card UI starts
// dominating.
function _normalizeTags(input) {
  if (Array.isArray(input)) {
    return _normalizeTags(input.join(","));
  }
  if (typeof input !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const raw of input.split(",")) {
    const t = raw.trim().toLowerCase().slice(0, 24);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

// Same djb2 hash as the cover swatch, but mapped to a single HSL hue so
// every tag has a stable color. Hueshift only — saturation/lightness
// fixed so chips read as a coherent set even with a dozen distinct tags.
function _tagColor(tag) {
  const h = _djb2Hash(String(tag || "")) % 360;
  return `hsl(${h} 60% 38%)`;
}

// ---- Cover-image helpers (v125) ----------------------------------------
// Authors can upload story-board art per chapter. We resize uploads to
// a 256x256 square (cover-fit), JPEG-encode at ~85% quality (~20-30KB
// each), and sample a dominant color for the Libby-style tint. The
// blob lives on `clip.cover.blob`; the color on `clip.cover.color`.

const COVER_SIZE_PX = 256;
const COVER_JPEG_QUALITY = 0.85;

// Process a user-uploaded image:
//   - Load via createImageBitmap (handles orientation + format)
//   - Draw cover-fit to a 256x256 canvas
//   - Extract dominant color by downsampling to 16x16 and averaging
//   - Encode to JPEG blob
// Returns { blob, color: {h,s,l} } or throws on unreadable input.
async function _processCoverImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = COVER_SIZE_PX;
    canvas.height = COVER_SIZE_PX;
    const ctx = canvas.getContext("2d");
    // Cover-fit: scale so the smaller dimension matches the canvas,
    // then center-crop the overflow on the larger dimension.
    const scale = Math.max(
      COVER_SIZE_PX / bitmap.width,
      COVER_SIZE_PX / bitmap.height
    );
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const dx = (COVER_SIZE_PX - drawW) / 2;
    const dy = (COVER_SIZE_PX - drawH) / 2;
    ctx.drawImage(bitmap, dx, dy, drawW, drawH);

    const color = _sampleDominantColor(ctx);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/jpeg",
        COVER_JPEG_QUALITY
      )
    );
    return { blob, color };
  } finally {
    bitmap.close();
  }
}

// Dominant-color sampler. Down-samples to 16x16 via drawImage scaling,
// reads back via getImageData, averages the RGB values, converts to
// HSL. Cheap (256 pixels) and good-enough for "soft tint backdrop"
// — no need to chase a perceptually-perfect dominant color.
function _sampleDominantColor(srcCtx) {
  const SAMPLE = 16;
  const tmp = document.createElement("canvas");
  tmp.width = SAMPLE;
  tmp.height = SAMPLE;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(srcCtx.canvas, 0, 0, SAMPLE, SAMPLE);
  const data = tctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Skip fully-transparent pixels (uploaded PNGs can have alpha).
    if (data[i + 3] < 8) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (n === 0) return { h: 220, s: 30, l: 40 };
  return _rgbToHsl(r / n, g / n, b / n);
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Object-URL lifecycle. Cards and the edit preview both render covers
// via createObjectURL — track them so we can revoke when the dialog
// closes / library re-renders, avoiding the slow leak Chrome warns about.
let _editPendingCover = null; // {blob, color} staged for save, or null
let _editPendingCoverUrl = null;

function _setEditCoverPreview(blob) {
  if (_editPendingCoverUrl) {
    URL.revokeObjectURL(_editPendingCoverUrl);
    _editPendingCoverUrl = null;
  }
  if (blob) {
    _editPendingCoverUrl = URL.createObjectURL(blob);
    clipEditCoverPreview.style.backgroundImage = `url("${_editPendingCoverUrl}")`;
    clipEditCoverRemove.hidden = false;
  } else {
    clipEditCoverPreview.style.backgroundImage = "";
    clipEditCoverRemove.hidden = true;
  }
}

// v219: render the read-only voice-provenance block in the Edit dialog.
// Returns silently if the clip has no provenance (pre-v219 clips, or
// clips made against an unaudited voice where we'd be guessing).
function _renderProvenanceBlock(clip) {
  const wrap = document.getElementById("clip-edit-provenance");
  if (!wrap) return;
  const p = clip && clip.provenance;
  if (!p) {
    wrap.hidden = true;
    return;
  }
  const badge = document.getElementById("clip-edit-provenance-badge");
  const voiceEl = document.getElementById("clip-edit-provenance-voice");
  const licEl = document.getElementById("clip-edit-provenance-license");
  const attrEl = document.getElementById("clip-edit-provenance-attribution");

  if (badge) {
    badge.textContent = p.licenseCommercial ? "Commercial ✓" : "Non-commercial";
    badge.classList.remove("commercial", "noncommercial");
    badge.classList.add(p.licenseCommercial ? "commercial" : "noncommercial");
  }
  if (voiceEl) {
    const speakerSuffix = (p.speakerId != null && p.speakerId !== 0)
      ? ` · speaker ${p.speakerId}`
      : "";
    voiceEl.innerHTML =
      `<span class="clip-edit-provenance-key">Voice:</span> ` +
      `<span class="clip-edit-provenance-val">${
        (p.voiceName || p.voiceId || "Unknown").replace(/</g, "&lt;")
      }${speakerSuffix}</span>`;
  }
  if (licEl) {
    const ds = p.licenseDataset ? ` · ${p.licenseDataset}` : "";
    licEl.innerHTML =
      `<span class="clip-edit-provenance-key">License:</span> ` +
      `<span class="clip-edit-provenance-val">${
        (p.license || "Unknown").replace(/</g, "&lt;")
      }${ds.replace(/</g, "&lt;")}</span>`;
  }
  if (attrEl) {
    attrEl.textContent = p.attribution || "(no attribution required)";
  }
  wrap.hidden = false;
}

async function openClipEdit(clipId) {
  const clip = await getClip(clipId);
  if (!clip) return;
  _editingClipId = clipId;
  clipEditTitle.value = clip.title || "";
  clipEditNote.value = clip.note || "";
  clipEditNotes.value = clip.notes || "";
  clipEditTags.value = Array.isArray(clip.tags) ? clip.tags.join(", ") : "";
  // v179: show source path + short SHA for GitHub-sourced clips. The
  // user can confirm "this is the chapter I just pushed" without
  // alt-tabbing to GitHub. Tooltip on the SHA chip shows the full hash.
  const gitRefEl = document.getElementById("clip-edit-gitref");
  if (gitRefEl) {
    if (clip.gitRef && clip.gitRef.sha && clip.gitRef.path) {
      const pathEl = document.getElementById("clip-edit-gitref-path");
      const shaEl = document.getElementById("clip-edit-gitref-sha");
      if (pathEl) pathEl.textContent = clip.gitRef.path;
      if (shaEl) {
        shaEl.textContent = clip.gitRef.sha.slice(0, 7);
        shaEl.title = `Full commit SHA: ${clip.gitRef.sha}`;
      }
      gitRefEl.hidden = false;
    } else {
      gitRefEl.hidden = true;
    }
  }
  // Cover staging. `_editPendingCover` represents the cover that will
  // be saved — initially mirrors the clip's current cover (or null if
  // none). User upload / remove mutates it; save persists it.
  if (clip.cover && clip.cover.blob) {
    _editPendingCover = { blob: clip.cover.blob, color: clip.cover.color || null };
    _setEditCoverPreview(clip.cover.blob);
  } else {
    _editPendingCover = null;
    _setEditCoverPreview(null);
  }
  // v219: voice provenance display. Read-only block shows what voice +
  // license were in effect when the clip's audio was generated. Hidden
  // when the clip has no provenance recorded (pre-v219 clips, or clips
  // generated against an unaudited voice — we don't fabricate).
  _renderProvenanceBlock(clip);
  clipEditDialog.showModal();
  clipEditTitle.focus();
  clipEditTitle.select();
}

function closeClipEdit() {
  _editingClipId = null;
  // Clean up any preview object URL the dialog created.
  if (_editPendingCoverUrl) {
    URL.revokeObjectURL(_editPendingCoverUrl);
    _editPendingCoverUrl = null;
  }
  _editPendingCover = null;
  clipEditDialog.close();
}

async function saveClipEdit() {
  if (!_editingClipId) return closeClipEdit();
  const id = _editingClipId;
  try {
    const clip = await getClip(id);
    if (!clip) return closeClipEdit();
    const newTitle = (clipEditTitle.value || "").trim() || "(untitled)";
    const newNote = (clipEditNote.value || "").trim();
    const newNotes = (clipEditNotes.value || "").trim();
    const newTags = _normalizeTags(clipEditTags.value);
    clip.title = newTitle;
    clip.note = newNote;
    clip.notes = newNotes;
    clip.tags = newTags;
    // Apply the staged cover. null = "remove cover".
    if (_editPendingCover && _editPendingCover.blob) {
      clip.cover = {
        blob: _editPendingCover.blob,
        color: _editPendingCover.color || null,
      };
    } else {
      delete clip.cover;
    }
    await saveClip(clip);
    closeClipEdit();
    renderLibrary();
    // If the user edited the currently-loaded clip's cover, refresh
    // the page backdrop so the new image (or removal) takes effect
    // without requiring a reload of the clip.
    if (id === _currentClipId) {
      _setBackgroundArt(clip);
    }
    setStatus(`Updated "${newTitle}"`);
  } catch (e) {
    console.warn("clip edit save failed:", e);
    setStatus(`Save failed: ${e.message}`, true);
  }
}

clipEditCoverPick.addEventListener("click", () => clipEditCoverInput.click());
clipEditCoverInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const processed = await _processCoverImage(file);
    _editPendingCover = processed;
    _setEditCoverPreview(processed.blob);
  } catch (err) {
    console.warn("cover upload failed:", err);
    setStatus(`Cover upload failed: ${err.message}`, true);
  } finally {
    // Reset so picking the same file again still fires "change".
    clipEditCoverInput.value = "";
  }
});
clipEditCoverRemove.addEventListener("click", () => {
  _editPendingCover = null;
  _setEditCoverPreview(null);
});

clipEditClose.addEventListener("click", closeClipEdit);
clipEditSave.addEventListener("click", saveClipEdit);
clipEditDialog.addEventListener("close", () => { _editingClipId = null; });

// v219: copy-attribution affordance. Grabs the exact credit line
// from the currently-displayed provenance block. Lets audiobook
// publishers / animators paste it straight into a credits roll
// without having to retype dataset names.
const _clipEditProvCopy = document.getElementById("clip-edit-provenance-copy");
if (_clipEditProvCopy) {
  _clipEditProvCopy.addEventListener("click", async () => {
    const el = document.getElementById("clip-edit-provenance-attribution");
    const txt = el ? (el.textContent || "").trim() : "";
    if (!txt || txt === "(no attribution required)") {
      setStatus("Nothing to copy — this voice doesn't require attribution.");
      return;
    }
    try {
      await navigator.clipboard.writeText(txt);
      setStatus("Attribution copied to clipboard.");
    } catch (err) {
      console.warn("provenance copy failed:", err);
      setStatus("Copy failed — select the text manually.", true);
    }
  });
}
clipEditTitle.addEventListener("keydown", (e) => {
  // Enter on the title field saves; multi-line note handles Enter natively.
  if (e.key === "Enter") {
    e.preventDefault();
    saveClipEdit();
  }
});

// ----- Notes dialog (v138) -----
// Lightweight focused editor for clip.notes. Opens from the 📝 chip
// in player-actions while a clip is loaded. Saves on close so the
// user doesn't have to remember a Save button mid-thought.
async function openNotesDialog(clipId) {
  if (!clipId) return;
  const clip = await getClip(clipId);
  if (!clip) return;
  _notesEditingClipId = clipId;
  notesDialogTitle.textContent = clip.title || "Notes";
  notesDialogText.value = clip.notes || "";
  notesDialogStatus.textContent = "";
  notesDialog.showModal();
  notesDialogText.focus();
}

async function _commitNotes() {
  const id = _notesEditingClipId;
  if (!id) return;
  try {
    const clip = await getClip(id);
    if (!clip) return;
    const newNotes = (notesDialogText.value || "").trim();
    // Skip the write if nothing changed — avoids touching the
    // IndexedDB record (and its updatedAt-like fields) on every close.
    if ((clip.notes || "") === newNotes) return;
    clip.notes = newNotes;
    await saveClip(clip);
    // Refresh the library so the 📝 card indicator appears/disappears
    // without requiring a reload.
    renderLibrary();
  } catch (e) {
    console.warn("notes save failed:", e);
  }
}

notesBtn.addEventListener("click", () => {
  if (!_currentClipId) {
    setStatus("Load a clip first to open its notes.", true);
    return;
  }
  openNotesDialog(_currentClipId);
});
notesDialogClose.addEventListener("click", () => notesDialog.close());
notesDialog.addEventListener("close", async () => {
  await _commitNotes();
  _notesEditingClipId = null;
});

// ---- Library export / import (zip backup) -------------------------------
// Self-contained STORED-mode zip implementation. We skip JSZip (~100 KB)
// because:
//   1. MP3 is already compressed — DEFLATE on it would buy a couple percent.
//   2. The manifest is tiny.
//   3. Keeping the app dependency-free is worth a few hundred lines of code.
//
// Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const _ZIP_LFH_SIG = 0x04034b50;
const _ZIP_CD_SIG = 0x02014b50;
const _ZIP_EOCD_SIG = 0x06054b50;

const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    t[i] = c >>> 0;
  }
  return t;
})();

function _crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds a zip from [{name, data: Uint8Array}, ...] and returns a Uint8Array.
// STORED only (compression method 0). UTF-8 filenames via the language-encoding
// flag (bit 11 in the GP bit flag field).
function makeZip(entries) {
  const encoder = new TextEncoder();

  // Pass 1: pre-compute name bytes, CRC, sizes, local-header offsets.
  const records = entries.map((e) => ({
    nameBytes: encoder.encode(e.name),
    data: e.data,
    crc: _crc32(e.data),
    size: e.data.length,
    localOffset: 0,
  }));

  let pos = 0;
  for (const r of records) {
    r.localOffset = pos;
    pos += 30 + r.nameBytes.length + r.size;
  }
  const cdStart = pos;
  for (const r of records) {
    pos += 46 + r.nameBytes.length;
  }
  const cdEnd = pos;
  const totalSize = cdEnd + 22;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let p = 0;

  // Local file headers + raw data
  for (const r of records) {
    view.setUint32(p, _ZIP_LFH_SIG, true); p += 4;
    view.setUint16(p, 20, true); p += 2;          // version needed
    view.setUint16(p, 0x0800, true); p += 2;      // GP bit flag — UTF-8 names
    view.setUint16(p, 0, true); p += 2;           // method (STORED)
    view.setUint16(p, 0, true); p += 2;           // mod time
    view.setUint16(p, 0, true); p += 2;           // mod date
    view.setUint32(p, r.crc, true); p += 4;
    view.setUint32(p, r.size, true); p += 4;
    view.setUint32(p, r.size, true); p += 4;
    view.setUint16(p, r.nameBytes.length, true); p += 2;
    view.setUint16(p, 0, true); p += 2;
    out.set(r.nameBytes, p); p += r.nameBytes.length;
    out.set(r.data, p); p += r.size;
  }

  // Central directory
  for (const r of records) {
    view.setUint32(p, _ZIP_CD_SIG, true); p += 4;
    view.setUint16(p, 20, true); p += 2;          // version made by
    view.setUint16(p, 20, true); p += 2;          // version needed
    view.setUint16(p, 0x0800, true); p += 2;      // GP flag — UTF-8 names
    view.setUint16(p, 0, true); p += 2;           // method
    view.setUint16(p, 0, true); p += 2;
    view.setUint16(p, 0, true); p += 2;
    view.setUint32(p, r.crc, true); p += 4;
    view.setUint32(p, r.size, true); p += 4;
    view.setUint32(p, r.size, true); p += 4;
    view.setUint16(p, r.nameBytes.length, true); p += 2;
    view.setUint16(p, 0, true); p += 2;
    view.setUint16(p, 0, true); p += 2;
    view.setUint16(p, 0, true); p += 2;           // disk number
    view.setUint16(p, 0, true); p += 2;           // internal attrs
    view.setUint32(p, 0, true); p += 4;           // external attrs
    view.setUint32(p, r.localOffset, true); p += 4;
    out.set(r.nameBytes, p); p += r.nameBytes.length;
  }

  // End of central directory
  view.setUint32(p, _ZIP_EOCD_SIG, true); p += 4;
  view.setUint16(p, 0, true); p += 2;
  view.setUint16(p, 0, true); p += 2;
  view.setUint16(p, records.length, true); p += 2;
  view.setUint16(p, records.length, true); p += 2;
  view.setUint32(p, cdEnd - cdStart, true); p += 4;
  view.setUint32(p, cdStart, true); p += 4;
  view.setUint16(p, 0, true); p += 2;            // comment length

  return out;
}

// Parse a zip blob back into [{name, data}, ...]. Throws on malformed
// input or any non-STORED entry (we'd never produce DEFLATE'd output).
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Scan backwards for EOCD signature — comment can be up to 64KB.
  let eocd = -1;
  const minStart = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === _ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (EOCD record missing)");

  const numEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(p, true) !== _ZIP_CD_SIG) {
      throw new Error("malformed central directory entry");
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (method !== 0) {
      throw new Error(`zip uses unsupported compression (method ${method}) for ${name}`);
    }
    if (view.getUint32(localOffset, true) !== _ZIP_LFH_SIG) {
      throw new Error(`bad local header for ${name}`);
    }
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const data = bytes.slice(dataStart, dataStart + compSize);
    out.push({ name, data });
  }
  return out;
}

async function exportLibrary(idsFilter = null) {
  const exportBtn = $("library-export");
  exportBtn.disabled = true;
  exportBtn.textContent = "Building…";
  try {
    const allClips = await listClips();
    const clips = idsFilter
      ? allClips.filter((c) => idsFilter.has(c.id))
      : allClips;
    if (clips.length === 0) {
      setStatus(
        idsFilter
          ? "Nothing selected — nothing to export."
          : "Library is empty — nothing to export.",
        true
      );
      return;
    }
    const presets = _loadPresets();

    const manifestClips = [];
    const entries = [];

    for (const clip of clips) {
      if (!clip.blob) continue;
      const bytes = new Uint8Array(await clip.blob.arrayBuffer());
      const ext = clip.blob.type === "audio/mpeg" ? "mp3" : "wav";
      const audioFile = `audio/${clip.id}.${ext}`;
      entries.push({ name: audioFile, data: bytes });

      // v125: include uploaded cover image as a JPEG sidecar, with
      // the dominant color carried in the manifest entry so import
      // can rehydrate the full cover record without re-sampling.
      let coverFile = null;
      let coverColor = null;
      if (clip.cover && clip.cover.blob) {
        const coverBytes = new Uint8Array(await clip.cover.blob.arrayBuffer());
        coverFile = `covers/${clip.id}.jpg`;
        entries.push({ name: coverFile, data: coverBytes });
        coverColor = clip.cover.color || null;
      }

      manifestClips.push({
        id: clip.id,
        title: clip.title || "",
        note: clip.note || "",
        notes: clip.notes || "",
        text: clip.text || "",
        voiceId: clip.voiceId || null,
        voiceName: clip.voiceName || "",
        speakerId: typeof clip.speakerId === "number" ? clip.speakerId : null,
        rate: Number(clip.rate) || 180,
        volume: typeof clip.volume === "number" ? clip.volume : 1.0,
        sentenceOffsetsSec: clip.sentenceOffsetsSec || [],
        durationSec: Number(clip.durationSec) || 0,
        progressSec: Number(clip.progressSec) || 0,
        createdAt: clip.createdAt || new Date(clip.id).toISOString(),
        audioFile,
        audioType: clip.blob.type,
        bookmarks: Array.isArray(clip.bookmarks) ? clip.bookmarks : [],
        playedAt: clip.playedAt || null,
        tags: Array.isArray(clip.tags) ? clip.tags : [],
        coverFile,
        coverColor,
        // v219: carry voice provenance across export/import so the
        // attribution string for any clip survives a backup → restore.
        // null for pre-v219 clips that have no provenance recorded.
        provenance: clip.provenance || null,
      });
    }

    const manifest = {
      schema: 1,
      app: "Narrative",
      exportedAt: new Date().toISOString(),
      clips: manifestClips,
      presets,
      // Carry the user-defined library order along so a restore lands
      // with chapters / clips in the right sequence on a fresh device.
      libraryOrder: _loadLibraryOrder(),
      playMode: _playMode,
    };

    const manifestBytes = new TextEncoder().encode(
      JSON.stringify(manifest, null, 2)
    );
    // Put the manifest first so a partial download still finds it.
    entries.unshift({ name: "manifest.json", data: manifestBytes });

    const zip = makeZip(entries);
    const blob = new Blob([zip], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `narrative-library-${today}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const mb = (zip.length / (1024 * 1024)).toFixed(1);
    setStatus(`Exported ${manifestClips.length} clip(s) (${mb} MB).`);
  } catch (e) {
    console.warn("export failed:", e);
    setStatus(`Export failed: ${e.message}`, true);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = "Export";
  }
}

async function importLibraryFromFile(file) {
  const importBtn = $("library-import");
  importBtn.disabled = true;
  importBtn.textContent = "Reading…";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = readZip(bytes);

    const manifestEntry = entries.find((e) => e.name === "manifest.json");
    if (!manifestEntry) {
      throw new Error("no manifest.json — is this a Narrative export?");
    }
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
    if (!manifest.clips || !Array.isArray(manifest.clips)) {
      throw new Error("manifest.json has no clips array");
    }

    // Audio + cover lookups: filename → bytes.
    const audioByName = new Map();
    const coverByName = new Map();
    for (const e of entries) {
      if (e.name.startsWith("audio/")) audioByName.set(e.name, e.data);
      else if (e.name.startsWith("covers/")) coverByName.set(e.name, e.data);
    }

    const existingIds = new Set((await listClips()).map((c) => c.id));
    let imported = 0;
    let skippedDup = 0;
    let skippedMissing = 0;

    for (const mc of manifest.clips) {
      if (existingIds.has(mc.id)) {
        skippedDup++;
        continue;
      }
      const audioBytes = audioByName.get(mc.audioFile);
      if (!audioBytes) {
        console.warn(`audio missing for clip ${mc.id} (${mc.audioFile})`);
        skippedMissing++;
        continue;
      }
      const blob = new Blob([audioBytes], {
        type: mc.audioType || "audio/mpeg",
      });
      // Cover sidecar (v125). Older manifests don't carry coverFile —
      // those clips just get the title-hash gradient when rendered.
      let cover = undefined;
      if (mc.coverFile) {
        const coverBytes = coverByName.get(mc.coverFile);
        if (coverBytes) {
          cover = {
            blob: new Blob([coverBytes], { type: "image/jpeg" }),
            color: mc.coverColor || null,
          };
        }
      }
      await saveClip({
        id: mc.id,
        title: mc.title || "(untitled)",
        note: mc.note || "",
        // v138: per-clip notes scratchpad. Older manifests don't
        // carry it — default to empty.
        notes: mc.notes || "",
        text: mc.text || "",
        voiceId: mc.voiceId || null,
        voiceName: mc.voiceName || "",
        speakerId: typeof mc.speakerId === "number" ? mc.speakerId : null,
        rate: Number(mc.rate) || 180,
        volume: typeof mc.volume === "number" ? mc.volume : 1.0,
        sentenceOffsetsSec: mc.sentenceOffsetsSec || [],
        durationSec: Number(mc.durationSec) || 0,
        progressSec: Number(mc.progressSec) || 0,
        // Bookmarks: array of {id, timeSec, note, createdAt}. Older
        // manifests don't have the field — default to empty.
        bookmarks: Array.isArray(mc.bookmarks) ? mc.bookmarks : [],
        playedAt: mc.playedAt || null,
        // Tags arrived in v109; older manifests don't carry them.
        tags: _normalizeTags(mc.tags),
        // Cover arrived in v125; older manifests don't carry it.
        ...(cover ? { cover } : {}),
        // v219: provenance carried verbatim if present. Older manifests
        // simply don't have it and the field stays undefined — the Edit
        // dialog handles that by hiding the provenance block.
        ...(mc.provenance ? { provenance: mc.provenance } : {}),
        createdAt: mc.createdAt || new Date(mc.id).toISOString(),
        blob,
      });
      imported++;
    }

    // Merge presets in by id; existing ones win.
    let presetsAdded = 0;
    if (Array.isArray(manifest.presets) && manifest.presets.length > 0) {
      const existing = _loadPresets();
      const existingPresetIds = new Set(existing.map((p) => p.id));
      for (const p of manifest.presets) {
        if (!existingPresetIds.has(p.id)) {
          existing.unshift(p);
          presetsAdded++;
        }
      }
      _savePresets(existing);
      renderPresets();
    }

    // Restore manual library order — append any ids that weren't already
    // present so existing local clips stay where they are.
    if (Array.isArray(manifest.libraryOrder) && manifest.libraryOrder.length > 0) {
      const existingOrder = _loadLibraryOrder();
      const seen = new Set(existingOrder);
      const merged = existingOrder.slice();
      for (const id of manifest.libraryOrder) {
        const n = Number(id);
        if (Number.isFinite(n) && !seen.has(n)) {
          merged.push(n);
          seen.add(n);
        }
      }
      _saveLibraryOrder(merged);
    }

    // Restore the play / sort mode if it was custom — otherwise leave the
    // local choice alone (the user's current sort preference wins).
    if (manifest.playMode === "custom" && _playMode !== "custom") {
      _playMode = "custom";
      try { localStorage.setItem(PLAY_MODE_KEY, _playMode); } catch {}
      updatePlayModeBtn();
    }

    renderLibrary();
    const parts = [`imported ${imported} clip(s)`];
    if (skippedDup) parts.push(`${skippedDup} duplicate(s) skipped`);
    if (skippedMissing) parts.push(`${skippedMissing} missing audio skipped`);
    if (presetsAdded) parts.push(`${presetsAdded} preset(s) added`);
    setStatus(parts.join(", ") + ".");
  } catch (e) {
    console.warn("import failed:", e);
    setStatus(`Import failed: ${e.message}`, true);
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = "Import";
  }
}

$("library-export").addEventListener("click", () => exportLibrary());
$("library-import").addEventListener("click", () => $("library-import-file").click());
$("library-import-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importLibraryFromFile(file);
  // Reset so selecting the same file twice still fires "change".
  e.target.value = "";
});

// ---- Library multi-select -----------------------------------------------
// Bulk delete + bulk export for clip libraries that have grown past
// "click × thirty times in a row" territory. Tapping the Select link
// flips renderLibrary into select mode: each card grows a checkbox in
// place of the drag handle, tapping the card toggles its selection
// (instead of loading and playing), and the tools row swaps to
// Cancel · Select all · Export N · Delete N with live counts.
let _libraryMultiSelect = false;
const _librarySelectedIds = new Set();

const libraryToolsIdle = $("library-tools-idle");
const libraryToolsSelect = $("library-tools-select");
const librarySelectBtn = $("library-select");
const librarySelectCancelBtn = $("library-select-cancel");
const librarySelectAllBtn = $("library-select-all");
const librarySelectExportBtn = $("library-select-export");
const librarySelectDeleteBtn = $("library-select-delete");

function _enterMultiSelect() {
  _libraryMultiSelect = true;
  _librarySelectedIds.clear();
  libraryToolsIdle.hidden = true;
  libraryToolsSelect.hidden = false;
  _updateMultiSelectCounts();
  // Reset the delete button's confirm-arming if a previous session left
  // it half-armed.
  _disarmBulkDelete();
  renderLibrary();
}

function _exitMultiSelect() {
  _libraryMultiSelect = false;
  _librarySelectedIds.clear();
  libraryToolsIdle.hidden = false;
  libraryToolsSelect.hidden = true;
  _disarmBulkDelete();
  renderLibrary();
}

function _updateMultiSelectCounts() {
  const n = _librarySelectedIds.size;
  librarySelectExportBtn.textContent = `Export ${n}`;
  librarySelectDeleteBtn.textContent =
    _bulkDeleteArmed ? `Tap again to delete ${n}` : `Delete ${n}`;
  librarySelectExportBtn.disabled = n === 0;
  librarySelectDeleteBtn.disabled = n === 0;
  if (n === 0) _disarmBulkDelete();
}

// Tap-twice-to-confirm pattern (same as Reset stats) so a bulk delete
// doesn't fire on a single misclick. Three seconds armed window; resets
// on selection change, mode exit, or another action.
let _bulkDeleteArmed = false;
let _bulkDeleteArmTimer = null;
function _armBulkDelete() {
  _bulkDeleteArmed = true;
  clearTimeout(_bulkDeleteArmTimer);
  _bulkDeleteArmTimer = setTimeout(_disarmBulkDelete, 3000);
  _updateMultiSelectCounts();
}
function _disarmBulkDelete() {
  _bulkDeleteArmed = false;
  clearTimeout(_bulkDeleteArmTimer);
  _bulkDeleteArmTimer = null;
}

librarySelectBtn.addEventListener("click", _enterMultiSelect);
librarySelectCancelBtn.addEventListener("click", _exitMultiSelect);

librarySelectAllBtn.addEventListener("click", () => {
  // Select every clip currently rendered (respects the active filter
  // and sort). Reads the DOM so a search-narrowed view selects only
  // what the user is looking at, not the full library.
  const visible = libraryList.querySelectorAll(".clip[data-clip-id]");
  for (const node of visible) {
    const id = Number(node.dataset.clipId);
    if (Number.isFinite(id)) _librarySelectedIds.add(id);
  }
  _updateMultiSelectCounts();
  renderLibrary();
});

librarySelectExportBtn.addEventListener("click", async () => {
  if (_librarySelectedIds.size === 0) return;
  const ids = new Set(_librarySelectedIds);
  await exportLibrary(ids);
  _exitMultiSelect();
});

librarySelectDeleteBtn.addEventListener("click", async () => {
  if (_librarySelectedIds.size === 0) return;
  if (!_bulkDeleteArmed) {
    _armBulkDelete();
    return;
  }
  const ids = [..._librarySelectedIds];
  _disarmBulkDelete();
  try {
    for (const id of ids) {
      await deleteClipById(id);
      if (_currentClipId === id) {
        _currentClipId = null;
        _currentPlayingVoiceId = null;
      }
    }
    setStatus(`Deleted ${ids.length} clip${ids.length === 1 ? "" : "s"}.`);
  } catch (e) {
    console.warn("bulk delete failed:", e);
    setStatus(`Bulk delete failed: ${e.message}`, true);
  }
  _exitMultiSelect();
});

async function loadClip(id) {
  const clip = await getClip(id);
  if (!clip) return;

  // Whatever auto-advance had queued is now stale — the user picked
  // something explicitly.
  _cancelAutoAdvance();
  // A-B loop bounds belonged to whatever audio was loaded before.
  clearAbLoop();

  // Drop any in-progress streaming state so the chained-playback / virtualTime
  // logic doesn't try to walk a queue from a previous generate().
  resetStream();

  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  lastBlob = clip.blob;
  lastBlobUrl = URL.createObjectURL(clip.blob);
  sentenceOffsetsSec = (clip.sentenceOffsetsSec || []).slice();

  textEl.value = clip.text || "";
  updateCounts();
  if (clip.voiceId) {
    voiceEl.value = clip.voiceId;
    onVoiceChange(); // re-render the speaker row for the new voice
    if (
      typeof clip.speakerId === "number" &&
      !speakerRow.hidden &&
      speakerEl.options.length > clip.speakerId
    ) {
      speakerEl.value = String(clip.speakerId);
    }
  }
  if (clip.rate) {
    rateEl.value = String(clip.rate);
    rateValueEl.textContent = String(clip.rate);
  }
  if (typeof clip.volume === "number") {
    volumeEl.value = String(Math.round(clip.volume * 100));
    volumeValueEl.textContent = `${Math.round(clip.volume * 100)}%`;
  }

  // Bind the player to this clip so the throttled progress-saver knows which
  // library row to update as playback advances.
  _currentClipId = id;
  // Libby-style page backdrop — fade in the cover as a blurred wash.
  _setBackgroundArt(clip);
  // Listen-stats attributes by the clip's stored voice (not the picker,
  // which can drift while playback continues). Cached here so the
  // timeupdate accumulator doesn't have to round-trip IDB on every tick.
  _currentPlayingVoiceId = clip.voiceId || null;
  _lastProgressSaveAt = Date.now();
  // loadClip sets voiceEl.value to clip.voiceId above, so the picker
  // matches the clip's voice on entry — re-narrate banner should be
  // hidden. Reset the dismiss tracker too so a future voice change on
  // this clip can prompt.
  renarrateBanner.hidden = true;
  _renarrateDismissedClipId = null;

  enterReadingView(
    clip.text || "",
    Array.isArray(clip.images) ? clip.images : [],
    Array.isArray(clip.highlights) ? clip.highlights : []
  );
  setMediaMetadata(clip.text || "");

  // Resume from saved position once metadata is in. Only restore if it's a
  // meaningful chunk past the start AND a bit before the end — otherwise
  // just play from 0 so the user isn't dumped at the end of a "completed" clip.
  const resumeAt = Number(clip.progressSec) || 0;
  if (resumeAt > 1) {
    playerEl.addEventListener("loadedmetadata", () => {
      const dur = playerEl.duration;
      if (isFinite(dur) && resumeAt < dur - 1) {
        playerEl.currentTime = resumeAt;
      }
    }, { once: true });
  }

  playerEl.src = lastBlobUrl;
  playerCard.hidden = false;
  downloadBtn.disabled = false;

  setStatus(
    resumeAt > 1
      ? `Resuming · ${clip.title} · ${formatTime(resumeAt)}`
      : `Loaded · ${clip.title}`
  );
  playerEl.play().catch(() => {});
  // Re-render so the ▶ indicator moves to this clip + the new clip's
  // bookmarks list appears under the player.
  renderLibrary();
  renderBookmarks();
  // Keep the mini player's title fresh even when it's currently visible
  // (e.g. auto-advance fires while the user is scrolled down).
  _updateMiniPlayerTitle();
  // GitHub source check. If this clip came from GitHub and the upstream
  // SHA has changed, surface the outdated banner so the user can
  // refetch + re-narrate. Quietly silent if no token, no gitRef, or
  // the check fails (network, rate limit) — we don't want a banner
  // popping up for non-content reasons.
  _gitOutdatedBanner.hidden = true;
  _gitOutdatedClipId = null;
  if (clip.gitRef && clip.gitRef.repoUrl && clip.gitRef.path && getGithubToken()) {
    _checkGitSourceFreshness(clip);
  }
}

libraryClearBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved clips? This can't be undone.")) return;
  await clearLibrary();
  renderLibrary();
});

// ---- Import dropdown ----------------------------------------------------
// One menu fronts every manuscript source: Upload file (single doc),
// Paste URL (any URL or github.com/owner/repo), GitHub repo (URL row
// prefilled), Scrivener bundle (.scriv.zip), Obsidian vault (.zip).
// Each item dispatches to the same downstream entry points the old
// per-source buttons used. Closing on outside-click / Escape keeps
// the menu disposable without modal overhead.

function _openImportMenu() {
  importMenu.hidden = false;
  importBtn.setAttribute("aria-expanded", "true");
}

function _closeImportMenu() {
  importMenu.hidden = true;
  importBtn.setAttribute("aria-expanded", "false");
}

importBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (importMenu.hidden) _openImportMenu();
  else _closeImportMenu();
});

document.addEventListener("click", (e) => {
  if (importMenu.hidden) return;
  if (importMenu.contains(e.target) || importBtn.contains(e.target)) return;
  _closeImportMenu();
});

document.addEventListener("keydown", (e) => {
  if (!importMenu.hidden && e.key === "Escape") _closeImportMenu();
});

importMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-import]");
  if (!btn) return;
  _closeImportMenu();
  const source = btn.dataset.import;
  if (source === "file") {
    uploadInput.click();
  } else if (source === "url") {
    if (urlRow.hidden) showUrlRow({ placeholder: "https://… (article URL)" });
    else hideUrlRow();
  } else if (source === "github") {
    // Open the URL row pre-primed for a github.com/owner/repo paste.
    // _isGithubRepoRoot() in fetchFromUrl will route this to
    // openGithubBrowser, so we don't need a separate code path here.
    // v142: hint up top spells out repo root vs file URL — testers
    // were pasting /blob/<branch>/<path> URLs from individual
    // chapter files and getting confused when nothing loaded.
    // v163 / v176: pre-fill with the most recently browsed repo and
    // (v176) surface up to RECENT_REPOS_MAX recents as one-click
    // chips so a user juggling multiple projects can flip between
    // them without re-pasting URLs. Single recent → just the prefill
    // + hint; 2+ recents → also show the chip row.
    const recents = _getRecentGithubRepos();
    const lastRepo = recents.length > 0 ? recents[0] : null;
    showUrlRow({
      placeholder: "github.com/owner/repo",
      prefill: lastRepo ? lastRepo.url : "https://github.com/",
      hint: lastRepo
        ? `Last opened: <strong>${lastRepo.owner}/${lastRepo.repo}</strong>. Hit Fetch to re-open it, or paste a different repo URL.`
        : 'Paste the <strong>repo root</strong> — like ' +
          '<code>github.com/owner/repo</code> — not a link to a ' +
          'specific file. We\'ll open a picker so you can choose ' +
          'which chapters to import.',
      recentRepos: recents,
    });
  } else if (source === "gist") {
    // v181: pre-prime the URL row for a Gist paste. fetchFromUrl
    // dispatches to openGistBrowser when the host matches.
    showUrlRow({
      placeholder: "gist.github.com/user/<id>",
      prefill: "https://gist.github.com/",
      hint:
        'Paste a Gist URL — like ' +
        '<code>gist.github.com/user/abc123</code>. Single-file Gists ' +
        'load straight into the textarea; multi-file Gists open the ' +
        'picker.',
    });
  } else if (source === "scrivener") {
    scrivenerInput.click();
  } else if (source === "obsidian") {
    obsidianInput.click();
  }
});

// ---- URL row ------------------------------------------------------------
// Inline input above the textarea. Submit fetches the article server-
// side (trafilatura strips nav/ads/footers) and drops clean text into
// the textarea, ready for Generate. Used by both Paste URL and GitHub
// repo menu items — the placeholder/prefill differs but the fetch path
// is shared.

function showUrlRow(opts) {
  urlRow.hidden = false;
  urlInput.disabled = false;
  urlFetchBtn.disabled = false;
  if (opts && opts.placeholder) urlInput.placeholder = opts.placeholder;
  if (opts && opts.prefill != null) urlInput.value = opts.prefill;
  // v142: per-flow hint above the row. innerHTML so callers can
  // emphasize key shapes with <strong>/<code>; copy is hard-coded
  // by the caller so we're not interpolating untrusted input.
  if (opts && opts.hint) {
    urlRowHint.innerHTML = opts.hint;
    urlRowHint.hidden = false;
  } else {
    urlRowHint.innerHTML = "";
    urlRowHint.hidden = true;
  }
  // v176: recent-repos chip row. Only the GitHub flow passes
  // opts.recentRepos; other callers leave this hidden. Each chip
  // pre-fills the URL field + auto-submits Fetch so a user juggling
  // multiple book projects can flip between them without re-pasting.
  if (urlRowRecents) {
    if (opts && Array.isArray(opts.recentRepos) && opts.recentRepos.length > 1) {
      urlRowRecents.hidden = false;
      urlRowRecents.innerHTML = "";
      const label = document.createElement("span");
      label.className = "url-row-recents-label";
      label.textContent = "Switch to:";
      urlRowRecents.appendChild(label);
      // Skip index 0 — that's already pre-filled. Surface the rest.
      for (let i = 1; i < opts.recentRepos.length; i++) {
        const r = opts.recentRepos[i];
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "url-row-recent-chip";
        chip.title = `Switch to ${r.owner}/${r.repo}`;
        chip.textContent = `${r.owner}/${r.repo}`;
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          urlInput.value = r.url;
          // Auto-submit so the picker opens immediately — the user
          // explicitly picked this repo, no need for a second click.
          fetchFromUrl();
        });
        urlRowRecents.appendChild(chip);
      }
    } else {
      urlRowRecents.hidden = true;
      urlRowRecents.innerHTML = "";
    }
  }
  urlInput.focus();
  // For prefilled-with-prefix cases (github), put the caret at end so
  // the user can keep typing the owner/repo without clearing the prefix.
  if (opts && opts.prefill) {
    const len = urlInput.value.length;
    urlInput.setSelectionRange(len, len);
  } else {
    urlInput.select();
  }
}

function hideUrlRow() {
  urlRow.hidden = true;
  urlInput.value = "";
  urlRowHint.hidden = true;
  urlRowHint.innerHTML = "";
  // v176: also clear recents chips so they don't bleed into the next
  // showUrlRow call (e.g. Paste URL after GitHub).
  if (urlRowRecents) {
    urlRowRecents.hidden = true;
    urlRowRecents.innerHTML = "";
  }
}

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fetchFromUrl();
  } else if (e.key === "Escape") {
    hideUrlRow();
  }
});

// ---- Scrivener bundle upload (dedicated input) -------------------------
// Posts the .zip to /api/extract/scrivener and opens the shared
// picker with the parsed chapter list. Mirrors the .zip branch in
// the main upload handler — kept separate because the explicit menu
// path always knows it's a Scrivener bundle (no sniff needed).

scrivenerInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/extract/scrivener", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    openScrivenerBrowser(data);
    setStatus(
      `Loaded ${data.project_name} · ${data.chapters.length} chapter${data.chapters.length === 1 ? "" : "s"}`
    );
  } catch (err) {
    setStatus(`Scrivener import failed: ${err.message}`, true);
  } finally {
    scrivenerInput.value = "";
  }
});

// ---- Obsidian vault upload (dedicated input) ---------------------------
// Same shape as the Scrivener handler — POST the zip, open the shared
// picker with the parsed note list. The Obsidian endpoint filters out
// .obsidian/, templates/, etc. server-side so the user only ever sees
// importable Markdown notes.

obsidianInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/extract/obsidian", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    openObsidianBrowser(data);
    setStatus(
      `Loaded ${data.vault_name} · ${data.chapters.length} note${data.chapters.length === 1 ? "" : "s"}`
    );
  } catch (err) {
    setStatus(`Obsidian import failed: ${err.message}`, true);
  } finally {
    obsidianInput.value = "";
  }
});

urlFetchBtn.addEventListener("click", fetchFromUrl);

// ---- GitHub freshness check (auto-check on clip load) ---------------------
// When a clip with a stored gitRef is opened, fire a single sync-check
// against GitHub. If the upstream SHA has moved, show the outdated
// banner. Refetch-and-renarrate runs the existing regen path so the
// clip's bookmarks survive.
const _gitOutdatedBanner = $("git-outdated-banner");
const _gitOutdatedConfirm = $("git-outdated-confirm");
const _gitOutdatedDismiss = $("git-outdated-dismiss");
let _gitOutdatedClipId = null;
let _gitOutdatedNewSha = null;

async function _checkGitSourceFreshness(clip) {
  if (!clip || !clip.gitRef) return;
  const { repoUrl, branch, path, sha: storedSha } = clip.gitRef;
  if (!repoUrl || !path) return;
  try {
    const res = await fetch("/api/github/sync-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        github_token: getGithubToken() || undefined,
        items: [{ repoUrl, branch, paths: [path] }],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const result = (data.results || [])[0];
    if (!result || result.error) return;
    const currentSha = (result.shas || {})[path];
    if (!currentSha || currentSha === storedSha) return;
    // Outdated. Surface banner targeting THIS specific clip; if the
    // user loads a different clip mid-check, the load handler hides
    // the banner so we don't act on stale state.
    if (_currentClipId !== clip.id) return;
    _gitOutdatedClipId = clip.id;
    _gitOutdatedNewSha = currentSha;
    _gitOutdatedBanner.hidden = false;
  } catch {
    // Silent: rate-limit, network blip, etc.
  }
}

_gitOutdatedDismiss.addEventListener("click", () => {
  _gitOutdatedBanner.hidden = true;
  _gitOutdatedClipId = null;
  _gitOutdatedNewSha = null;
});

_gitOutdatedConfirm.addEventListener("click", async () => {
  if (!_gitOutdatedClipId) return;
  const clipId = _gitOutdatedClipId;
  _gitOutdatedBanner.hidden = true;
  const clip = await getClip(clipId);
  if (!clip || !clip.gitRef) return;
  const { repoUrl, branch, path } = clip.gitRef;
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) {
    setStatus("Couldn't parse repo URL — refetch cancelled.", true);
    return;
  }
  const owner = m[1];
  const repo = m[2];
  const rawUrl =
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(path)}`;
  setStatus(`Refetching ${path}…`);
  try {
    const res = await fetch("/api/extract/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: rawUrl,
        github_token: getGithubToken() || undefined,
        git_sha: _gitOutdatedNewSha || undefined,
      }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    // Stash the new gitRef so the regen-save callback writes it back.
    _pendingGitRef = data.gitRef || null;
    _pendingImages = Array.isArray(data.images) ? data.images : [];
    // Mark this clip as the regen target. generate() preserves title,
    // note, bookmarks, createdAt — only the text + audio change.
    _regenTargetClipId = clipId;
    textEl.value = data.text || "";
    updateCounts();
    // Hand off to generate(). The save path picks up regenExistingMeta
    // via getClip, which now returns the gitRef-updated state.
    generate();
  } catch (err) {
    setStatus(`Refetch failed: ${err.message}`, true);
  }
});

// ---- GitHub repo browser (Level 2 GitHub integration) ----
// Opened from fetchFromUrl when the user pastes a repo-root URL.
// Calls /api/github/tree to list .md/.txt/.docx/.pdf/.epub files,
// renders them as checkboxes, and either loads one (single selection
// = same as URL fetch) or builds a chapter queue (multi-selection =
// each file becomes a chapter).

// ---- Shared document picker --------------------------------------------
// Multi-file manuscript sources (GitHub, Scrivener, Obsidian) all need
// the same UI: titled dialog, meta line, filter input, scrollable list
// of selectable items, running selection summary, Use button. This
// component owns that machinery; callers pass items + an async Use
// callback and get back the selected subset.
//
// Items shape:
//   { id: string, title: string, subtitle?: string,
//     size?: number,  // bytes — formatted as B/KB/MB
//     chars?: number, // characters — formatted as "X chars" / "X.Yk chars"
//     extra?: any }   // anything the caller wants threaded back (sha, text, …)
//
// Lifecycle:
//   const handle = openDocumentPicker({title, meta, items, onUse, …})
//   handle.setTitle(s) / setMeta(s) / setItems(arr) / close()
// Use cases:
//   - GitHub opens with items=null + meta="Loading…", then fills via setItems
//     once /api/github/tree responds (or shows the error in setMeta).
//   - Scrivener / Obsidian open with items pre-populated.
// onUse is invoked AFTER the dialog closes — async work runs in the
// status bar, not blocking the dialog.

const docPickerDialog = $("document-picker-dialog");
const docPickerClose = $("doc-picker-close");
const docPickerCancel = $("doc-picker-cancel");
const docPickerUse = $("doc-picker-use");
const docPickerTitle = $("doc-picker-title");
const docPickerMeta = $("doc-picker-meta");
const docPickerFilter = $("doc-picker-filter");
const docPickerList = $("doc-picker-list");
const docPickerSummary = $("doc-picker-summary");
// v176: "Hide already imported" filter chip. Only revealed when the
// caller passes an isImported callback (GitHub flow today).
const docPickerHideImported = $("doc-picker-hide-imported");
// v179: GitHub branch picker + folder suggestion chips. Both are
// populated by openGithubBrowser and hidden for non-GitHub sources.
const docPickerBranchesRow = $("doc-picker-branches-row");
const docPickerBranches = $("doc-picker-branches");
const docPickerFolderChips = $("doc-picker-folder-chips");
// v139: background-mode toggle row. Shown only when 2+ items are
// selected (single picks bypass the queue entirely).
const docPickerBgLabel = $("doc-picker-bg-label");
const docPickerBgToggle = $("doc-picker-bg-toggle");

let _docPickerState = null;

function _docPickerFormatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function _docPickerFormatChars(n) {
  if (!n) return "";
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

function _docPickerItemSize(item) {
  // Prefer chars (cleaner for pre-parsed text), fall back to bytes
  // (for raw filesystem items like GitHub tree entries).
  if (item.chars != null) return _docPickerFormatChars(item.chars);
  if (item.size != null) return _docPickerFormatSize(item.size);
  return "";
}

// v182: build a folder tree from a flat list of items keyed by path.
// VSCode-style: folders carry .folders (Map<name, node>) and .files
// (array of items). Each node also tracks its full path so the
// renderer can look up "is this folder open" state without re-walking.
function _docPickerBuildTree(items) {
  const root = { name: "", path: "", folders: new Map(), files: [] };
  for (const it of items) {
    const segments = (it.title || it.id || "").split("/");
    let node = root;
    let accum = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!seg) continue;
      accum = accum ? `${accum}/${seg}` : seg;
      if (!node.folders.has(seg)) {
        node.folders.set(seg, {
          name: seg, path: accum, folders: new Map(), files: [],
        });
      }
      node = node.folders.get(seg);
    }
    // Last segment is the filename (or, if the path had no slashes,
    // the whole thing is a root-level file).
    node.files.push(it);
  }
  return root;
}

// v182: walk the tree and collect every file item under a node (used
// for the folder-checkbox bulk-select tri-state). Returns an array
// of the underlying item objects, NOT just ids, so the caller can
// also tally chars/bytes if it wants.
function _docPickerCollectFiles(node) {
  const out = [];
  function walk(n) {
    for (const f of n.files) out.push(f);
    for (const child of n.folders.values()) walk(child);
  }
  walk(node);
  return out;
}

// v182: when the user types into the filter input, every folder
// whose subtree contains at least one matching file should auto-
// expand. Returns the Set of folder paths to mark open this render.
function _docPickerAutoExpanded(node, matches) {
  const out = new Set();
  function walk(n) {
    let any = false;
    for (const f of n.files) {
      if (matches.has(f.id)) any = true;
    }
    for (const child of n.folders.values()) {
      const childHas = walk(child);
      if (childHas) {
        out.add(child.path);
        any = true;
      }
    }
    return any;
  }
  walk(node);
  return out;
}

function _docPickerRender() {
  if (!_docPickerState) return;
  const s = _docPickerState;
  const q = (docPickerFilter.value || "").trim().toLowerCase();
  const items = s.items || [];
  // v176: precompute imported-set so we don't call isImported(it)
  // twice per row (once for badge, once for the hide filter).
  // Cache lives only for this render — small Map<id, true>.
  const importedIds = new Set();
  if (typeof s.isImported === "function") {
    for (const it of items) {
      try {
        if (s.isImported(it)) importedIds.add(it.id);
      } catch {}
    }
  }
  let filtered = q
    ? items.filter(
        (it) =>
          it.title.toLowerCase().includes(q) ||
          (it.subtitle || "").toLowerCase().includes(q)
      )
    : items;
  // v176: optional "Hide already imported" filter — applied after the
  // text filter so the running count reflects both filters together.
  if (s.hideImported && importedIds.size > 0) {
    filtered = filtered.filter((it) => !importedIds.has(it.id));
  }
  docPickerList.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "doc-picker-file-empty";
    empty.textContent = q
      ? s.noMatchText || "No matching items."
      : s.hideImported && importedIds.size > 0
      ? "Every file in this repo is already in your library or queue."
      : s.emptyText || "No items.";
    docPickerList.appendChild(empty);
    return;
  }

  // v182: tree-mode renderer. Builds a folder hierarchy from the
  // filtered items, then walks it recursively. Folders render as
  // disclosure rows (▸/▾ + folder icon + name + descendant count +
  // tri-state checkbox); files render as indented leaf rows with the
  // existing checkbox + ✓ imported badge + size.
  if (s.treeView) {
    _docPickerRenderTree(filtered, importedIds, q);
    return;
  }

  // Legacy flat list — Scrivener / Obsidian still use this path.
  for (const it of filtered) {
    docPickerList.appendChild(_docPickerMakeFileRow(it, importedIds, 0));
  }
}

// v182: render one file row. Extracted so both the flat list and the
// tree leaves can share it. `depth` is the indentation level (0 for
// flat / root, increments per folder); 0 leaves padding at the
// default so the legacy Scrivener / Obsidian layouts stay unchanged.
function _docPickerMakeFileRow(it, importedIds, depth) {
  const s = _docPickerState;
  const label = document.createElement("label");
  label.className = "doc-picker-file";
  const imported = importedIds.has(it.id);
  if (imported) label.classList.add("doc-picker-file-imported");
  if (depth > 0) {
    label.classList.add("doc-picker-file-leaf");
    label.style.paddingLeft = `${depth * 16 + 6}px`;
  }
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = s.selected.has(it.id);
  cb.addEventListener("change", (e) => {
    e.stopPropagation();
    if (cb.checked) s.selected.add(it.id);
    else s.selected.delete(it.id);
    _docPickerUpdateSummary();
    // v182: a leaf flip changes the tri-state ancestors above it. In
    // tree mode we re-render to refresh those rows; flat mode skips
    // the re-render to avoid scroll thrash.
    if (s.treeView) _docPickerRender();
  });
  const pathSpan = document.createElement("span");
  pathSpan.className = "doc-picker-file-path";
  // In tree mode, show only the basename (the folder path is conveyed
  // by indentation + parent rows). In flat mode keep the full path.
  let labelText = it.title;
  if (s.treeView) {
    const slash = (it.title || "").lastIndexOf("/");
    if (slash >= 0) labelText = it.title.slice(slash + 1);
  }
  pathSpan.textContent = it.subtitle ? `${labelText}  (${it.subtitle})` : labelText;
  if (imported) {
    const badge = document.createElement("span");
    badge.className = "doc-picker-file-imported-badge";
    badge.textContent = "✓ imported";
    badge.title = "Already in your library or sitting in the queue";
    pathSpan.appendChild(document.createTextNode(" "));
    pathSpan.appendChild(badge);
  }
  const sizeSpan = document.createElement("span");
  sizeSpan.className = "doc-picker-file-size";
  sizeSpan.textContent = _docPickerItemSize(it);
  label.appendChild(cb);
  label.appendChild(pathSpan);
  label.appendChild(sizeSpan);
  return label;
}

// v182: tree-mode renderer — builds the folder hierarchy and walks
// it recursively. Folders that contain matching files auto-expand
// when a filter is active so the user can scan results without
// clicking through dozens of carets.
function _docPickerRenderTree(filteredItems, importedIds, q) {
  const s = _docPickerState;
  const tree = _docPickerBuildTree(filteredItems);
  // When filtering, all matching paths' ancestors auto-expand. When
  // not filtering, use the user's persisted expand state (so a manual
  // open survives across re-renders, e.g. after a checkbox flip).
  const matches = new Set(filteredItems.map((it) => it.id));
  const autoOpen = q ? _docPickerAutoExpanded(tree, matches) : null;
  function isOpen(path) {
    if (autoOpen && autoOpen.has(path)) return true;
    return s.expandedFolders.has(path);
  }

  function renderNode(node, depth) {
    const folderNames = Array.from(node.folders.keys()).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    for (const fname of folderNames) {
      const child = node.folders.get(fname);
      const row = _docPickerMakeFolderRow(child, depth, isOpen(child.path));
      docPickerList.appendChild(row);
      if (isOpen(child.path)) renderNode(child, depth + 1);
    }
    const sortedFiles = node.files
      .slice()
      .sort((a, b) => (a.title || "").toLowerCase().localeCompare(
        (b.title || "").toLowerCase()
      ));
    for (const f of sortedFiles) {
      docPickerList.appendChild(_docPickerMakeFileRow(f, importedIds, depth));
    }
  }
  renderNode(tree, 0);
}

// v182: render one folder row. Layout: [▸/▾] [📁/📂] name (n) [tri-state cb].
// Click the row (anywhere outside the checkbox) → toggle expand.
// Click the checkbox → toggle all descendant files (mirrors VSCode's
// search "select all in folder" feel).
function _docPickerMakeFolderRow(node, depth, open) {
  const s = _docPickerState;
  const row = document.createElement("div");
  row.className = "doc-picker-folder";
  row.style.paddingLeft = `${depth * 16 + 6}px`;
  // Caret + folder icon.
  const caret = document.createElement("span");
  caret.className = "doc-picker-folder-caret";
  caret.textContent = open ? "▾" : "▸";
  caret.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "doc-picker-folder-icon";
  icon.textContent = open ? "📂" : "📁";
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "doc-picker-folder-name";
  name.textContent = node.name;
  // Descendant count for quick scan ("chapters/ (35)").
  const descendants = _docPickerCollectFiles(node);
  const count = document.createElement("span");
  count.className = "doc-picker-folder-count";
  count.textContent = `(${descendants.length})`;
  // Tri-state checkbox — checked if all descendants selected, mixed
  // if some, unchecked if none. Click toggles all of them.
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "doc-picker-folder-cb";
  const selectedDescendants = descendants.filter((f) => s.selected.has(f.id));
  if (selectedDescendants.length === 0) {
    cb.checked = false;
    cb.indeterminate = false;
  } else if (selectedDescendants.length === descendants.length) {
    cb.checked = true;
    cb.indeterminate = false;
  } else {
    cb.checked = false;
    cb.indeterminate = true;
  }
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    const turnOn = cb.checked;
    for (const f of descendants) {
      if (turnOn) s.selected.add(f.id);
      else s.selected.delete(f.id);
    }
    _docPickerUpdateSummary();
    _docPickerRender();
  });
  row.appendChild(caret);
  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(count);
  row.appendChild(cb);
  // Whole-row click toggles expand (except when the click started in
  // the checkbox — handled by stopPropagation above).
  row.addEventListener("click", () => {
    if (open) s.expandedFolders.delete(node.path);
    else s.expandedFolders.add(node.path);
    _docPickerRender();
  });
  return row;
}

function _docPickerUpdateSummary() {
  if (!_docPickerState) return;
  const s = _docPickerState;
  const items = s.items || [];
  const picked = items.filter((it) => s.selected.has(it.id));
  const n = picked.length;
  // Sum whichever metric the items carry. Mixed-shape lists shouldn't
  // happen within a single picker session, but fall back gracefully.
  const sumChars = picked.reduce((sum, it) => sum + (it.chars || 0), 0);
  const sumBytes = picked.reduce((sum, it) => sum + (it.size || 0), 0);
  const sizeStr = sumChars
    ? _docPickerFormatChars(sumChars)
    : sumBytes
    ? _docPickerFormatSize(sumBytes)
    : "";
  docPickerSummary.textContent = n
    ? `${n} selected${sizeStr ? ` · ~${sizeStr}` : ""}`
    : "";
  docPickerUse.disabled = n === 0;
  docPickerUse.textContent =
    n > 1
      ? (s.useLabelMulti && s.useLabelMulti(n)) || `Open as ${n}-chapter queue`
      : s.useLabelSingle || "Use selected";
  // v139: background toggle only makes sense for multi-pick (singles
  // bypass the queue entirely). Hide on 0/1 to avoid implying we'd
  // skip playback on a one-chapter load.
  docPickerBgLabel.hidden = n < 2;
}

function openDocumentPicker(config) {
  // Reset every render-driving piece of state. The dialog is reused
  // across sources, so leftover state from a previous open would leak
  // (stale items, stale filter, stale selected Set).
  _docPickerState = {
    items: Array.isArray(config.items) ? config.items : null,
    selected: new Set(),
    onUse: config.onUse || (async () => {}),
    emptyText: config.emptyText,
    noMatchText: config.noMatchText,
    useLabelSingle: config.useLabelSingle,
    useLabelMulti: config.useLabelMulti,
    // v176: caller-supplied predicate. Returns true if the item
    // should be flagged as "already imported" (library + queue
    // both count). When provided, the picker reveals the "Hide
    // already imported" toggle chip and shows ✓ badges + dim row
    // styling on each matching row.
    isImported: typeof config.isImported === "function" ? config.isImported : null,
    hideImported: false,
    // v182: VSCode-style tree rendering. Opt-in per caller. GitHub
    // turns it on because flat /path/to/chapter_03.md rows get unreadable
    // past ~30 files; Scrivener and Obsidian keep the flat list because
    // their items are already pre-grouped (chapter → scene) and a
    // second hierarchy would just nest.
    treeView: !!config.treeView,
    // Persistent expand state — survives re-renders triggered by
    // checkbox flips. Filter auto-expansion is computed per render
    // separately and doesn't mutate this Set.
    expandedFolders: new Set(),
  };
  docPickerTitle.textContent = config.title || "Pick items";
  docPickerMeta.textContent = config.meta || "";
  docPickerFilter.value = "";
  docPickerFilter.placeholder = config.filterPlaceholder || "Filter…";
  docPickerSummary.textContent = "";
  docPickerUse.disabled = true;
  docPickerUse.textContent = config.useLabelSingle || "Use selected";
  // v176: surface the hide-imported chip only when the caller can
  // tell us what's already imported. Reset its pressed state.
  if (docPickerHideImported) {
    const showChip = !!_docPickerState.isImported;
    docPickerHideImported.hidden = !showChip;
    docPickerHideImported.setAttribute("aria-pressed", "false");
  }
  // v179: reset branch picker + folder chips on every open. The
  // GitHub caller will fill them in via the returned handle once
  // /api/github/branches lands and the tree is parsed.
  if (docPickerBranchesRow) {
    docPickerBranchesRow.hidden = true;
    if (docPickerBranches) docPickerBranches.innerHTML = "";
  }
  if (docPickerFolderChips) {
    docPickerFolderChips.hidden = true;
    docPickerFolderChips.innerHTML = "";
  }
  // v139: reset background toggle on every open so a previously
  // ticked checkbox doesn't silently affect a fresh import.
  // v163: if the background queue is currently running, default the
  // checkbox to on so a quick-add round-trip ("+ Add more from
  // owner/repo") drops new picks straight into the queue instead
  // of forcing the user to remember to tick the box every time.
  // The label still hides until 2+ items are selected (see
  // _docPickerUpdateSummary), but the checked state is preserved.
  docPickerBgToggle.checked = !!_bgRunning;
  docPickerBgLabel.hidden = true;
  if (_docPickerState.items === null) {
    docPickerList.innerHTML = "";
  } else {
    _docPickerRender();
  }
  docPickerDialog.showModal();
  // Return a handle so the caller can mutate the dialog after open —
  // GitHub uses this to swap "Loading…" for the loaded file list (or
  // an error message) once /api/github/tree responds.
  return {
    setTitle(s) { docPickerTitle.textContent = s; },
    setMeta(s) { docPickerMeta.textContent = s; },
    setItems(arr) {
      if (!_docPickerState) return;
      _docPickerState.items = Array.isArray(arr) ? arr : [];
      _docPickerState.selected = new Set();
      _docPickerRender();
      _docPickerUpdateSummary();
    },
    // v179: populate the GitHub branch dropdown. `onChange` fires with
    // the new branch name when the user picks a different one — the
    // caller is responsible for re-fetching the tree on that branch.
    setBranches(list, current, onChange) {
      if (!docPickerBranchesRow || !docPickerBranches) return;
      if (!Array.isArray(list) || list.length === 0) {
        docPickerBranchesRow.hidden = true;
        return;
      }
      docPickerBranches.innerHTML = "";
      for (const name of list) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        if (name === current) opt.selected = true;
        docPickerBranches.appendChild(opt);
      }
      docPickerBranchesRow.hidden = false;
      docPickerBranches.onchange = () => {
        if (typeof onChange === "function") onChange(docPickerBranches.value);
      };
    },
    // v179: populate the auto-suggest folder chips. Each entry is
    // {label, prefix}. Clicking a chip writes the prefix into the
    // filter input + triggers a re-render.
    setFolderChips(chips) {
      if (!docPickerFolderChips) return;
      if (!Array.isArray(chips) || chips.length === 0) {
        docPickerFolderChips.hidden = true;
        docPickerFolderChips.innerHTML = "";
        return;
      }
      docPickerFolderChips.innerHTML = "";
      const label = document.createElement("span");
      label.className = "doc-picker-folder-chips-label";
      label.textContent = "Filter to:";
      docPickerFolderChips.appendChild(label);
      for (const c of chips) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "doc-picker-folder-chip";
        chip.textContent = c.label || c.prefix;
        chip.title = `Filter to files under ${c.prefix}`;
        chip.addEventListener("click", () => {
          // Toggle: if already filtered, clear; else apply.
          const current = (docPickerFilter.value || "").trim();
          if (current === c.prefix) {
            docPickerFilter.value = "";
            chip.classList.remove("active");
          } else {
            docPickerFilter.value = c.prefix;
            // Clear other active states so only one chip reads as on.
            docPickerFolderChips
              .querySelectorAll(".doc-picker-folder-chip.active")
              .forEach((el) => el.classList.remove("active"));
            chip.classList.add("active");
          }
          _docPickerRender();
        });
        docPickerFolderChips.appendChild(chip);
      }
      docPickerFolderChips.hidden = false;
    },
    close() { docPickerDialog.close(); },
  };
}

docPickerClose.addEventListener("click", () => docPickerDialog.close());
docPickerCancel.addEventListener("click", () => docPickerDialog.close());
docPickerFilter.addEventListener("input", _docPickerRender);
// v176: hide-imported chip toggle. Sets aria-pressed for the styling,
// flips _docPickerState.hideImported, re-renders.
if (docPickerHideImported) {
  docPickerHideImported.addEventListener("click", () => {
    if (!_docPickerState) return;
    _docPickerState.hideImported = !_docPickerState.hideImported;
    docPickerHideImported.setAttribute(
      "aria-pressed",
      _docPickerState.hideImported ? "true" : "false"
    );
    _docPickerRender();
  });
}

docPickerUse.addEventListener("click", async () => {
  if (!_docPickerState || _docPickerState.selected.size === 0) return;
  const s = _docPickerState;
  const picked = (s.items || []).filter((it) => s.selected.has(it.id));
  // v139: background mode only kicks in for multi-pick imports — a
  // single-clip load goes straight to the textarea, not a queue.
  const background = docPickerBgToggle.checked && picked.length > 1;
  // Close first so the caller can drive status updates in the UI
  // without competing with the dialog (e.g. "Fetching 1 of 5…").
  docPickerDialog.close();
  try {
    await s.onUse(picked, { background });
  } catch (err) {
    console.error("[doc-picker] onUse failed:", err);
    setStatus(`Failed: ${err.message || err}`, true);
  }
});

// ---- GitHub repo browser (uses shared document picker) ----------------
// openGithubBrowser opens the shared picker immediately with a
// "Loading…" placeholder, calls /api/github/tree, then either fills
// the picker with the file list or shows the error in the meta line.
// The Use callback fetches the selected file(s) via /api/extract/url
// (single = textarea; multi = chapter queue), threading the per-file
// SHA so the extract endpoint can skip an extra contents-API call.

async function openGithubBrowser(repoUrl) {
  // v176: build the "already imported" lookup ahead of opening the
  // picker. We don't know the canonical repoUrl until /api/github/tree
  // resolves (it might normalize the URL), so we collect both:
  //  - paths from clips whose gitRef.repoUrl matches this exact input
  //    URL (most common after a re-open of a previously-imported repo)
  //  - paths from bg queue items with a matching gitRef.repoUrl
  // The actual isImported callback below uses these sets; we refresh
  // them again after the tree call lands (closure mutation) so the
  // canonical URL also matches.
  const importedPaths = new Set();
  const pathsFromUrl = (url) => {
    if (!url) return;
    for (const j of _chapterQueue) {
      if (j && j.gitRef && j.gitRef.repoUrl === url && j.gitRef.path) {
        importedPaths.add(j.gitRef.path);
      }
    }
  };
  try {
    const allClips = await listClips();
    for (const c of allClips) {
      if (c.gitRef && c.gitRef.repoUrl === repoUrl && c.gitRef.path) {
        importedPaths.add(c.gitRef.path);
      }
    }
  } catch {}
  pathsFromUrl(repoUrl);

  const picker = openDocumentPicker({
    title: "Browse GitHub repo",
    meta: "Loading…",
    items: null,
    filterPlaceholder: "Filter by path…",
    emptyText: "No text-format files found in this repo.",
    noMatchText: "No matching files.",
    // v176: predicate the picker uses for ✓ badge + dim + the
    // "Hide already imported" filter chip. extra.path is the
    // GitHub-side file path.
    isImported: (item) => {
      const p = item && item.extra && item.extra.path;
      return p ? importedPaths.has(p) : false;
    },
    // v182: VSCode-style folder hierarchy. Big repos (185+ files in
    // the screenshot) get unreadable as a flat list — group by folder,
    // collapse by default, filter auto-expands matches.
    treeView: true,
    onUse: async (picked, opts = {}) => {
      // Items carry the raw GitHub file objects in `extra`. Build the
      // raw.githubusercontent URLs and a path→sha lookup for the
      // extract endpoint.
      const token = getGithubToken();
      const buildUrl = (path) =>
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${encodeURI(path)}`;
      hideUrlRow();

      if (picked.length === 1) {
        const f = picked[0].extra;
        setStatus(`Fetching ${f.path}…`);
        try {
          const res = await fetch("/api/extract/url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: buildUrl(f.path),
              github_token: token || undefined,
              git_sha: f.sha || undefined,
            }),
          });
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
            throw new Error(detail);
          }
          const data = await res.json();
          exitReadingView();
          textEl.value = data.text || "";
          _pendingImages = Array.isArray(data.images) ? data.images : [];
          _pendingGitRef = data.gitRef || null;
          updateCounts();
          _checkForChapters();
          setStatus(`Loaded ${f.path} · ${(data.chars || 0).toLocaleString()} chars · ready to Generate`);
          textEl.focus();
        } catch (err) {
          setStatus(`Fetch failed: ${err.message}`, true);
        }
        return;
      }

      setStatus(`Fetching ${picked.length} files…`);
      _dlog("github", `multi-fetch start: ${picked.length} files`, {
        owner: gh.owner, repo: gh.repo, branch: gh.branch,
        paths: picked.map((p) => p.extra && p.extra.path).filter(Boolean),
      });
      const chapters = [];
      const skipped = []; // {path, reason} for the post-loop summary
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i].extra;
        setStatus(`Fetching ${i + 1} of ${picked.length}: ${f.path}…`);
        _dlog("github", `fetch [${i + 1}/${picked.length}] ${f.path}`, {
          sha: f.sha, size: f.size,
        });
        try {
          const res = await fetch("/api/extract/url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: buildUrl(f.path),
              github_token: token || undefined,
              git_sha: f.sha || undefined,
            }),
          });
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
              const j = await res.json();
              if (j && j.detail) detail += ` — ${j.detail}`;
            } catch {}
            _dlog("github", `SKIP ${f.path}: ${detail}`, { status: res.status });
            skipped.push({ path: f.path, reason: detail });
            console.warn(`[github] skipping ${f.path}: ${detail}`);
            continue;
          }
          const data = await res.json();
          const rawText = data.text || "";
          const cleanText = rawText.trim();
          // v177: empty-text guard. Some files (TOC.md, image-only
          // chapters, all-frontmatter, etc.) return empty text after
          // trafilatura strips boilerplate. Pushing an empty-text
          // chapter into the queue guarantees a downstream synthesis
          // failure ("no audio in result") with a useless error in
          // the failures banner. Catch it here so the user sees a
          // specific "empty content" reason and the synth path never
          // runs.
          if (!cleanText) {
            _dlog(
              "github",
              `SKIP ${f.path}: empty text after extract`,
              {
                rawChars: rawText.length,
                cleanChars: 0,
                images: Array.isArray(data.images) ? data.images.length : 0,
              }
            );
            skipped.push({ path: f.path, reason: "empty after extract" });
            continue;
          }
          const title = f.path.split("/").pop().replace(/\.[^.]+$/, "");
          _dlog("github", `OK ${f.path}`, {
            title,
            chars: cleanText.length,
            sha: (data.gitRef && data.gitRef.sha) || f.sha || null,
            images: Array.isArray(data.images) ? data.images.length : 0,
          });
          chapters.push({
            title,
            text: cleanText,
            gitRef: data.gitRef || null,
          });
        } catch (err) {
          _dlog("github", `THROW ${f.path}: ${err.message}`, {
            errName: err.name, stack: err.stack,
          });
          skipped.push({ path: f.path, reason: err.message });
          console.warn(`[github] skipping ${f.path}: ${err.message}`);
        }
      }
      _dlog("github", `multi-fetch done`, {
        ok: chapters.length, skipped: skipped.length, skips: skipped,
      });
      if (chapters.length === 0) {
        const tail = skipped.length
          ? ` (${skipped.length} skipped — see Settings → View debug log)`
          : "";
        setStatus(`No files could be fetched.${tail}`, true);
        return;
      }
      if (skipped.length) {
        // Non-fatal: some files made it through. Quick toast so the
        // user notices the gap; the debug log has per-file detail.
        setStatus(
          `${chapters.length} fetched, ${skipped.length} skipped — see Settings → View debug log`
        );
      }
      if (chapters.length === 1) {
        exitReadingView();
        textEl.value = chapters[0].text;
        _pendingChapterTitle = chapters[0].title;
        _pendingImages = [];
        _pendingGitRef = null;
        updateCounts();
        _checkForChapters();
        setStatus(`Loaded ${chapters[0].title} · ready to Generate`);
        return;
      }
      // v139: background mode runs synthesis silently — chapters land
      // in the library without ever loading into the player. Ideal
      // for unattended overnight imports.
      if (opts.background) {
        _startBackgroundChapterQueue(chapters);
      } else {
        _startChapterQueue(chapters);
      }
    },
  });

  // Stash owner/repo/branch for the Use callback. Closure captures the
  // mutable handle, but we still need the response data after fetch.
  let gh = { owner: "", repo: "", branch: "" };
  try {
    const token = getGithubToken();
    const branch = _githubBranchFromUrl(repoUrl);
    const res = await fetch("/api/github/tree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: repoUrl,
        branch: branch || undefined,
        github_token: token || undefined,
      }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }
    const data = await res.json();
    gh = { owner: data.owner, repo: data.repo, branch: data.branch };
    // v163 / v176: remember this repo on the recents list so the user
    // can re-open it with one click — chip rows above the URL field
    // and in the queue panel footer surface up to RECENT_REPOS_MAX
    // entries, most-recent-first.
    _pushRecentGithubRepo({
      url: repoUrl,
      owner: data.owner,
      repo: data.repo,
      branch: data.branch,
    });
    // v176: refresh the imported-paths set against the canonical URL
    // returned by /api/github/tree. clip.gitRef.repoUrl could have
    // been written by an older path that normalized differently
    // (trailing slash, .git suffix, www subdomain).
    try {
      const allClips = await listClips();
      for (const c of allClips) {
        if (
          c.gitRef &&
          c.gitRef.path &&
          (c.gitRef.repoUrl === repoUrl ||
            (data.owner &&
              data.repo &&
              c.gitRef.repoUrl &&
              c.gitRef.repoUrl.toLowerCase().includes(
                `${data.owner.toLowerCase()}/${data.repo.toLowerCase()}`
              )))
        ) {
          importedPaths.add(c.gitRef.path);
        }
      }
    } catch {}
    for (const j of _chapterQueue) {
      if (
        j &&
        j.gitRef &&
        j.gitRef.path &&
        j.gitRef.repoUrl &&
        data.owner &&
        data.repo &&
        j.gitRef.repoUrl.toLowerCase().includes(
          `${data.owner.toLowerCase()}/${data.repo.toLowerCase()}`
        )
      ) {
        importedPaths.add(j.gitRef.path);
      }
    }
    const files = Array.isArray(data.files) ? data.files : [];
    picker.setTitle(`${data.owner}/${data.repo}`);
    const truncatedHint = data.truncated
      ? " · ⚠ tree truncated by GitHub (large repo)"
      : "";
    const importedCount = files.reduce(
      (n, f) => n + (importedPaths.has(f.path) ? 1 : 0),
      0
    );
    const importedNote = importedCount > 0
      ? ` · ${importedCount} already imported`
      : "";
    picker.setMeta(
      `branch: ${data.branch} · ${files.length} text files${truncatedHint}${importedNote}`
    );
    picker.setItems(
      files.map((f) => ({
        id: f.path,
        title: f.path,
        size: f.size,
        extra: f,
      }))
    );
    // v179: detect common manuscript folders so the picker can offer
    // one-click filter chips. Looks for paths that share a top-level
    // segment (chapters/, manuscript/, src/, etc.) with >=3 files.
    // Skips suggestions when the whole repo lives under one folder
    // (no point offering a filter that doesn't filter anything).
    if (typeof picker.setFolderChips === "function") {
      const chips = _suggestFolderChips(files);
      picker.setFolderChips(chips);
    }
    // v179: fetch branches in parallel with rendering. Failure is
    // non-fatal — the picker still works on the resolved branch.
    if (typeof picker.setBranches === "function") {
      try {
        const bRes = await fetch("/api/github/branches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: repoUrl,
            github_token: token || undefined,
          }),
        });
        if (bRes.ok) {
          const bData = await bRes.json();
          picker.setBranches(
            bData.branches || [],
            data.branch,
            (newBranch) => {
              if (!newBranch || newBranch === data.branch) return;
              // Re-open the picker for the same repo on the new
              // branch. openGithubBrowser builds the /tree/<branch>
              // URL by parsing the URL, so we need to inject the
              // branch in the URL form GitHub expects.
              const swapped = _withGithubBranch(repoUrl, newBranch);
              picker.close();
              openGithubBrowser(swapped);
            }
          );
        } else {
          _dlog("github", "branches fetch failed", { status: bRes.status });
        }
      } catch (err) {
        _dlog("github", `branches fetch threw: ${err.message}`, {});
      }
    }
  } catch (err) {
    picker.setMeta(`Failed: ${err.message}`);
    picker.setItems([]);
  }
}

// v179: walk the GitHub tree and surface common manuscript folders
// as suggested filters. A "chip-worthy" folder is one that:
//   - has at least 3 files under it (otherwise the filter is noise)
//   - isn't the only folder in the repo (filtering everything ≠ filtering)
//   - has a known manuscript-y name OR happens to be the densest folder
// Returns an array of {label, prefix} ready for picker.setFolderChips.
function _suggestFolderChips(files) {
  if (!Array.isArray(files) || files.length < 3) return [];
  // Tally files per top-level folder.
  const counts = new Map();
  let rootCount = 0;
  for (const f of files) {
    const slash = (f.path || "").indexOf("/");
    if (slash < 0) {
      rootCount++;
    } else {
      const top = f.path.slice(0, slash);
      counts.set(top, (counts.get(top) || 0) + 1);
    }
  }
  // If everything is at the root, or all files live in one folder,
  // a folder filter doesn't help — bail out.
  if (counts.size === 0) return [];
  if (counts.size === 1 && rootCount === 0) return [];

  // Folder names common in manuscripts and dev repos that host books.
  const FAVORED = new Set([
    "chapters", "chapter", "manuscript", "manuscripts", "src", "content",
    "book", "books", "novel", "novels", "drafts", "draft", "posts",
    "essays", "writing", "writings", "docs", "doc", "pages", "story",
  ]);

  // Build the chip list: favored folders (with >=3 files) first,
  // then the single densest non-favored folder as a fallback —
  // capped at 3 chips total so the row doesn't bloat.
  const chips = [];
  for (const [name, n] of counts.entries()) {
    if (n >= 3 && FAVORED.has(name.toLowerCase())) {
      chips.push({ label: `${name}/`, prefix: `${name}/`, count: n });
    }
  }
  if (chips.length === 0) {
    // No favored match — surface the densest folder if it covers
    // a meaningful fraction of the tree.
    let best = null;
    for (const [name, n] of counts.entries()) {
      if (n < 3) continue;
      if (!best || n > best.count) best = { name, count: n };
    }
    if (best && best.count >= Math.max(3, files.length * 0.3)) {
      chips.push({ label: `${best.name}/`, prefix: `${best.name}/`, count: best.count });
    }
  }
  chips.sort((a, b) => b.count - a.count);
  return chips.slice(0, 3).map(({ label, prefix }) => ({ label, prefix }));
}

// v179: swap the branch segment in a github.com URL so the recents
// list / picker can re-open the same repo on a different branch
// without the user re-typing. Accepts both the repo-root form
// (github.com/owner/repo) and the tree form
// (github.com/owner/repo/tree/<branch>/...) — returns the tree form.
function _withGithubBranch(url, branch) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("github.com")) return url;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return url;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    // Drop any existing /tree/<branch>/... suffix; we'll rebuild it.
    u.pathname = `/${owner}/${repo}/tree/${encodeURIComponent(branch)}`;
    return u.toString();
  } catch {
    return url;
  }
}

// v181: open the shared picker on a Gist's file list.
//
// Single-file gists short-circuit: we fetch the file content directly
// via /api/extract/url with the raw_url + skip the picker.
//
// Multi-file gists open the picker. Selecting one file loads it into
// the textarea (same as the GitHub single-pick path); selecting
// multiple files queues them as a multi-chapter import.
async function openGistBrowser(gistUrl) {
  hideUrlRow();
  setStatus(`Fetching Gist…`);
  const token = getGithubToken();
  let meta;
  try {
    const res = await fetch("/api/gist/meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: gistUrl,
        github_token: token || undefined,
      }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
      throw new Error(detail);
    }
    meta = await res.json();
  } catch (err) {
    _dlog && _dlog("gist", `meta fetch failed: ${err.message}`, {});
    setStatus(`Gist fetch failed: ${err.message}`, true);
    return;
  }
  const files = Array.isArray(meta.files) ? meta.files : [];
  if (files.length === 0) {
    setStatus("This Gist has no files.", true);
    return;
  }

  // Single-file gist: route straight to the textarea via the existing
  // URL extractor on the file's raw URL. The picker would just be one
  // extra click for no win.
  if (files.length === 1) {
    const f = files[0];
    setStatus(`Loading ${f.filename}…`);
    try {
      const res = await fetch("/api/extract/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: f.raw_url,
          github_token: token || undefined,
        }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
        throw new Error(detail);
      }
      const data = await res.json();
      exitReadingView();
      textEl.value = data.text || "";
      _pendingImages = Array.isArray(data.images) ? data.images : [];
      _pendingGitRef = null; // Gist files don't have a gitRef we can sync against
      _pendingChapterTitle = f.filename.replace(/\.[^.]+$/, "");
      updateCounts();
      _checkForChapters();
      setStatus(
        `Loaded ${f.filename} · ${(data.chars || 0).toLocaleString()} chars · ready to Generate`
      );
      textEl.focus();
    } catch (err) {
      _dlog && _dlog("gist", `single-file fetch failed: ${err.message}`, {
        filename: f.filename,
      });
      setStatus(`Gist fetch failed: ${err.message}`, true);
    }
    return;
  }

  // Multi-file: open the picker. Each file becomes a candidate
  // chapter in the picker; on Use, we fetch each file's raw_url via
  // /api/extract/url and feed the resulting chapters to the queue.
  const title = meta.owner
    ? `Gist by @${meta.owner}`
    : "GitHub Gist";
  const picker = openDocumentPicker({
    title,
    meta: meta.description || `${files.length} files`,
    items: files.map((f) => ({
      id: f.filename,
      title: f.filename,
      subtitle: f.language || f.type || "",
      size: f.size,
      extra: f,
    })),
    filterPlaceholder: "Filter by filename…",
    emptyText: "No files in this gist.",
    noMatchText: "No matching files.",
    onUse: async (picked, opts = {}) => {
      if (picked.length === 1) {
        const f = picked[0].extra;
        setStatus(`Loading ${f.filename}…`);
        try {
          const res = await fetch("/api/extract/url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: f.raw_url,
              github_token: token || undefined,
            }),
          });
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { const j = await res.json(); if (j.detail) detail = j.detail; } catch {}
            throw new Error(detail);
          }
          const data = await res.json();
          exitReadingView();
          textEl.value = data.text || "";
          _pendingImages = Array.isArray(data.images) ? data.images : [];
          _pendingGitRef = null;
          _pendingChapterTitle = f.filename.replace(/\.[^.]+$/, "");
          updateCounts();
          _checkForChapters();
          setStatus(`Loaded ${f.filename} · ready to Generate`);
        } catch (err) {
          setStatus(`Gist fetch failed: ${err.message}`, true);
        }
        return;
      }
      setStatus(`Fetching ${picked.length} files…`);
      const chapters = [];
      const skipped = [];
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i].extra;
        setStatus(`Fetching ${i + 1} of ${picked.length}: ${f.filename}…`);
        try {
          const res = await fetch("/api/extract/url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: f.raw_url,
              github_token: token || undefined,
            }),
          });
          if (!res.ok) {
            skipped.push({ filename: f.filename, reason: `HTTP ${res.status}` });
            continue;
          }
          const data = await res.json();
          const clean = (data.text || "").trim();
          // Same empty-text guard as the GitHub multi-fetch path.
          if (!clean) {
            skipped.push({ filename: f.filename, reason: "empty after extract" });
            continue;
          }
          chapters.push({
            title: f.filename.replace(/\.[^.]+$/, ""),
            text: clean,
          });
        } catch (err) {
          skipped.push({ filename: f.filename, reason: err.message });
        }
      }
      if (chapters.length === 0) {
        const tail = skipped.length
          ? ` (${skipped.length} skipped — see Settings → View debug log)`
          : "";
        setStatus(`No files could be loaded.${tail}`, true);
        return;
      }
      if (skipped.length) {
        setStatus(
          `${chapters.length} fetched, ${skipped.length} skipped — see Settings → View debug log`
        );
        _dlog && _dlog("gist", "multi-fetch done with skips", {
          ok: chapters.length, skipped,
        });
      }
      if (opts.background) {
        _startBackgroundChapterQueue(chapters);
      } else {
        _startChapterQueue(chapters);
      }
    },
  });
}

// ---- Scrivener browser (uses shared document picker) ------------------
// Opened by the upload handler when the user picks a .zip file and
// the backend detects it's a Scrivener bundle. Chapters are already
// parsed in-memory by /api/extract/scrivener — the picker just hands
// the selected chapters off to the textarea (single) or chapter
// queue (multi). No gitRef because Scrivener bundles aren't sync-
// checkable (file-system-only, no remote SHA).

function openScrivenerBrowser(data) {
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const skippedHint = skipped.length
    ? ` · ${skipped.length} skipped (Research/Trash/empty)`
    : "";
  openDocumentPicker({
    title: data.project_name || "Scrivener project",
    meta: `${chapters.length} chapter${chapters.length === 1 ? "" : "s"} found${skippedHint}`,
    filterPlaceholder: "Filter by title or folder…",
    emptyText: "No chapters in this project.",
    noMatchText: "No matching chapters.",
    items: chapters.map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.path || "",
      chars: c.chars,
      extra: c,
    })),
    onUse: async (picked, opts = {}) => {
      if (picked.length === 1) {
        const ch = picked[0].extra;
        exitReadingView();
        textEl.value = ch.text;
        _pendingChapterTitle = ch.title;
        _pendingImages = [];
        _pendingGitRef = null;
        updateCounts();
        _checkForChapters();
        setStatus(`Loaded ${ch.title} · ready to Generate`);
        return;
      }
      const chapters = picked.map((p) => ({
        title: p.extra.title,
        text: p.extra.text,
      }));
      if (opts.background) {
        _startBackgroundChapterQueue(chapters);
      } else {
        _startChapterQueue(chapters);
      }
    },
  });
}

// ---- Obsidian vault browser (uses shared document picker) -------------
// Backend already filtered out .obsidian/, templates/, attachments/, etc.
// and stripped wikilinks + embeds from the body. The picker just lets
// the user choose which notes to import as chapters.

function openObsidianBrowser(data) {
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const skippedHint = skipped.length
    ? ` · ${skipped.length} skipped (.obsidian/templates/empty)`
    : "";
  openDocumentPicker({
    title: data.vault_name || "Obsidian vault",
    meta: `${chapters.length} note${chapters.length === 1 ? "" : "s"} found${skippedHint}`,
    filterPlaceholder: "Filter by title or folder…",
    emptyText: "No notes in this vault.",
    noMatchText: "No matching notes.",
    items: chapters.map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.path || "",
      chars: c.chars,
      extra: c,
    })),
    onUse: async (picked, opts = {}) => {
      if (picked.length === 1) {
        const ch = picked[0].extra;
        exitReadingView();
        textEl.value = ch.text;
        _pendingChapterTitle = ch.title;
        _pendingImages = [];
        _pendingGitRef = null;
        updateCounts();
        _checkForChapters();
        setStatus(`Loaded ${ch.title} · ready to Generate`);
        return;
      }
      const chapters = picked.map((p) => ({
        title: p.extra.title,
        text: p.extra.text,
      }));
      if (opts.background) {
        _startBackgroundChapterQueue(chapters);
      } else {
        _startChapterQueue(chapters);
      }
    },
  });
}

// Deep-link from the manual: visiting "/?prefillUrl=https%3A%2F%2F..."
// (optionally with "&autofetch=1") opens the URL row, pre-fills the
// input, and — when autofetch is set — runs the fetch immediately so
// a tester can click a sample URL in the manual and land on a loaded
// article one click later.
(function _handlePrefillUrlFromQuery() {
  try {
    const params = new URLSearchParams(location.search);
    const u = params.get("prefillUrl");
    if (!u) return;
    showUrlRow();
    urlInput.value = u;
    const auto = params.get("autofetch") === "1";
    // Strip the query param so a reload doesn't re-trigger the fetch
    // (the user expects reload to start fresh, not re-grab the same
    // article).
    history.replaceState(null, "", location.pathname);
    if (auto) {
      // Defer so the existing setStatus / busy-state UI has time to
      // render before the fetch's "Fetching…" status overwrites it.
      setTimeout(() => fetchFromUrl(), 50);
    }
  } catch {}
})();

// True if a URL points at a GitHub repo view that should open the file
// browser (rather than fetching the URL's HTML page). Covers:
//   - github.com/owner/repo                          → default branch
//   - github.com/owner/repo/tree/main                → explicit branch
//   - github.com/owner/repo/tree/main/folder         → folder view
// Excluded: blob/ raw/ are specific files (Level 1 fetches those);
// commit/ issues/ pull/ releases/ wiki/ aren't manuscripts.
function _isGithubRepoRoot(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      return false;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return false;
    if (parts.length === 2) return true; // owner/repo
    const verb = parts[2];
    if (verb === "tree") return true; // branch / folder view
    return false;
  } catch {
    return false;
  }
}

// v142: graceful normalization for github URLs the user might
// reasonably paste but that aren't a repo root — most commonly a
// /blob/<branch>/<path> URL to a specific chapter file. Returns
// {rootUrl, original, kind} when the input is a github URL we can
// strip back to a browseable repo, null otherwise. kind is one of
// "root" (already a root or tree URL — no correction needed),
// "file" (/blob/ — stripped to owner/repo), or "other" (issues /
// pulls / commits / etc — also stripped to owner/repo).
function _normalizeGithubUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      return null;
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    const rootUrl = `https://github.com/${owner}/${repo}`;
    if (parts.length === 2) {
      return { rootUrl, original: url, kind: "root" };
    }
    const verb = parts[2];
    if (verb === "tree") {
      // owner/repo/tree/<branch>[/<path>] — _isGithubRepoRoot already
      // routes this directly; surface as "root" so we don't show a
      // correction message for a URL that was always going to work.
      return { rootUrl: url, original: url, kind: "root" };
    }
    if (verb === "blob") {
      return { rootUrl, original: url, kind: "file" };
    }
    // /issues, /pulls, /commits, /actions, /wiki, /releases, etc.
    return { rootUrl, original: url, kind: "other" };
  } catch {
    return null;
  }
}


// Extract the branch name from a /tree/<branch>/ URL. Returns null if
// the URL doesn't carry a branch (we'll let the server look up the
// repo's default).
function _githubBranchFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "tree") {
      return parts[3];
    }
  } catch {}
  return null;
}

async function fetchFromUrl() {
  const url = (urlInput.value || "").trim();
  if (!url) return;
  // v181: Gist URLs go through a separate flow. /api/gist/meta returns
  // the file list; single-file gists land in the textarea directly,
  // multi-file gists open the picker so the user can choose which
  // files become chapters.
  if (_isGistUrl(url)) {
    openGistBrowser(url);
    return;
  }
  // GitHub repo root URLs → open the file browser instead of fetching
  // the landing page (which trafilatura would extract as marketing
  // chrome, not as a manuscript).
  if (_isGithubRepoRoot(url)) {
    openGithubBrowser(url);
    return;
  }
  // v142: graceful fallback for "wrong-shape" github URLs the user
  // might paste — a /blob/ file URL, a /pull/ link, etc. Instead of
  // letting it slide through to trafilatura (which silently fails on
  // most of those), strip to the repo root and tell the user what
  // we did so they understand the picker that just opened.
  const gh = _normalizeGithubUrl(url);
  if (gh && gh.kind !== "root") {
    if (gh.kind === "file") {
      setStatus(
        "That looked like a link to a specific file. Opening the repo's chapter picker instead — tick the chapter(s) you want.",
      );
    } else {
      setStatus(
        "Opening the repo's chapter picker — paste the repo root URL next time to skip this step.",
      );
    }
    openGithubBrowser(gh.rootUrl);
    return;
  }
  urlInput.disabled = true;
  urlFetchBtn.disabled = true;
  urlFetchBtn.textContent = "Fetching…";
  // Show the bare hostname while we wait so the user knows we're hitting
  // the right place (and not eg. truncating their URL).
  let host = url;
  try {
    host = new URL(url).hostname || url;
  } catch {}
  setStatus(`Fetching ${host}…`);

  try {
    // Attach a GitHub PAT only when the URL is a GitHub URL. The token
    // lives in localStorage; the backend further restricts forwarding
    // to github.com / raw.githubusercontent.com so a stale token can't
    // leak to other hosts via a redirect.
    const body = { url };
    if (_isGithubUrl(url)) {
      const token = getGithubToken();
      if (token) body.github_token = token;
    }
    const res = await fetch("/api/extract/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }
    const data = await res.json();

    // Same shape as the file-upload path — keep behavior aligned.
    exitReadingView();
    textEl.value = data.text || "";
    // Stash any images the server pulled out of the URL. They survive
    // until the next generate() saves them onto the clip (or until the
    // user hits Clear, which wipes them).
    _pendingImages = Array.isArray(data.images) ? data.images : [];
    // GitHub-sourced URLs come back with gitRef; stash so the next
    // generate() pins it onto the saved clip.
    _pendingGitRef = data.gitRef || null;
    updateCounts();
    _checkForChapters();

    hideUrlRow();
    const chars = (data.chars || 0).toLocaleString();
    setStatus(`Loaded ${data.filename} · ${chars} chars · ready to Generate`);
    textEl.focus();
  } catch (err) {
    setStatus(`Fetch failed: ${err.message}`, true);
  } finally {
    urlInput.disabled = false;
    urlFetchBtn.disabled = false;
    urlFetchBtn.textContent = "Fetch";
  }
}


uploadInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // Single-document upload path (txt/md/pdf/epub/docx). The accept
  // filter on #upload-input excludes .zip — Scrivener and Obsidian
  // each have their own input behind dedicated Import menu items.
  setStatus(`Reading ${file.name}…`);

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/extract", { method: "POST", body: formData });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }
    const data = await res.json();

    // Leave reading view if we were in it — uploading is an edit action.
    exitReadingView();
    textEl.value = data.text || "";
    updateCounts();
    _checkForChapters();

    const chars = (data.chars || 0).toLocaleString();
    setStatus(`Loaded ${data.filename} · ${chars} chars · ready to Generate`);
    textEl.focus();
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`, true);
  } finally {
    // Reset so picking the same file again still fires "change".
    uploadInput.value = "";
  }
});

renderLibrary();

function currentSentenceIndex(time) {
  // Binary search for largest index i with sentenceOffsetsSec[i] <= time.
  if (!sentenceOffsetsSec.length) return -1;
  let lo = 0;
  let hi = sentenceOffsetsSec.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentenceOffsetsSec[mid] <= time + 1e-3) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function seekToSentence(i) {
  // Streaming mode: jump to a sentence inside the per-sentence queue. Each
  // sentence is its own audio source, so we have to re-point player.src and
  // rebuild _streamElapsed (the cumulative duration of all earlier sentences)
  // so virtualTime() stays consistent.
  if (
    _streamPlayhead >= 0 &&
    i >= 0 &&
    i < _streamQueue.length &&
    _streamQueue[i].url
  ) {
    let elapsed = 0;
    for (let k = 0; k < i; k++) elapsed += _streamQueue[k].durationSec || 0;
    _streamElapsed = elapsed;
    _streamPlayhead = i - 1; // startNextStreamSentence pre-increments
    startNextStreamSentence();
    return;
  }

  // Post-swap (combined WAV) mode: just move currentTime.
  if (i < 0) {
    playerEl.currentTime = 0;
    return;
  }
  if (i >= sentenceOffsetsSec.length) {
    if (isFinite(playerEl.duration)) playerEl.currentTime = playerEl.duration;
    return;
  }
  playerEl.currentTime = sentenceOffsetsSec[i];
}

function setMediaMetadata(text) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: makeTitle(text),
    artist: "Narrative",
    album: "Local TTS",
    artwork: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const safeSet = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Browser doesn't support this action — ignore.
    }
  };

  safeSet("play", () => playerEl.play());
  // Lock-screen / Bluetooth pause is a user action — flag it so the
  // pause handler doesn't mistake it for an OS interrupt just because
  // the tab is in the background.
  safeSet("pause", () => _pauseAsUser());
  safeSet("stop", () => {
    _pauseAsUser();
    playerEl.currentTime = 0;
  });

  // Sentence-skip handlers shared between prev/next track and seek buttons.
  // iOS displays prev/next track buttons on the lock screen / Control Center
  // by default; Android may show either set; desktop media keys typically
  // map to prev/next. Registering both ensures the buttons appear regardless
  // of platform choice, and they all run the same sentence-jump logic.
  const backHandler = (details = {}) => {
    if (sentenceOffsetsSec.length) {
      const vt = virtualTime();
      const idx = currentSentenceIndex(vt);
      const sentenceStart = sentenceOffsetsSec[idx] ?? 0;
      // Podcast-app behavior: if you're past the first second of a sentence,
      // restart it; otherwise jump to the previous sentence.
      if (vt - sentenceStart > 1.0) {
        seekToSentence(idx);
      } else {
        seekToSentence(idx - 1);
      }
      return;
    }
    const skip = details.seekOffset || 10;
    playerEl.currentTime = Math.max(0, playerEl.currentTime - skip);
  };
  const forwardHandler = (details = {}) => {
    if (sentenceOffsetsSec.length) {
      const idx = currentSentenceIndex(virtualTime());
      seekToSentence(idx + 1);
      return;
    }
    const skip = details.seekOffset || 10;
    const dur = isFinite(playerEl.duration) ? playerEl.duration : Infinity;
    playerEl.currentTime = Math.min(dur, playerEl.currentTime + skip);
  };
  safeSet("previoustrack", backHandler);
  safeSet("nexttrack", forwardHandler);
  safeSet("seekbackward", backHandler);
  safeSet("seekforward", forwardHandler);
  safeSet("seekto", (details) => {
    if (details.fastSeek && "fastSeek" in playerEl) {
      playerEl.fastSeek(details.seekTime);
      return;
    }
    playerEl.currentTime = details.seekTime;
  });

  playerEl.addEventListener("play", () => {
    navigator.mediaSession.playbackState = "playing";
  });
  playerEl.addEventListener("pause", () => {
    navigator.mediaSession.playbackState = "paused";
    // Pause is the most important resume checkpoint — save immediately so
    // closing the tab right after pausing still leaves a usable bookmark.
    maybeSaveProgress(true);
  });
  playerEl.addEventListener("ended", async () => {
    // While streaming, "ended" just means the current sentence's blob
    // finished — chain to the next queued sentence instead of stopping.
    if (_streamPlayhead >= 0) {
      const cur = _streamQueue[_streamPlayhead];
      _streamElapsed += (cur && cur.durationSec) || playerEl.duration || 0;
      if (_streamPlayhead + 1 < _streamQueue.length) {
        startNextStreamSentence();
        return;
      }
      // Streaming queue exhausted — user has heard every per-sentence
      // WAV. Mark "audio side" complete. If save already landed,
      // _tryAdvanceQueue fires the 4-second breath; if save lands
      // later, IT will fire the breath. Either ordering works.
      // v165: also skip when a background queue is running — the
      // background pipeline doesn't play anything, so any "audio
      // ended" signal here belongs to a foreground clip the user
      // started manually and must not poke the chapter queue.
      if (_chapterTotalCount > 0 && !_silentChapterQueue) {
        _queueAudioComplete = true;
        _tryAdvanceQueue();
      }
      // Queue exhausted; the next sentence event (or the final swap to the
      // combined WAV) will resume playback.
      return;
    }
    navigator.mediaSession.playbackState = "none";
    // Clip is done — clear its resume position so the next play starts
    // from the beginning (and the card stops showing "1:23 / 5:00").
    const justEndedId = _currentClipId;
    await markCurrentClipPlayed();

    // Chapter queue: combined MP3 just finished playing. Mark the
    // audio side complete and try to advance. If save .then() already
    // fired (the common case for long chapters that finished synth
    // well before playback), _tryAdvanceQueue schedules the breath
    // and we return so library auto-advance doesn't compete. If save
    // hasn't fired yet, the audio flag waits; when save eventually
    // sets _queueSaveComplete, the advance fires from there.
    // v165: only fire when a FOREGROUND queue is active. A
    // background queue (_silentChapterQueue) doesn't play anything
    // through this audio element — if we hit this branch with the
    // background flag set, the user just played a saved clip from
    // the library and we must leave the background queue alone.
    if (_chapterTotalCount > 0 && !_silentChapterQueue) {
      _queueAudioComplete = true;
      _tryAdvanceQueue();
      // Suppress library auto-advance while a chapter queue is active
      // regardless of whether _tryAdvanceQueue actually scheduled the
      // advance this tick (save might still be pending).
      return;
    }

    // End-of-clip sleep mode (the no-queue equivalent of end-of-chapter):
    // the clip just finished, and we were asked to stop at the next
    // boundary. Don't queue up an auto-advance — _onSleepBoundaryReached
    // resets the sleep state and tells the listener.
    if (_sleepEndOfChapter && _chapterTotalCount <= 0) {
      _onSleepBoundaryReached("clip");
      return;
    }

    // Auto-advance to the next clip in the library according to _playMode.
    // Give the listener a 3-second breath between chapters so transitions
    // don't slam together — your ear needs a beat to register a chapter
    // change. Cancellable: if the user starts a different clip or hits
    // any control during the gap, _autoAdvanceTimer gets cleared by
    // whatever takes over.
    // Suppressed while a chapter queue is active — the queue's own
    // advance logic owns transitions between its chapters.
    if (justEndedId && _chapterTotalCount <= 0) {
      const nextId = await nextClipId(justEndedId);
      if (nextId) {
        setStatus("Up next in 3s…");
        _cancelAutoAdvance();
        _autoAdvanceTimer = setTimeout(() => {
          _autoAdvanceTimer = null;
          loadClip(nextId);
        }, 3000);
      }
    }
  });

  // Capture each per-sentence WAV's true duration so virtualTime() and the
  // queue-jump math have accurate offsets across sentences.
  playerEl.addEventListener("loadedmetadata", () => {
    if (
      _streamPlayhead >= 0 &&
      _streamPlayhead < _streamQueue.length &&
      isFinite(playerEl.duration)
    ) {
      _streamQueue[_streamPlayhead].durationSec = playerEl.duration;
    }
  });

  const updatePosition = () => {
    // During streaming we don't know the total duration yet — skip so we
    // don't feed the OS misleading values for the lock-screen scrubber.
    if (_streamPlayhead >= 0) return;
    const dur = playerEl.duration;
    if (!isFinite(dur) || dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(playerEl.currentTime, dur),
        playbackRate: playerEl.playbackRate || 1,
      });
    } catch {
      // Some browsers throw if values are stale — safe to ignore.
    }
  };
  playerEl.addEventListener("loadedmetadata", updatePosition);
  playerEl.addEventListener("timeupdate", updatePosition);
  playerEl.addEventListener("ratechange", updatePosition);

  // Karaoke-style highlight in the reading view, driven by the same
  // timeupdate signal so it stays in sync with playback.
  playerEl.addEventListener("timeupdate", highlightCurrentSentence);
  playerEl.addEventListener("seeked", highlightCurrentSentence);

  // Throttled resume-position checkpoint. Plus an immediate save when the
  // tab closes so we don't lose the last few seconds.
  playerEl.addEventListener("timeupdate", () => maybeSaveProgress(false));
  window.addEventListener("pagehide", () => maybeSaveProgress(true));
}

// ---- Voice browser -------------------------------------------------------
// Fetches the full Piper voice catalog from /api/voices/catalog and lets the
// user install a new voice without touching the CLI. Groups by language, has
// a live search input, and pings /api/voices afterwards so the just-installed
// voice shows up in the main dropdown immediately.

let _voiceCatalog = null; // cached per page load

// v219: look up provenance fields (license + attribution) for a voice id.
// Used by generate() to snapshot the license that applies to a clip's
// audio at generation time — important because Narrative's license
// audit may revise commercial-status later, and the clip's recorded
// attribution should reflect what was true when it was made.
//
// voice ids on clips carry the "piper:" prefix (engine route); the
// catalog stores bare ids. Strip the prefix before lookup.
function _voiceProvenance(voiceIdWithPrefix) {
  if (!voiceIdWithPrefix || !_voiceCatalog) return null;
  const bare = String(voiceIdWithPrefix).replace(/^piper:/, "");
  const entry = _voiceCatalog.find((v) => v.id === bare);
  if (!entry) return null;
  return {
    license: entry.license || "",
    licenseDataset: entry.license_dataset || "",
    licenseCommercial: !!entry.license_commercial,
    attribution: entry.license_attribution || "",
  };
}

// "Show installed only" chip state. Reset each time the dialog opens so
// the default browsing experience always shows the full catalog.
let _installedOnly = false;

function updateInstalledToggle() {
  // Show the installed count when the filter is off (helpful at a glance);
  // flip to "All voices" when it's on so the toggle action is obvious.
  const installedCount = _voiceCatalog
    ? _voiceCatalog.filter((v) => v.installed).length
    : 0;
  voiceInstalledToggle.classList.toggle("active", _installedOnly);
  voiceInstalledToggle.setAttribute("aria-pressed", String(_installedOnly));
  voiceInstalledToggle.textContent = _installedOnly
    ? "All voices"
    : `Installed only (${installedCount})`;
}

let _favoritesOnly = false;
// v218: "Commercial only" filter state. Reset on every dialog open like
// the others so first-time discovery sees the whole catalog.
let _commercialOnly = false;
// Language-code filter. Empty string = "all languages." Set by the
// <select> below the filter chips; survives across browser opens.
let _languageFilter = "";

function updateCommercialToggle() {
  // Same count idiom as the other chips: show "(N)" of matching voices
  // when off so the user knows how much narrows in; flip to "All voices"
  // when on. Counts every voice with license_commercial === true, which
  // includes the small audited green set today and grows as we audit more.
  const commercialCount = _voiceCatalog
    ? _voiceCatalog.filter((v) => v.license_commercial).length
    : 0;
  voiceCommercialToggle.classList.toggle("active", _commercialOnly);
  voiceCommercialToggle.setAttribute("aria-pressed", String(_commercialOnly));
  voiceCommercialToggle.textContent = _commercialOnly
    ? "All voices"
    : `Commercial only (${commercialCount})`;
}

// Build the language picker options from the catalog. Each option is
// "Language name (N)" where N is the count of voices in that language.
// Sorted alphabetically; "All languages (total)" stays pinned at the top.
function _populateLanguageFilter() {
  if (!_voiceCatalog) return;
  // Stash the current selection so a re-populate (e.g. after install /
  // remove changes counts) doesn't reset the user's choice.
  const current = voiceLanguageFilter.value;

  // v154: bucket by ISO 639-1 prefix (the part before "_") so all
  // en_* voices group under a single "English" entry. Previously
  // the dropdown had separate buckets for en_US and en_GB that
  // both displayed as "English (N)" — picking the en_GB bucket
  // hid LibriTTS (en_US, 904 speakers) and a tester reported
  // "LibriTTS doesn't show up under English." The list itself
  // still sub-headers by country, so consolidating the dropdown
  // doesn't lose any locale information.
  const byLang = new Map();
  for (const v of _voiceCatalog) {
    const code = v.language_code || "";
    if (!code) continue;
    const baseLang = code.split("_")[0] || code;
    if (!byLang.has(baseLang)) {
      byLang.set(baseLang, {
        name: v.language_name || baseLang,
        count: 0,
      });
    }
    byLang.get(baseLang).count += 1;
  }

  // Preserve "All languages" header; rebuild the rest.
  voiceLanguageFilter.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = `All languages (${_voiceCatalog.length})`;
  voiceLanguageFilter.appendChild(allOpt);

  const sorted = [...byLang.entries()].sort((a, b) =>
    a[1].name.localeCompare(b[1].name)
  );
  for (const [code, info] of sorted) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${info.name} (${info.count})`;
    voiceLanguageFilter.appendChild(opt);
  }

  // Restore the selection if still valid; otherwise fall back to "all."
  if (current && byLang.has(current)) {
    voiceLanguageFilter.value = current;
  } else {
    voiceLanguageFilter.value = _languageFilter || "";
  }
}

function updateFavoritesToggle() {
  const favCount = getFavoriteVoices().length;
  voiceFavoritesToggle.classList.toggle("active", _favoritesOnly);
  voiceFavoritesToggle.setAttribute("aria-pressed", String(_favoritesOnly));
  voiceFavoritesToggle.textContent = _favoritesOnly
    ? "All voices"
    : `★ Favorites (${favCount})`;
}

async function loadVoiceCatalog(force = false) {
  if (_voiceCatalog && !force) return _voiceCatalog;
  voiceBrowserList.innerHTML =
    '<div class="voice-browser-loading">Loading catalog…</div>';
  try {
    const res = await fetch("/api/voices/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _voiceCatalog = data.voices || [];
    // Rebuild the language dropdown so its options reflect the fresh
    // catalog (count per language can shift after an install / remove).
    _populateLanguageFilter();
  } catch (e) {
    voiceBrowserList.innerHTML =
      `<div class="voice-browser-loading">Failed to load catalog: ${e.message}</div>`;
    _voiceCatalog = null;
  }
  return _voiceCatalog;
}

// v167: inline favorites tip — shown in the voice browser when no
// voice has been starred yet AND the user hasn't dismissed it.
// Dismiss flag persists in localStorage so a returning user who
// dismissed it doesn't see it again.
const VOICE_FAV_TIP_KEY = "narrative.voiceFavTipDismissed";
function _updateVoiceFavoritesTip() {
  const tip = document.getElementById("voice-favorites-tip");
  if (!tip) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(VOICE_FAV_TIP_KEY) === "1"; } catch {}
  const favCount = getFavoriteVoices().length;
  tip.hidden = dismissed || favCount > 0;
}
const _voiceFavTipDismissBtn = document.getElementById("voice-favorites-tip-dismiss");
if (_voiceFavTipDismissBtn) {
  _voiceFavTipDismissBtn.addEventListener("click", () => {
    try { localStorage.setItem(VOICE_FAV_TIP_KEY, "1"); } catch {}
    _updateVoiceFavoritesTip();
  });
}

// v219: parallel "Commercial only" first-tap hint. Same dismiss
// pattern as the favorites tip, and self-dismisses the first time
// the user actually toggles the Commercial chip — proving they know
// it's there. Persisted in localStorage so a returning user who
// already used the chip doesn't see the banner again.
const VOICE_COMM_TIP_KEY = "narrative.voiceCommercialTipDismissed";
function _updateVoiceCommercialTip() {
  const tip = document.getElementById("voice-commercial-tip");
  if (!tip) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(VOICE_COMM_TIP_KEY) === "1"; } catch {}
  tip.hidden = dismissed;
}
const _voiceCommTipDismissBtn = document.getElementById("voice-commercial-tip-dismiss");
if (_voiceCommTipDismissBtn) {
  _voiceCommTipDismissBtn.addEventListener("click", () => {
    try { localStorage.setItem(VOICE_COMM_TIP_KEY, "1"); } catch {}
    _updateVoiceCommercialTip();
  });
}

function renderVoiceCatalog() {
  if (!_voiceCatalog) return;
  updateInstalledToggle();
  updateCommercialToggle();
  // v167: keep the tip in sync with the current favorites state on
  // every render — covers "user opens browser fresh" and "user just
  // un-starred their last favorite" without extra calls elsewhere.
  _updateVoiceFavoritesTip();
  // v219: same pattern for the Commercial-only tip.
  _updateVoiceCommercialTip();
  updateFavoritesToggle();
  const favSet = new Set(getFavoriteVoices());
  const q = voiceBrowserSearch.value.trim().toLowerCase();
  const matches = _voiceCatalog.filter((v) => {
    if (_installedOnly && !v.installed) return false;
    if (_favoritesOnly && !favSet.has(v.id)) return false;
    // v218: commercial-use filter. Voices fall into license_commercial=true
    // only when explicitly audited in tts/voice_licenses.py.
    if (_commercialOnly && !v.license_commercial) return false;
    // v154: match on the ISO 639-1 prefix so the consolidated
    // "English" filter (which now stores "en" as its value) matches
    // both en_US (LibriTTS et al) and en_GB voices. Fall back to
    // exact match for any catalog entries where the code already
    // lacks an underscore.
    if (_languageFilter) {
      const code = v.language_code || "";
      const base = code.split("_")[0] || code;
      if (base !== _languageFilter) return false;
    }
    if (!q) return true;
    return (
      v.name.toLowerCase().includes(q) ||
      v.language_name.toLowerCase().includes(q) ||
      v.language_native.toLowerCase().includes(q) ||
      v.language_code.toLowerCase().includes(q) ||
      v.country.toLowerCase().includes(q) ||
      v.id.toLowerCase().includes(q)
    );
  });

  // Group by "Language (Country)" so the user can scan by region.
  const byGroup = new Map();
  for (const v of matches) {
    const country = v.country ? ` (${v.country})` : "";
    const label = `${v.language_name || v.language_code}${country}`;
    if (!byGroup.has(label)) byGroup.set(label, []);
    byGroup.get(label).push(v);
  }

  // Within a group, installed first, then alphabetical by name.
  for (const arr of byGroup.values()) {
    arr.sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        a.name.localeCompare(b.name) ||
        a.quality.localeCompare(b.quality)
    );
  }

  voiceBrowserList.innerHTML = "";
  if (byGroup.size === 0) {
    // Give context-aware empty copy so the user understands WHY the list
    // is empty — "no installed voices yet" vs. "your filter excluded all."
    const empty = document.createElement("div");
    empty.className = "voice-browser-loading";
    if (_favoritesOnly && getFavoriteVoices().length === 0) {
      empty.textContent =
        "No favorites yet. Tap a ☆ on any voice to star it.";
    } else if (_installedOnly && !_voiceCatalog.some((v) => v.installed)) {
      empty.textContent =
        "No voices installed yet. Turn off the filter to browse the catalog.";
    } else if (_languageFilter) {
      const langOpt = voiceLanguageFilter.querySelector(
        `option[value="${CSS.escape(_languageFilter)}"]`
      );
      const langName = langOpt ? langOpt.textContent : _languageFilter;
      empty.textContent = `No voices match these filters in ${langName}.`;
    } else {
      empty.textContent = "No voices match.";
    }
    voiceBrowserList.appendChild(empty);
    return;
  }

  // Sort groups alphabetically (looks nicer than catalog-insertion order).
  const sortedGroups = [...byGroup.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [label, voices] of sortedGroups) {
    const head = document.createElement("div");
    head.className = "catalog-group";
    head.textContent = label;
    voiceBrowserList.appendChild(head);

    for (const v of voices) {
      voiceBrowserList.appendChild(makeCatalogRow(v));
    }
  }
}

function makeCatalogRow(v) {
  const row = document.createElement("div");
  row.className = "catalog-voice";

  // ★ Favorite toggle. Star is leftmost so the user's eye lands on it
  // first when scanning a long catalog.
  const favBtn = document.createElement("button");
  favBtn.type = "button";
  const isFav = isFavoriteVoice(v.id);
  favBtn.className = "catalog-voice-fav" + (isFav ? " starred" : "");
  favBtn.textContent = isFav ? "★" : "☆";
  favBtn.title = isFav ? "Remove from favorites" : "Add to favorites";
  favBtn.setAttribute(
    "aria-label",
    isFav ? `Unfavorite ${v.name}` : `Favorite ${v.name}`
  );
  favBtn.setAttribute("aria-pressed", String(isFav));
  favBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    toggleFavoriteVoice(v.id);
    // Re-render the catalog so the row repositions if Favorites-only is
    // active, and refresh the main picker's "★ Favorites" optgroup.
    renderVoiceCatalog();
    _refreshFavoritesInMainPicker();
    // v167: re-evaluate the favorites tip banner — it hides once any
    // favorite exists. The v166 setStatus hint fired but the voice
    // browser modal occluded the status bar, so the user never saw
    // it AND the localStorage seen-flag got locked. We're now using
    // an inline banner instead (see _updateVoiceFavoritesTip).
    _updateVoiceFavoritesTip();
  });
  row.appendChild(favBtn);

  const info = document.createElement("div");
  info.className = "catalog-voice-info";

  const nameEl = document.createElement("div");
  nameEl.className = "catalog-voice-name";
  nameEl.textContent = `${cap(v.name)} · ${v.quality}`;

  // v217: license badge. Green "Commercial ✓" if the voice is cleared
  // for distributing generated audio; amber "Non-commercial" otherwise.
  // Tooltip carries the dataset, license, and required attribution.
  if (typeof v.license_commercial === "boolean") {
    const badge = document.createElement("span");
    badge.className = v.license_commercial
      ? "catalog-voice-license commercial"
      : "catalog-voice-license noncommercial";
    badge.textContent = v.license_commercial ? "Commercial ✓" : "Non-commercial";
    const tipBits = [];
    if (v.license) tipBits.push(`License: ${v.license}`);
    if (v.license_dataset) tipBits.push(`Dataset: ${v.license_dataset}`);
    if (v.license_attribution)
      tipBits.push(`Credit: ${v.license_attribution}`);
    if (v.license_notes) tipBits.push(v.license_notes);
    badge.title = tipBits.join("\n");
    nameEl.appendChild(document.createTextNode(" "));
    nameEl.appendChild(badge);
  }

  const metaParts = [];
  if (v.size_mb) metaParts.push(`${v.size_mb} MB`);
  if (v.num_speakers > 1) metaParts.push(`${v.num_speakers} speakers`);
  metaParts.push(v.id);
  const metaEl = document.createElement("div");
  metaEl.className = "catalog-voice-meta";
  metaEl.textContent = metaParts.join(" · ");

  info.append(nameEl, metaEl);

  // Preview button — plays the pre-recorded HuggingFace sample so users can
  // hear a voice before committing to a ~60MB download.
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "catalog-voice-preview";
  preview.textContent = "▶";
  preview.setAttribute("aria-label", `Preview ${v.name}`);
  // Title doubles as a row-level hint. With custom text set, the ▶ on
  // uninstalled rows runs an install + auto-preview; without it, it
  // plays the standard sample. Either way, one click ends in audio.
  preview.title = v.installed
    ? "Preview voice"
    : "Preview standard sample (install first to hear your text)";
  preview.addEventListener("click", () => togglePreview(v, preview));

  const action = document.createElement("button");
  action.type = "button";
  action.className = v.installed
    ? "catalog-voice-action installed"
    : "catalog-voice-action";
  action.textContent = v.installed ? "Installed" : "Install";
  action.disabled = v.installed;
  if (!v.installed) {
    action.addEventListener("click", () => installCatalogVoice(v, action));
  }

  row.append(info, preview, action);

  // Installed voices get a small × button for uninstall. We keep the
  // "Installed" pill so the row's state still reads at a glance.
  if (v.installed) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "catalog-voice-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove this voice from disk";
    removeBtn.setAttribute("aria-label", `Remove ${v.name}`);
    removeBtn.addEventListener("click", () => removeCatalogVoice(v, removeBtn));
    row.appendChild(removeBtn);
  }

  return row;
}

async function removeCatalogVoice(voice, btn) {
  // Soft confirm — a 130 MB LibriTTS install isn't fun to redo by accident,
  // but it's also one click away if they change their mind.
  const ok = confirm(
    `Remove "${cap(voice.name)} (${voice.quality})"? ` +
    `(${voice.size_mb} MB will be freed; you can re-install anytime.)`
  );
  if (!ok) return;

  btn.disabled = true;
  // Stop any preview that's playing the file we're about to delete.
  stopPreview();
  try {
    const res = await fetch(`/api/voices/${encodeURIComponent(voice.id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }
    // Update local catalog state and re-render so the row flips back
    // from "Installed (×)" to "Install".
    voice.installed = false;
    renderVoiceCatalog();
    // Refresh the main voice dropdown so the removed voice disappears
    // from there too. If it was the current selection, the dropdown
    // will fall back to its first option (and the speaker row will
    // hide via onVoiceChange).
    await loadVoices();
  } catch (e) {
    console.warn("voice remove failed:", e);
    btn.disabled = false;
    setStatus(`Remove failed: ${e.message}`, true);
  }
}

// ---- Voice preview ------------------------------------------------------
// One shared Audio element so clicking a new preview cleanly stops the old
// one. Buttons that 404 (voice has no published sample) get permanently
// disabled with a tooltip so the user doesn't keep retrying.
let _previewAudio = null;
let _previewBtn = null; // the catalog row button currently showing "■"

function _ensurePreviewAudio() {
  if (_previewAudio) return _previewAudio;
  _previewAudio = new Audio();
  _previewAudio.addEventListener("ended", _resetPreviewBtn);
  return _previewAudio;
}

function _resetPreviewBtn() {
  if (!_previewBtn) return;
  _previewBtn.classList.remove("playing", "loading");
  _previewBtn.textContent = "▶";
  _previewBtn = null;
}

// Holds a blob URL from a custom-text synth so we can revoke it on stop
// instead of leaking the object URL across previews.
let _previewBlobUrl = null;

function stopPreview() {
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.removeAttribute("src");
    _previewAudio.load(); // forces the browser to release the request
  }
  if (_previewBlobUrl) {
    URL.revokeObjectURL(_previewBlobUrl);
    _previewBlobUrl = null;
  }
  _resetPreviewBtn();
}

// ---- Audition lifecycle ------------------------------------------------
// When the user clicks ▶ on an uninstalled voice (with custom text set),
// we install it on disk so synthesis can run. But the user hasn't
// committed to keeping it — they're just auditioning. Track which
// installs were triggered by an audition and roll them back when the
// browser dialog closes, unless the user explicitly hit "Keep."
const _auditionedVoiceIds = new Set();
// voice.id -> the row's action button element. Lets _commitAudition
// flip the pill from "Keep" back to "Installed" in place.
const _auditionActionBtns = new Map();

function _markAuditioned(voice, actionBtn) {
  _auditionedVoiceIds.add(voice.id);
  // installCatalogVoice() already mutated the pill to "Installed"
  // (disabled). We need a fresh node so the original click listener
  // doesn't fire alongside the new "Keep" one. cloneNode + replaceWith
  // is the simplest way to drop addEventListener handlers.
  const fresh = actionBtn.cloneNode(false);
  fresh.classList.remove("installed");
  fresh.classList.add("keep");
  fresh.textContent = "Keep";
  fresh.disabled = false;
  fresh.title =
    "Keep this voice. Without Keep, it auto-removes when you close this dialog.";
  fresh.addEventListener("click", () => _commitAudition(voice));
  actionBtn.replaceWith(fresh);
  _auditionActionBtns.set(voice.id, fresh);
}

function _commitAudition(voice) {
  const btn = _auditionActionBtns.get(voice.id);
  if (!btn) return;
  _auditionedVoiceIds.delete(voice.id);
  _auditionActionBtns.delete(voice.id);
  btn.classList.remove("keep");
  btn.classList.add("installed");
  btn.textContent = "Installed";
  btn.disabled = true;
  btn.title = "";
}

// Iterate the audition set, DELETE each voice via /api/voices/{id}, and
// clear the state. Called on dialog close + best-effort on tab close.
// No confirm dialog — these were never permanent commits.
async function _revertAuditions() {
  if (_auditionedVoiceIds.size === 0) return;
  const ids = [..._auditionedVoiceIds];
  _auditionedVoiceIds.clear();
  _auditionActionBtns.clear();
  // Stop any in-flight preview using a soon-to-be-deleted file.
  stopPreview();
  await Promise.all(
    ids.map((id) =>
      fetch(`/api/voices/${encodeURIComponent(id)}`, { method: "DELETE" })
        .catch((e) => console.warn("audition revert failed:", id, e))
    )
  );
  // Mutate the local catalog state so subsequent renders show the right
  // pill (Install instead of Installed) without a server round trip.
  if (_voiceCatalog) {
    for (const v of _voiceCatalog) {
      if (ids.includes(v.id)) v.installed = false;
    }
  }
  // Main voice picker reflects only installed voices; refresh it so the
  // reverted ones disappear.
  await loadVoices();
}

// Triggered when the user clicks ▶ with custom text set on an
// uninstalled row. Finds the row's Install pill, calls the standard
// install flow (live percentage shown on the pill), then on success
// re-invokes togglePreview to actually play the custom text. The
// install is recorded as an audition so it gets rolled back unless
// the user hits "Keep" before closing the dialog.
async function _installThenPreview(voice, btn) {
  const row = btn.closest(".catalog-voice");
  if (!row) return;
  const installBtn = row.querySelector(".catalog-voice-action");
  if (!installBtn || installBtn.disabled) {
    // No install affordance to hijack — bail without surprise. (Could
    // happen if the catalog markup changes and the row no longer has a
    // standard install button.)
    return;
  }
  // Mark the row's ▶ as "queued for play after install" so the user
  // gets visual feedback that something's happening; the install pill
  // already shows the live percentage.
  btn.classList.add("queued");
  btn.textContent = "…";
  try {
    await installCatalogVoice(voice, installBtn);
  } finally {
    btn.classList.remove("queued");
    btn.textContent = "▶";
  }
  // installCatalogVoice mutates voice.installed = true on success.
  // Mark the install as an audition so closing the dialog without
  // committing reverts it. Then fire the preview the user asked for.
  if (voice.installed) {
    _markAuditioned(voice, installBtn);
    if (!_previewBtn) {
      togglePreview(voice, btn);
    }
  }
}

async function togglePreview(voice, btn) {
  // Same button → toggle off.
  if (_previewBtn === btn) {
    stopPreview();
    return;
  }
  stopPreview();

  const customText = (voicePreviewText?.value || "").trim();

  // Install-then-preview path: if the user typed custom text and this
  // voice isn't installed yet, kick off the install in-place on the
  // row's "Install" pill. When the install completes, the install
  // helper recursively re-invokes togglePreview — at which point the
  // voice IS installed and the synth-custom path below runs. Without
  // this branch, custom text on an uninstalled row would silently fall
  // back to the static sample, which defeats the whole point of
  // typing custom text in the first place.
  if (customText && !voice.installed) {
    _installThenPreview(voice, btn);
    return;
  }

  const audio = _ensurePreviewAudio();
  btn.classList.add("loading");
  btn.textContent = "…";
  _previewBtn = btn;

  // Custom-text path: if the user pasted their own preview text, ask the
  // server to synthesize it with this voice instead of playing the
  // canned HuggingFace sample. Routes through /api/synthesize which
  // returns one WAV in a single response (good fit for short previews).
  //
  // Gotcha: the catalog returns bare slugs ("en_US-amy-medium"); the
  // tts dispatcher routes by an engine prefix ("piper:..."). Without
  // the prefix, every preview silently falls through to the SAPI
  // default voice and sounds identical.
  const canSynthCustom = customText && voice.installed;
  try {
    if (canSynthCustom) {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: customText.slice(0, 300),
          voice_id: `piper:${voice.id}`,
          rate: 180,
          volume: 1.0,
          // Multi-speaker voices: first speaker for the preview is fine —
          // browsing the catalog is "do I like the voice family;" speaker
          // selection happens later in the dedicated speaker picker.
          speaker_id: voice.num_speakers > 1 ? 0 : null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      _previewBlobUrl = URL.createObjectURL(blob);
      audio.src = _previewBlobUrl;
    } else {
      // Static-sample path: original behavior. Pre-recorded sample
      // proxied from HuggingFace; instant playback, zero TTS cost.
      // Reached only when the preview-text input is empty — the
      // (custom text + uninstalled) case is intercepted above and
      // routed through _installThenPreview.
      audio.src = `/api/voices/sample/${encodeURIComponent(voice.id)}`;
    }
    await audio.play();
    btn.classList.remove("loading");
    btn.classList.add("playing");
    btn.textContent = "■";
  } catch (err) {
    // Most common causes:
    //   - 404 on the static sample (no published sample for this voice)
    //   - synthesis failure for a voice that isn't installed yet
    if (_previewBtn === btn) {
      btn.classList.remove("playing", "loading");
      btn.textContent = "—";
      btn.title = canSynthCustom
        ? "Synthesis failed for this voice"
        : "No preview available for this voice";
      btn.disabled = true;
      _previewBtn = null;
    }
    console.info("preview unavailable:", voice.id, err.message || err);
  }
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

async function installCatalogVoice(voice, btn) {
  btn.disabled = true;
  btn.classList.remove("failed");
  btn.textContent = "Starting…";
  try {
    const res = await fetch("/api/voices/install/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voice.id }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.detail) detail = j.detail;
      } catch {}
      throw new Error(detail);
    }

    // Parse the SSE stream the same way generate() does.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let total = 0;
    let finished = false;
    let errorMsg = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop();
      for (const block of blocks) {
        const line = block.trim();
        if (!line.startsWith("data:")) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (event.type === "start") {
          total = event.total_bytes || 0;
          btn.textContent = "0%";
        } else if (event.type === "progress") {
          const pct = total > 0
            ? Math.min(100, Math.round((event.downloaded / total) * 100))
            : 0;
          btn.textContent = `${pct}%`;
        } else if (event.type === "done") {
          finished = true;
        } else if (event.type === "error") {
          errorMsg = event.message || "install error";
        }
      }
    }

    if (errorMsg) throw new Error(errorMsg);
    if (!finished) throw new Error("install stream ended early");

    voice.installed = true;
    btn.classList.add("installed");
    btn.textContent = "Installed";
    await loadVoices();
  } catch (e) {
    console.warn("voice install failed:", e);
    btn.classList.add("failed");
    btn.textContent = "Failed";
    setTimeout(() => {
      btn.classList.remove("failed");
      btn.textContent = "Install";
      btn.disabled = false;
    }, 2500);
  }
}

browseVoicesBtn.addEventListener("click", async () => {
  voiceBrowser.showModal();
  voiceBrowserSearch.value = "";
  _installedOnly = false;
  _favoritesOnly = false;
  _commercialOnly = false;
  // Custom preview text is preserved across opens — if you pasted a
  // sentence from your manuscript, you probably want to keep auditioning
  // voices on it. Just sync the Clear button visibility.
  _updatePreviewClearBtn();
  await loadVoiceCatalog();
  renderVoiceCatalog();
  voiceBrowserSearch.focus();
});

voiceInstalledToggle.addEventListener("click", () => {
  _installedOnly = !_installedOnly;
  renderVoiceCatalog();
});

voiceFavoritesToggle.addEventListener("click", () => {
  _favoritesOnly = !_favoritesOnly;
  renderVoiceCatalog();
});

// v218: commercial-only chip — show only voices cleared in
// tts/voice_licenses.py with license_commercial: true. Audited list
// is small today (LibriTTS, LibriTTS-R, VCTK, Jenny); will grow.
voiceCommercialToggle.addEventListener("click", () => {
  _commercialOnly = !_commercialOnly;
  // v219: tapping the chip is proof the user knows it's there —
  // dismiss the first-tap tip so the banner doesn't keep occupying
  // header real estate. Idempotent across taps.
  try { localStorage.setItem(VOICE_COMM_TIP_KEY, "1"); } catch {}
  renderVoiceCatalog();
});

voiceLanguageFilter.addEventListener("change", () => {
  _languageFilter = voiceLanguageFilter.value;
  renderVoiceCatalog();
});

// Custom preview text — show / hide the Clear button as the input is
// edited; clicking Clear empties and re-hides itself. Stop any in-flight
// preview when the text changes so a stale clip doesn't keep playing.
function _updatePreviewClearBtn() {
  const hasText = !!voicePreviewText.value;
  voicePreviewClear.hidden = !hasText;
  // Hint is paired with the input: only meaningful when there's text
  // (the install-required behavior is irrelevant otherwise).
  voicePreviewHint.hidden = !hasText;
}
voicePreviewText.addEventListener("input", () => {
  stopPreview();
  _updatePreviewClearBtn();
});
voicePreviewClear.addEventListener("click", () => {
  voicePreviewText.value = "";
  _updatePreviewClearBtn();
  voicePreviewText.focus();
});

voiceBrowserClose.addEventListener("click", () => voiceBrowser.close());
voiceBrowserSearch.addEventListener("input", renderVoiceCatalog);
// Native <dialog> fires "close" both for ESC and for explicit .close() calls.
// Cleanest place to stop any in-flight preview AND to roll back any
// voices the user auditioned without committing.
voiceBrowser.addEventListener("close", () => {
  stopPreview();
  _revertAuditions();
});

// Best-effort: if the user closes the tab mid-audition, try to clean up
// the voice files anyway. `keepalive: true` lets the DELETE request
// outlive the page; not 100% reliable across browsers, but a worthwhile
// fallback so the disk doesn't quietly fill up with abandoned voices.
window.addEventListener("pagehide", () => {
  if (_auditionedVoiceIds.size === 0) return;
  for (const id of _auditionedVoiceIds) {
    try {
      fetch(`/api/voices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        keepalive: true,
      });
    } catch {}
  }
});

// ---- Long-press tooltips on touch devices ------------------------------
// Mobile browsers ignore `title` attributes on buttons (no hover state), so
// every hint we've sprinkled across the UI is desktop-only. This gives touch
// users the same affordance: hold for ~500ms on any element with a `title`,
// a tooltip toast appears, and the synthetic click that follows is
// suppressed so the long-press doesn't also trigger the button.
(() => {
  let _tipTimer = null;
  let _tipStartX = 0;
  let _tipStartY = 0;
  let _tipShown = false;
  let _tipTarget = null;
  let _tipNode = null;
  let _tipDismissTimer = null;

  // Pointer is over a coarse input (finger / stylus). Don't bother on a
  // mouse — browsers already do `title` hover tooltips there.
  function _isTouch() {
    return matchMedia("(hover: none), (pointer: coarse)").matches;
  }

  function _hideTooltip() {
    if (_tipNode) {
      _tipNode.remove();
      _tipNode = null;
    }
    if (_tipDismissTimer) {
      clearTimeout(_tipDismissTimer);
      _tipDismissTimer = null;
    }
  }

  function _showTooltip(target, text) {
    _hideTooltip();
    const node = document.createElement("div");
    node.className = "tooltip-toast";
    node.textContent = text;
    document.body.appendChild(node);

    // Position above the target if there's room, else below.
    const rect = target.getBoundingClientRect();
    const tipRect = node.getBoundingClientRect();
    const margin = 8;
    let top = rect.top - tipRect.height - margin;
    if (top < 8) top = rect.bottom + margin;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    node.style.top = `${Math.round(top)}px`;
    node.style.left = `${Math.round(left)}px`;

    _tipNode = node;
    _tipDismissTimer = setTimeout(_hideTooltip, 2500);
  }

  function _cancelPending() {
    if (_tipTimer) {
      clearTimeout(_tipTimer);
      _tipTimer = null;
    }
    _tipTarget = null;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (!_isTouch()) return;
      if (e.touches.length !== 1) return;
      const target = e.target.closest("[title]");
      if (!target) return;
      // Drag handle owns its own pointer events; don't fight it.
      if (target.classList.contains("clip-drag")) return;
      const text = target.getAttribute("title");
      if (!text) return;

      _cancelPending();
      _tipShown = false;
      _tipTarget = target;
      _tipStartX = e.touches[0].clientX;
      _tipStartY = e.touches[0].clientY;

      _tipTimer = setTimeout(() => {
        _tipTimer = null;
        if (!_tipTarget) return;
        _showTooltip(_tipTarget, text);
        _tipShown = true;
      }, 500);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!_tipTimer && !_tipShown) return;
      if (e.touches.length !== 1) {
        _cancelPending();
        _hideTooltip();
        return;
      }
      const dx = e.touches[0].clientX - _tipStartX;
      const dy = e.touches[0].clientY - _tipStartY;
      // ~10px dead zone; beyond that the user is scrolling or swiping.
      if (dx * dx + dy * dy > 100) {
        _cancelPending();
        if (_tipShown) _hideTooltip();
        _tipShown = false;
      }
    },
    { passive: true }
  );

  document.addEventListener("touchend", () => {
    _cancelPending();
    // Leave the tooltip visible for its auto-dismiss window so the user can
    // actually read what they held to see.
  });

  document.addEventListener("touchcancel", () => {
    _cancelPending();
    _hideTooltip();
    _tipShown = false;
  });

  // Suppress the synthetic click that follows a successful long-press, so
  // holding to read the tooltip doesn't also fire the button's action.
  document.addEventListener(
    "click",
    (e) => {
      if (_tipShown) {
        e.preventDefault();
        e.stopPropagation();
        _tipShown = false;
      }
    },
    true
  );
})();

// Register the service worker so the app shell loads offline and the page
// ---- Global bookmark timeline (#251) -----------------------------------
// "All bookmarks" in the library tools row opens this dialog: every
// bookmark across every clip, sortable + filterable. Each row carries a
// Jump button that loads the source clip (if not current) and seeks to
// the bookmark's time. The trigger button is hidden in renderLibrary
// unless at least one clip has a bookmark.

let _allBookmarksEntries = []; // flattened {clip, bookmark} pairs, last fetch
let _allBookmarksSort = "recent";

function _formatAbsRecency(iso) {
  // Bookmark createdAt is an ISO timestamp; format it relative to "now"
  // for the sort=recent display. Falls back to YYYY-MM-DD on parse fail.
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString();
}

async function _allBookmarksGather() {
  const clips = await listClips();
  const entries = [];
  for (const c of clips) {
    if (!Array.isArray(c.bookmarks) || c.bookmarks.length === 0) continue;
    for (const b of c.bookmarks) {
      entries.push({
        clipId: c.id,
        clipTitle: c.title || "(untitled)",
        clipTags: Array.isArray(c.tags) ? c.tags : [],
        bookmark: b,
      });
    }
  }
  _allBookmarksEntries = entries;
}

function _allBookmarksRender() {
  if (!allBookmarksList) return;
  const q = (allBookmarksFilter.value || "").trim().toLowerCase();
  let rows = _allBookmarksEntries.slice();

  if (q) {
    rows = rows.filter((e) => {
      const note = (e.bookmark.note || "").toLowerCase();
      const title = e.clipTitle.toLowerCase();
      const tags = e.clipTags.join(" ").toLowerCase();
      return note.includes(q) || title.includes(q) || tags.includes(q);
    });
  }

  switch (_allBookmarksSort) {
    case "time-in-clip":
      rows.sort(
        (a, b) =>
          (a.bookmark.timeSec || 0) - (b.bookmark.timeSec || 0) ||
          a.clipTitle.localeCompare(b.clipTitle)
      );
      break;
    case "clip-title":
      rows.sort(
        (a, b) =>
          a.clipTitle.localeCompare(b.clipTitle) ||
          (a.bookmark.timeSec || 0) - (b.bookmark.timeSec || 0)
      );
      break;
    case "recent":
    default:
      // createdAt absent on older bookmarks → fall back to clipId so
      // the row still sorts in some defensible order.
      rows.sort((a, b) => {
        const ta = a.bookmark.createdAt
          ? Date.parse(a.bookmark.createdAt)
          : a.clipId;
        const tb = b.bookmark.createdAt
          ? Date.parse(b.bookmark.createdAt)
          : b.clipId;
        return tb - ta;
      });
      break;
  }

  allBookmarksList.innerHTML = "";

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "all-bookmarks-empty";
    empty.textContent = q
      ? "No bookmarks match your filter."
      : "No bookmarks yet — add one with the 🔖 chip in the player.";
    allBookmarksList.appendChild(empty);
    allBookmarksSummary.textContent = "";
    return;
  }

  // Group by clip — gives a visual sense of where the listener is
  // spending revision attention. Sort modes still control the order
  // of CLIPS via first-row position; bookmarks within a clip stay in
  // ascending time so the per-clip subgroup reads naturally.
  const byClip = new Map();
  for (const r of rows) {
    if (!byClip.has(r.clipId)) byClip.set(r.clipId, []);
    byClip.get(r.clipId).push(r);
  }
  // Within each group, always sort bookmarks by time-in-clip.
  for (const arr of byClip.values()) {
    arr.sort((a, b) => (a.bookmark.timeSec || 0) - (b.bookmark.timeSec || 0));
  }

  for (const [clipId, clipRows] of byClip) {
    const head = document.createElement("div");
    head.className = "all-bookmarks-clip-head";
    head.textContent = clipRows[0].clipTitle;
    allBookmarksList.appendChild(head);

    for (const r of clipRows) {
      const row = document.createElement("div");
      row.className = "all-bookmarks-row";
      row.setAttribute("role", "listitem");

      const time = document.createElement("span");
      time.className = "all-bookmarks-time";
      time.textContent = formatTime(r.bookmark.timeSec || 0);

      const note = document.createElement("span");
      note.className = "all-bookmarks-note";
      note.textContent = r.bookmark.note || "(no note)";
      if (!r.bookmark.note) note.classList.add("muted");

      const when = document.createElement("span");
      when.className = "all-bookmarks-when";
      when.textContent = _formatAbsRecency(r.bookmark.createdAt);

      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "all-bookmarks-jump";
      jump.textContent = "Jump";
      jump.setAttribute(
        "aria-label",
        `Jump to ${r.clipTitle} at ${formatTime(r.bookmark.timeSec || 0)}`
      );
      jump.addEventListener("click", async () => {
        allBookmarksDialog.close();
        if (_currentClipId !== clipId) {
          await loadClip(clipId);
        }
        seekToTime(r.bookmark.timeSec || 0);
        // Auto-play after jump — the listener clicked to hear that line,
        // not to pause on it.
        try { await playerEl.play(); } catch {}
      });

      row.append(time, note, when, jump);
      allBookmarksList.appendChild(row);
    }
  }

  allBookmarksSummary.textContent =
    `${rows.length} bookmark${rows.length === 1 ? "" : "s"} across ${byClip.size} clip${byClip.size === 1 ? "" : "s"}`;
}

async function openAllBookmarks() {
  _allBookmarksSort = allBookmarksSort.value || "recent";
  allBookmarksFilter.value = "";
  await _allBookmarksGather();
  _allBookmarksRender();
  allBookmarksDialog.showModal();
}

if (libraryAllBookmarksBtn) {
  libraryAllBookmarksBtn.addEventListener("click", openAllBookmarks);
}
if (allBookmarksClose) {
  allBookmarksClose.addEventListener("click", () => allBookmarksDialog.close());
}
if (allBookmarksFilter) {
  allBookmarksFilter.addEventListener("input", _allBookmarksRender);
}
if (allBookmarksSort) {
  allBookmarksSort.addEventListener("change", () => {
    _allBookmarksSort = allBookmarksSort.value;
    _allBookmarksRender();
  });
}

// is installable on the home screen. Service workers only register over
// HTTPS or localhost; on a plain-HTTP LAN address registration will silently
// fail, which is fine — the app still works, just without offline caching.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.info("SW registration skipped:", err.message));
  });
}
