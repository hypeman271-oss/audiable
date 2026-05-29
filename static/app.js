const $ = (id) => document.getElementById(id);

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
const playModeBtn = $("play-mode-btn");
const libraryLabel = $("library-label");
const librarySearch = $("library-search");
const clipEditDialog = $("clip-edit");
const clipEditClose = $("clip-edit-close");
const clipEditTitle = $("clip-edit-title");
const clipEditNote = $("clip-edit-note");
const clipEditSave = $("clip-edit-save");
const browseVoicesBtn = $("browse-voices-btn");
const presetSaveBtn = $("preset-save-btn");
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
const voiceLanguageFilter = $("voice-language-filter");
const voicePreviewText = $("voice-preview-text");
const voicePreviewClear = $("voice-preview-clear");
const voicePreviewHint = $("voice-preview-hint");
const uploadBtn = $("upload-btn");
const uploadInput = $("upload-input");
const settingsBtn = $("settings-btn");
const settingsDialog = $("settings-dialog");
const settingsClose = $("settings-close");
// (Author-mode toggle is gone in v76; the three-tier Mode picker
// replaces it. The picker's radios are queried inline.)
const settingsFeedbackLink = $("settings-feedback-link");
const settingsFeedbackGmailLink = $("settings-feedback-gmail-link");
const settingsWhatsNewLink = $("settings-whats-new-link");
const whatsNewBadge = settingsWhatsNewLink.querySelector(".whats-new-badge");

// Bump this number whenever there's a noteworthy change in whats-new.html
// worth surfacing. The Settings link shows a "NEW" badge until the user
// opens the changelog, at which point we save this version as "seen."
const WHATS_NEW_LATEST = 95;
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
const pasteUrlBtn = $("paste-url-btn");
const urlRow = $("url-row");
const urlInput = $("url-input");
const urlFetchBtn = $("url-fetch-btn");
const speedBtn = $("speed-btn");
const sleepBtn = $("sleep-btn");
const abLoopBtn = $("ab-loop-btn");
const skipBackBtn = $("skip-back-btn");
const bookmarkAddBtn = $("bookmark-add-btn");
const bookmarksList = $("bookmarks-list");
const genLabel = generateBtn.querySelector(".label-text");
const genSpinner = generateBtn.querySelector(".spinner");

let lastBlobUrl = null;
let lastBlob = null;
// Images extracted from a URL fetch hang around in this module global
// until the next generate() saves them into the clip. Cleared by
// clearForNewClip and after a successful save so they don't leak into
// the next clip the user types from scratch.
let _pendingImages = [];

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
  if (!_queueAudioComplete || !_queueSaveComplete) return;
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

// Boot-time apply. The inline <head> script handles the pre-paint case;
// this is a belt-and-suspenders for browsers that ran past the inline
// script with a stale value (rare).
applyTheme(getThemePref());

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
  settingsDialog.showModal();
});

settingsClose.addEventListener("click", () => settingsDialog.close());

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
}

function applyPlaybackRate() {
  if (isFinite(playerEl.playbackRate)) {
    playerEl.playbackRate = _playbackRate;
  }
}

speedBtn.addEventListener("click", () => {
  const i = SPEEDS.indexOf(_playbackRate);
  _playbackRate = SPEEDS[(i + 1) % SPEEDS.length];
  try { localStorage.setItem(SPEED_STORAGE_KEY, String(_playbackRate)); } catch {}
  updateSpeedBtn();
  applyPlaybackRate();
});

updateSpeedBtn();
applyPlaybackRate();
// Re-apply on every src change — browsers sometimes reset playbackRate to 1
// when the audio source changes, which would break per-sentence streaming.
playerEl.addEventListener("loadedmetadata", applyPlaybackRate);

// ---- Sleep timer --------------------------------------------------------
// Cycles through Off / 15 / 30 / 45 / 60 min. On expiry, fades the player
// volume to zero over 5 seconds and pauses. Volume is restored after the
// fade so the next manual play isn't silent. Wall-clock based, so audio
// keeps playing through phone PWA backgrounding even when setInterval
// gets throttled — `timeupdate` (which fires while audio plays) also
// checks the expiry, catching it within a few hundred ms in any case.
const SLEEP_DURATIONS_MIN = [0, 15, 30, 45, 60];
const SLEEP_FADE_MS = 5000;

let _sleepIdx = 0;          // index into SLEEP_DURATIONS_MIN
let _sleepExpiryMs = 0;     // 0 when idle; Date.now() target otherwise
let _sleepTickHandle = null;
let _sleepFadeHandle = null;
let _sleepFadeStartVol = null;  // saved so cancel/reset can restore

function _formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function _updateSleepBtn() {
  if (_sleepExpiryMs <= 0) {
    sleepBtn.textContent = "Sleep";
    sleepBtn.classList.remove("active");
    return;
  }
  const remaining = _sleepExpiryMs - Date.now();
  sleepBtn.textContent = `💤 ${_formatCountdown(remaining)}`;
  sleepBtn.classList.add("active");
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
  _sleepIdx = (_sleepIdx + 1) % SLEEP_DURATIONS_MIN.length;
  const minutes = SLEEP_DURATIONS_MIN[_sleepIdx];
  if (minutes === 0) {
    cancelSleepTimer();
    setStatus("Sleep timer off.");
  } else {
    startSleepTimer(minutes);
    setStatus(`Sleep timer set for ${minutes} min.`);
  }
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
    // B must be after A — if the user marked B before A, swap them.
    if (here <= _loopA + 0.1) {
      // Too close / before A — treat as resetting A here.
      _loopA = here;
    } else {
      _loopB = here;
    }
  } else {
    // Third tap clears.
    _loopA = null;
    _loopB = null;
  }
  _updateAbBtn();
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

// ---- 5-second skip-back / skip-forward ----------------------------------
// Quick recovery for "I zoned out for a moment" + its mirror for "okay
// I got that, move me along." Separate from the MediaSession sentence
// skip on the lock screen (that one jumps a whole sentence, which is
// overkill when you just missed a word).
skipBackBtn.addEventListener("click", () => {
  // Use seekToTime so streaming mode + combined-WAV mode are both handled,
  // and the math is in terms of the virtual timeline (not whatever
  // per-sentence WAV happens to be loaded right now).
  const here = virtualTime();
  seekToTime(Math.max(0, here - 5));
});

const skipForwardBtn = $("skip-forward-btn");
skipForwardBtn.addEventListener("click", () => {
  // seekToTime already clamps to playerEl.duration on the way out, so
  // overshooting the end is a no-op rather than an error.
  const here = virtualTime();
  seekToTime(here + 5);
});

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

textEl.addEventListener("input", updateCounts);
updateCounts();

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

speakerAuditionBtn.addEventListener("click", openSpeakerWizard);
// Chip click is the primary path for high-count voices — the native
// dropdown is hidden in that mode, so the chip carries both the current-
// value display AND the "change" affordance in a single tap target.
speakerChip.addEventListener("click", openSpeakerWizard);
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
    presetsList.hidden = true;
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

// Dialogue / attribution heuristic. Tier 2 of the BACKLOG roadmap:
// paragraph-aware cursor (Tier 1) + gender-keyed pronoun lookup
// (Tier 2). Walks the text paragraph by paragraph, tracking:
//
//   - `lastNamedChar` — most recently named character (any gender).
//     Used as the Tier 1 fallback when no pronoun matches.
//   - `lastByGender` — most recently named character per declared
//     gender (male / female / they). Used to resolve "he/she/they said"
//     even when the named speaker is several sentences back.
//
// When a quoted sentence has no explicit name, the resolver scans the
// attribution OUTSIDE the quotes for pronouns:
//   - "she" / "her" / "hers"  → lastByGender.female
//   - "he" / "him" / "his"    → lastByGender.male
//   - "they" / "them" / "their" → lastByGender.they
// If the gender bucket is empty, falls back to Tier 1's `lastNamedChar`.
// If that's empty too, the narrator takes the sentence.
//
// Both cursors reset at every paragraph break (fresh paragraph +
// opening quote = new speaker per standard fiction convention).
//
// Accuracy: ~85% on mixed-gender dialogue scenes, vs. ~75-80% Tier 1,
// ~50-60% naive whole-word.
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

  for (const paragraph of paragraphs) {
    // Both cursors live inside this loop so they reset at every
    // paragraph boundary — the BACKLOG's "fresh paragraph + opening
    // quote = new speaker" convention.
    let lastNamedChar = null;
    const lastByGender = { male: null, female: null, they: null };

    const sentences = splitSentencesClient(paragraph);
    for (const sentence of sentences) {
      let attributedVoice = fallbackVoiceId;
      let attributedSpeaker = fallbackSpeakerId;

      const hasQuote = _DIALOGUE_QUOTE.test(sentence);
      const explicitName = _findNamedChar(sentence);

      // Update BOTH cursors on ANY sentence that names a character —
      // narration counts too. The gender bucket only updates when the
      // character has a declared gender (unset characters still
      // contribute to the Tier 1 single-cursor fallback).
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
          attributedVoice = explicitName.voiceId;
          attributedSpeaker = explicitName.speakerId;
        } else {
          // 2) No explicit name. Try Tier 2 (gender-keyed pronoun
          //    lookup), then Tier 1 (last-named-speaker), then fall
          //    through to the narrator.
          const g = _detectAttributionGender(sentence);
          const fromGender = g && lastByGender[g];
          const resolved = fromGender || lastNamedChar;
          if (resolved) {
            attributedVoice = resolved.voiceId;
            attributedSpeaker = resolved.speakerId;
          }
        }
      }
      // No quote → narrator. Cursors still updated above for the next
      // dialogue sentence's benefit.

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

async function generate() {
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
            if (wasPlaying || startedFresh || renarrateActive) {
              playerEl.play().catch(() => {});
            }
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
              createdAt: regenExistingMeta
                ? regenExistingMeta.createdAt
                : new Date().toISOString(),
            })
              .then(() => {
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

function _cpRefreshPlayIcon() {
  const playing = !playerEl.paused && !playerEl.ended;
  cpPlayIcon.hidden = playing;
  cpPauseIcon.hidden = !playing;
  cpPlayBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
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
  cpVolIcon.hidden = muted;
  cpMuteIcon.hidden = !muted;
  cpMuteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
}

cpPlayBtn.addEventListener("click", () => {
  if (playerEl.paused) {
    playerEl.play().catch(() => {});
  } else {
    _pauseAsUser();
  }
});

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
  if (_chapterTotalCount <= 0) {
    chapterQueueEl.hidden = true;
    return;
  }
  chapterQueueEl.hidden = false;
  const idx = _chapterCurrentIndex;
  const total = _chapterTotalCount;
  const nextTitle = _chapterQueue.length > 0 ? _chapterQueue[0].title : null;
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
  textEl.value = first.text;
  updateCounts();
  _hideChapterBanner();
  _updateChapterQueueUI();
  setStatus(
    `Chapter 1 of ${_chapterTotalCount} loaded. Click Generate — the rest will auto-continue.`
  );
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
async function _preSynthesizeChapter(chapter) {
  // Abort any in-flight pre-synth — we only ever look ahead one chapter.
  _abortPreSynth();
  _preSynthController = new AbortController();
  const myController = _preSynthController;
  const voiceId = voiceEl.value;
  if (!voiceId || !chapter || !chapter.text) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let combinedMp3 = null;
    let sentenceOffsetsMs = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "result") {
            combinedMp3 = new Blob([base64ToBytes(event.mp3_b64)], {
              type: "audio/mpeg",
            });
            sentenceOffsetsMs = event.sentence_offsets_ms || [];
          } else if (event.type === "error") {
            throw new Error(event.message || "synthesis error");
          }
        }
      }
    }
    if (!combinedMp3) throw new Error("no audio in result");

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
      return;
    }

    const newClipId = Date.now() + Math.floor(Math.random() * 1000);
    await saveClip({
      id: newClipId,
      title: chapter.title,
      note: "",
      text: chapter.text,
      voiceId,
      voiceName,
      rate,
      volume,
      speakerId,
      sentenceOffsetsSec: sentenceOffsetsMs.map((ms) => ms / 1000),
      blob: combinedMp3,
      durationSec: duration,
      progressSec: 0,
      bookmarks: [],
      images: [],
      createdAt: new Date().toISOString(),
    });
    renderLibrary();
    _preSynthChapter = { clipId: newClipId, title: chapter.title };
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn("[pre-synth] failed:", err);
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
  _chapterQueue = [];
  _chapterTotalCount = 0;
  _chapterCurrentIndex = 0;
  _pendingChapterTitle = null;
  _resetQueueAdvanceFlags();
  _abortPreSynth();
  _updateChapterQueueUI();
  setStatus("Chapter queue cancelled — current chapter will still save.");
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

function enterReadingView(text, images) {
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
    span.textContent = s;
    span.addEventListener("click", () => {
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
  textEl.hidden = true;
  readingView.hidden = false;
  editTextBtn.hidden = false;
  saveTextBtn.hidden = true;
  textLabel.textContent = "Now reading";
  // Chip strip is editing-only; clear it while we're in playback so the
  // reading view sits cleanly below the .meta line.
  if (fillerCountsEl) {
    fillerCountsEl.hidden = true;
    fillerCountsEl.innerHTML = "";
  }
}

function exitReadingView() {
  textEl.hidden = false;
  readingView.hidden = true;
  editTextBtn.hidden = true;
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
  // No clip → no re-narrate banner. Reset the dismiss tracker too so a
  // future load of a different clip can prompt again.
  renarrateBanner.hidden = true;
  _renarrateDismissedClipId = null;
  // Drop any pending images from a URL fetch so they don't sneak onto
  // a freshly-typed clip.
  _pendingImages = [];

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
  const activeSpan = sentenceSpans[idx];
  if (activeSpan) {
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

editTextBtn.addEventListener("click", exitReadingView);

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
  if (clip.voiceName) parts.push(clip.voiceName.split(" · ")[0]);
  // Compact word-count so the user has a quick "how much is in this card?"
  // signal alongside the audio duration. "247w" reads fast and fits even
  // on a phone-width card next to the voice name.
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
});

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

function makeClipCard(clip) {
  const item = document.createElement("div");
  const isSelected = _librarySelectedIds.has(clip.id);
  item.className =
    "clip" +
    (clip.id === _currentClipId ? " current" : "") +
    (_libraryMultiSelect && isSelected ? " selected" : "");
  // Stamp the clip id onto the DOM node so the drag-commit pass can read
  // the visual order without looking anything up.
  item.dataset.clipId = String(clip.id);

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
  const titleEl = document.createElement("span");
  titleEl.className = "clip-title";
  titleEl.textContent = clip.title || "(untitled)";
  const metaEl = document.createElement("span");
  metaEl.className = "clip-meta";
  metaEl.textContent = formatClipMeta(clip);
  playBtn.append(titleEl, metaEl);
  // If the user added a note, render it as a small italic line below
  // the standard meta. Keeps the card a single tap-target.
  if (clip.note && clip.note.trim()) {
    const noteEl = document.createElement("span");
    noteEl.className = "clip-note";
    noteEl.textContent = clip.note.trim();
    playBtn.appendChild(noteEl);
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

  // In select mode, hide the per-clip action buttons — bulk delete /
  // export live in the tools row instead. Just checkbox + body.
  if (_libraryMultiSelect) {
    item.append(leftCell, playBtn);
  } else if (resetBtn) {
    item.append(leftCell, playBtn, resetBtn, editBtn, delBtn);
  } else {
    item.append(leftCell, playBtn, editBtn, delBtn);
  }
  return item;
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

function _appendSectionHeader(label) {
  const h = document.createElement("div");
  h.className = "library-section";
  h.textContent = label;
  libraryList.appendChild(h);
}

async function renderLibrary() {
  let clips = [];
  try {
    clips = await listClips();
  } catch (e) {
    console.warn("library read failed:", e);
  }
  const totalCount = clips.length;
  libraryList.innerHTML = "";
  if (totalCount === 0) {
    libraryCard.hidden = true;
    return;
  }
  libraryCard.hidden = false;

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

  // Header label reflects whether the filter is hiding anything.
  libraryLabel.textContent =
    query && clips.length !== totalCount
      ? `Library · ${clips.length} of ${totalCount}`
      : "Library";

  if (clips.length === 0) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = `No clips match "${query}"`;
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
    _appendSectionHeader(`Continue listening · ${inProgress.length}`);
    for (const clip of inProgress) libraryList.appendChild(makeClipCard(clip));
    if (others.length > 0) {
      _appendSectionHeader(`Other clips · ${others.length}`);
    }
  }

  for (const clip of others) libraryList.appendChild(makeClipCard(clip));
}

// ---- Edit clip (title + note) ------------------------------------------
// Opens the <dialog> with the current values, saves the new ones back into
// the same IndexedDB row. Audio blob and all the synthesis-side fields
// (voice, speaker, offsets, duration) are left untouched.
let _editingClipId = null;

async function openClipEdit(clipId) {
  const clip = await getClip(clipId);
  if (!clip) return;
  _editingClipId = clipId;
  clipEditTitle.value = clip.title || "";
  clipEditNote.value = clip.note || "";
  clipEditDialog.showModal();
  clipEditTitle.focus();
  clipEditTitle.select();
}

function closeClipEdit() {
  _editingClipId = null;
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
    clip.title = newTitle;
    clip.note = newNote;
    await saveClip(clip);
    closeClipEdit();
    renderLibrary();
    setStatus(`Updated "${newTitle}"`);
  } catch (e) {
    console.warn("clip edit save failed:", e);
    setStatus(`Save failed: ${e.message}`, true);
  }
}

clipEditClose.addEventListener("click", closeClipEdit);
clipEditSave.addEventListener("click", saveClipEdit);
clipEditDialog.addEventListener("close", () => { _editingClipId = null; });
clipEditTitle.addEventListener("keydown", (e) => {
  // Enter on the title field saves; multi-line note handles Enter natively.
  if (e.key === "Enter") {
    e.preventDefault();
    saveClipEdit();
  }
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

      manifestClips.push({
        id: clip.id,
        title: clip.title || "",
        note: clip.note || "",
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

    // Audio lookup: filename → bytes.
    const audioByName = new Map();
    for (const e of entries) {
      if (e.name.startsWith("audio/")) audioByName.set(e.name, e.data);
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
      await saveClip({
        id: mc.id,
        title: mc.title || "(untitled)",
        note: mc.note || "",
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

  enterReadingView(clip.text || "", Array.isArray(clip.images) ? clip.images : []);
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
}

libraryClearBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved clips? This can't be undone.")) return;
  await clearLibrary();
  renderLibrary();
});

// ---- File upload --------------------------------------------------------
// Send a chosen file to /api/extract and drop the resulting text into the
// textarea. Server handles dispatch by extension (txt/md/pdf/epub/docx).

uploadBtn.addEventListener("click", () => uploadInput.click());

// ---- Paste URL ----------------------------------------------------------
// Toggle an inline input above the textarea; submit fetches the article
// server-side (trafilatura strips nav/ads/footers) and drops clean text
// into the textarea, ready for Generate.

function showUrlRow() {
  urlRow.hidden = false;
  urlInput.disabled = false;
  urlFetchBtn.disabled = false;
  urlInput.focus();
  urlInput.select();
}

function hideUrlRow() {
  urlRow.hidden = true;
  urlInput.value = "";
}

pasteUrlBtn.addEventListener("click", () => {
  if (urlRow.hidden) showUrlRow();
  else hideUrlRow();
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    fetchFromUrl();
  } else if (e.key === "Escape") {
    hideUrlRow();
  }
});

urlFetchBtn.addEventListener("click", fetchFromUrl);

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

async function fetchFromUrl() {
  const url = (urlInput.value || "").trim();
  if (!url) return;
  pasteUrlBtn.disabled = true;
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
    const res = await fetch("/api/extract/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
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
    updateCounts();
    _checkForChapters();

    hideUrlRow();
    const chars = (data.chars || 0).toLocaleString();
    setStatus(`Loaded ${data.filename} · ${chars} chars · ready to Generate`);
    textEl.focus();
  } catch (err) {
    setStatus(`Fetch failed: ${err.message}`, true);
  } finally {
    pasteUrlBtn.disabled = false;
    urlInput.disabled = false;
    urlFetchBtn.disabled = false;
    urlFetchBtn.textContent = "Fetch";
  }
}


uploadInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  uploadBtn.disabled = true;
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
    uploadBtn.disabled = false;
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
      if (_chapterTotalCount > 0) {
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
    if (_chapterTotalCount > 0) {
      _queueAudioComplete = true;
      _tryAdvanceQueue();
      // Suppress library auto-advance while a chapter queue is active
      // regardless of whether _tryAdvanceQueue actually scheduled the
      // advance this tick (save might still be pending).
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
// Language-code filter. Empty string = "all languages." Set by the
// <select> below the filter chips; survives across browser opens.
let _languageFilter = "";

// Build the language picker options from the catalog. Each option is
// "Language name (N)" where N is the count of voices in that language.
// Sorted alphabetically; "All languages (total)" stays pinned at the top.
function _populateLanguageFilter() {
  if (!_voiceCatalog) return;
  // Stash the current selection so a re-populate (e.g. after install /
  // remove changes counts) doesn't reset the user's choice.
  const current = voiceLanguageFilter.value;

  const byLang = new Map();
  for (const v of _voiceCatalog) {
    const code = v.language_code || "";
    if (!code) continue;
    if (!byLang.has(code)) {
      byLang.set(code, {
        name: v.language_name || code,
        count: 0,
      });
    }
    byLang.get(code).count += 1;
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

function renderVoiceCatalog() {
  if (!_voiceCatalog) return;
  updateInstalledToggle();
  updateFavoritesToggle();
  const favSet = new Set(getFavoriteVoices());
  const q = voiceBrowserSearch.value.trim().toLowerCase();
  const matches = _voiceCatalog.filter((v) => {
    if (_installedOnly && !v.installed) return false;
    if (_favoritesOnly && !favSet.has(v.id)) return false;
    if (_languageFilter && v.language_code !== _languageFilter) return false;
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
  });
  row.appendChild(favBtn);

  const info = document.createElement("div");
  info.className = "catalog-voice-info";

  const nameEl = document.createElement("div");
  nameEl.className = "catalog-voice-name";
  nameEl.textContent = `${cap(v.name)} · ${v.quality}`;

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
