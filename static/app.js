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
const uploadBtn = $("upload-btn");
const uploadInput = $("upload-input");
const settingsBtn = $("settings-btn");
const settingsDialog = $("settings-dialog");
const settingsClose = $("settings-close");
const authorModeToggle = $("author-mode-toggle");
const settingsFeedbackLink = $("settings-feedback-link");

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
// CSS uses `body[data-author-mode]` selectors, JS uses isAuthorMode().
const AUTHOR_MODE_KEY = "narrative.authorMode";

function isAuthorMode() {
  try { return localStorage.getItem(AUTHOR_MODE_KEY) === "true"; }
  catch { return false; }
}

function setAuthorMode(on) {
  try { localStorage.setItem(AUTHOR_MODE_KEY, on ? "true" : "false"); }
  catch {}
  if (on) document.body.dataset.authorMode = "true";
  else delete document.body.dataset.authorMode;
}

// Apply current setting at boot — survives reloads and PWA reinstalls.
setAuthorMode(isAuthorMode());

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
  authorModeToggle.checked = isAuthorMode();
  // Reflect current theme pref into the radios so the open dialog always
  // shows the right selection even if the user switched in another tab.
  const pref = getThemePref();
  document
    .querySelectorAll('.theme-picker input[name="theme"]')
    .forEach((r) => { r.checked = r.value === pref; });
  // Refresh stats so they reflect listening that happened since the
  // dialog was last opened. _renderStatsPanel resolves a few lookups
  // (voice display name, clip title) so it's async.
  _renderStatsPanel();
  settingsDialog.showModal();
});

settingsClose.addEventListener("click", () => settingsDialog.close());

authorModeToggle.addEventListener("change", () => {
  setAuthorMode(authorModeToggle.checked);
  // Recompute the textarea meta line so word count + time estimate
  // appear / disappear immediately when the toggle flips.
  updateCounts();
});

// Alpha feedback: open the user's mail client with subject + body pre-filled,
// including auto-context that's annoying for them to type but useful for
// triage. Falls back gracefully if no mail client is configured (the link
// just does nothing, and they can copy-paste the address from the dialog).
settingsFeedbackLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const ctx = [
    `URL:       ${location.href}`,
    `Build:     ${(await caches.keys()).find((k) => k.startsWith("narrative-shell")) || "(no SW cache)"}`,
    `UA:        ${navigator.userAgent}`,
    `Window:    ${window.innerWidth}×${window.innerHeight}`,
    `Screen:    ${screen.width}×${screen.height}`,
    `Author:    ${isAuthorMode() ? "on" : "off"}`,
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
  window.location.href =
    `mailto:${encodeURIComponent(FEEDBACK_EMAIL)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
});

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
    playerEl.play().catch(() => {});
  }
  // else: waiting for next sentence to arrive, or for the final swap.
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
      playerEl.pause();
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
  else playerEl.pause();
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
        const opt = document.createElement("option");
        opt.value = v.id;
        // Piper names already include locale, so don't repeat it.
        const suffix =
          v.engine === "piper" || !v.languages?.[0] ? "" : ` · ${v.languages[0]}`;
        const multi = v.num_speakers > 1 ? ` · ${v.num_speakers} voices` : "";
        opt.textContent = `${v.name}${suffix}${multi}`;
        og.appendChild(opt);
        _voiceSpeakerCounts.set(v.id, Number(v.num_speakers) || 1);
      }
      voiceEl.appendChild(og);
    }
    // Sync the speaker row to whichever voice ended up selected.
    onVoiceChange();
  } catch (err) {
    setStatus(`Could not load voices: ${err.message}`, true);
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

function onVoiceChange() {
  stopSpeakerPreview();
  const voiceId = voiceEl.value;
  const n = _voiceSpeakerCounts.get(voiceId) || 1;
  if (n <= 1) {
    speakerRow.hidden = true;
    speakerEl.innerHTML = "";
    return;
  }
  // Build the dropdown: "Speaker 0" through "Speaker N-1".
  speakerEl.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Speaker ${i}`;
    speakerEl.appendChild(opt);
  }
  speakerEl.value = String(Math.min(rememberedSpeaker(voiceId), n - 1));
  speakerRow.hidden = false;
}

voiceEl.addEventListener("change", onVoiceChange);
speakerEl.addEventListener("change", () => {
  stopSpeakerPreview();
  rememberSpeaker(voiceEl.value, Number(speakerEl.value));
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

    row.append(nameInput, voiceSelect, speakerSelect, delBtn);
    charactersList.appendChild(row);
  }
}

function _addCharacter() {
  const list = _loadCharacters();
  list.push({
    id: Date.now(),
    name: "",
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

// Dialogue / attribution heuristic. For each sentence, if it contains
// any kind of quote AND a character name appears (whole-word, case-
// insensitive) anywhere in the sentence, that sentence belongs to that
// character. Consecutive sentences with the same speaker collapse into
// a single segment to minimize the number of voice-switch boundaries
// in the synthesized audio.
function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _DIALOGUE_QUOTE = /["“”'‘’]/;

function segmentTextByCharacter(text, characters, fallbackVoiceId, fallbackSpeakerId) {
  const sentences = splitSentencesClient(text);
  const named = characters.filter((c) => c.name && c.name.trim() && c.voiceId);
  if (named.length === 0) {
    return [{
      voiceId: fallbackVoiceId,
      speakerId: fallbackSpeakerId,
      text: sentences.join(" "),
    }];
  }

  const charRegexes = named.map((c) => ({
    voiceId: c.voiceId,
    speakerId: typeof c.speakerId === "number" ? c.speakerId : null,
    re: new RegExp(`\\b${_escapeRegex(c.name)}\\b`, "i"),
  }));

  const segments = [];
  let current = null;
  for (const sentence of sentences) {
    let attributedVoice = fallbackVoiceId;
    let attributedSpeaker = fallbackSpeakerId;

    if (_DIALOGUE_QUOTE.test(sentence)) {
      for (const c of charRegexes) {
        if (c.re.test(sentence)) {
          attributedVoice = c.voiceId;
          attributedSpeaker = c.speakerId;
          break;
        }
      }
    }

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

async function generate() {
  const text = textEl.value.trim();
  if (!text) {
    setStatus("Type or paste some text first.", true);
    textEl.focus();
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
        };
      }
    } catch {}
  }

  _synthController = new AbortController();
  resetStream();
  sentenceOffsetsSec = [];
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

          // First usable sentence: build the reading view, wire MediaSession,
          // start playback. Nothing to listen to until now.
          if (_streamPlayhead < 0 && url) {
            enterReadingView(text);
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

          const targetTime = virtualTime();
          const wasPlaying = !playerEl.paused && !playerEl.ended;
          const startedFresh = _streamPlayhead < 0; // no playback at all yet
          _streamPlayhead = -1;
          _streamElapsed = 0;

          playerCard.hidden = false;
          // Make sure the reading view is set up — for very short inputs the
          // sentence event might not have fired the first-sentence branch.
          if (sentenceSpans.length === 0) {
            enterReadingView(text);
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
            if (wasPlaying || startedFresh) {
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
                // If we're inside an auto-continuing chapter sequence,
                // advance to the next one — this loads its text and kicks
                // off generate() on a short timer. No-op when no queue.
                _advanceChapterQueue();
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

// Try each chapter-marker family in priority order. First family with
// 2+ matches wins; later families are ignored to avoid double-splitting.
// Returns null when nothing structured was found.
function _detectChapters(text) {
  if (!text || text.length < 400) return null;
  const lines = text.split(/\r?\n/);

  // Pattern families. Each function maps a line to either null (no
  // match) or a title string.
  const families = [
    // Markdown ATX headings (# / ## / ###).
    (line) => {
      const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
      return m ? m[2].trim() : null;
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
      if (body) chapters.push({ title: hits[h].title, text: body });
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
    _updateChapterQueueUI();
    setStatus(`All ${done} chapters synthesized.`);
    return false;
  }
  const next = _chapterQueue.shift();
  _chapterCurrentIndex += 1;
  _pendingChapterTitle = next.title;
  textEl.value = next.text;
  updateCounts();
  _updateChapterQueueUI();
  // Defer so library re-render / save side effects from the previous
  // chapter complete before the next synthesis starts.
  setTimeout(() => generate(), 150);
  return true;
}

function _cancelChapterQueue() {
  if (_chapterTotalCount <= 0) return;
  _chapterQueue = [];
  _updateChapterQueueUI();
  setStatus("Chapter queue cancelled — current chapter will still save.");
}

// Single entry point for "text just arrived from outside; check it." All
// three import paths (paste / file upload / URL fetch) call this.
// Anything past this is likely a markdown doc with subheadings, not a
// real chapter list — don't pre-suggest cutting it into ~40 clips.
const MAX_AUTO_DETECT = 30;

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

function enterReadingView(text) {
  const sentences = splitSentencesClient(text);
  readingView.innerHTML = "";
  sentenceSpans = sentences.map((s, i) => {
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.index = String(i);
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
  activeSentenceIdx = -1;
  textEl.hidden = true;
  readingView.hidden = false;
  editTextBtn.hidden = false;
  saveTextBtn.hidden = true;
  textLabel.textContent = "Now reading";
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
      enterReadingView(newText);
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
    // light up as the per-sentence streaming arrives.
    enterReadingView(newText);
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
  item.className = "clip" + (clip.id === _currentClipId ? " current" : "");
  // Stamp the clip id onto the DOM node so the drag-commit pass can read
  // the visual order without looking anything up.
  item.dataset.clipId = String(clip.id);

  const dragHandle = document.createElement("div");
  dragHandle.className = "clip-drag";
  dragHandle.setAttribute("aria-label", "Drag to reorder");
  dragHandle.title = "Drag to reorder";
  // Two stacked vertical ellipses render reliably as a "grip" affordance
  // across iOS / Android / Windows fonts.
  dragHandle.textContent = "⋮⋮";
  _attachDragHandle(dragHandle, item);

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
  playBtn.addEventListener("click", () => loadClip(clip.id));

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

  // Reset button slots between play and edit when present so the
  // delete × always lives on the far right (consistent destructive zone).
  if (resetBtn) {
    item.append(dragHandle, playBtn, resetBtn, editBtn, delBtn);
  } else {
    item.append(dragHandle, playBtn, editBtn, delBtn);
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

async function exportLibrary() {
  const exportBtn = $("library-export");
  exportBtn.disabled = true;
  exportBtn.textContent = "Building…";
  try {
    const clips = await listClips();
    if (clips.length === 0) {
      setStatus("Library is empty — nothing to export.", true);
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

$("library-export").addEventListener("click", exportLibrary);
$("library-import").addEventListener("click", () => $("library-import-file").click());
$("library-import-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importLibraryFromFile(file);
  // Reset so selecting the same file twice still fires "change".
  e.target.value = "";
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

  enterReadingView(clip.text || "");
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
  safeSet("pause", () => playerEl.pause());
  safeSet("stop", () => {
    playerEl.pause();
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
      // Queue exhausted; the next sentence event (or the final swap to the
      // combined WAV) will resume playback.
      return;
    }
    navigator.mediaSession.playbackState = "none";
    // Clip is done — clear its resume position so the next play starts
    // from the beginning (and the card stops showing "1:23 / 5:00").
    const justEndedId = _currentClipId;
    await markCurrentClipPlayed();

    // Auto-advance to the next clip in the library according to _playMode.
    // Give the listener a 3-second breath between chapters so transitions
    // don't slam together — your ear needs a beat to register a chapter
    // change. Cancellable: if the user starts a different clip or hits
    // any control during the gap, _autoAdvanceTimer gets cleared by
    // whatever takes over.
    if (justEndedId) {
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

async function loadVoiceCatalog(force = false) {
  if (_voiceCatalog && !force) return _voiceCatalog;
  voiceBrowserList.innerHTML =
    '<div class="voice-browser-loading">Loading catalog…</div>';
  try {
    const res = await fetch("/api/voices/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _voiceCatalog = data.voices || [];
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
  const q = voiceBrowserSearch.value.trim().toLowerCase();
  const matches = _voiceCatalog.filter((v) => {
    if (_installedOnly && !v.installed) return false;
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
    if (_installedOnly && !_voiceCatalog.some((v) => v.installed)) {
      empty.textContent =
        "No voices installed yet. Turn off the filter to browse the catalog.";
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
  preview.title = "Preview voice";
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

function stopPreview() {
  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.removeAttribute("src");
    _previewAudio.load(); // forces the browser to release the request
  }
  _resetPreviewBtn();
}

async function togglePreview(voice, btn) {
  // Same button → toggle off.
  if (_previewBtn === btn) {
    stopPreview();
    return;
  }
  stopPreview();
  const audio = _ensurePreviewAudio();
  btn.classList.add("loading");
  btn.textContent = "…";
  _previewBtn = btn;
  audio.src = `/api/voices/sample/${encodeURIComponent(voice.id)}`;
  try {
    await audio.play();
    btn.classList.remove("loading");
    btn.classList.add("playing");
    btn.textContent = "■";
  } catch (err) {
    // Most common cause: 404 (no published sample for this voice). Mark
    // the button so the user doesn't keep retrying.
    if (_previewBtn === btn) {
      btn.classList.remove("playing", "loading");
      btn.textContent = "—";
      btn.title = "No preview available for this voice";
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
  await loadVoiceCatalog();
  renderVoiceCatalog();
  voiceBrowserSearch.focus();
});

voiceInstalledToggle.addEventListener("click", () => {
  _installedOnly = !_installedOnly;
  renderVoiceCatalog();
});

voiceBrowserClose.addEventListener("click", () => voiceBrowser.close());
voiceBrowserSearch.addEventListener("input", renderVoiceCatalog);
// Native <dialog> fires "close" both for ESC and for explicit .close() calls.
// Cleanest place to stop any in-flight preview.
voiceBrowser.addEventListener("close", stopPreview);

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
