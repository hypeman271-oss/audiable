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
const voiceBrowser = $("voice-browser");
const voiceBrowserClose = $("voice-browser-close");
const voiceBrowserSearch = $("voice-browser-search");
const voiceBrowserList = $("voice-browser-list");
const voiceInstalledToggle = $("voice-installed-toggle");
const uploadBtn = $("upload-btn");
const uploadInput = $("upload-input");
const clearBtn = $("clear-btn");
const pasteUrlBtn = $("paste-url-btn");
const urlRow = $("url-row");
const urlInput = $("url-input");
const urlFetchBtn = $("url-fetch-btn");
const speedBtn = $("speed-btn");
const sleepBtn = $("sleep-btn");
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

const synthProgress = $("synth-progress");

// ID of the clip currently loaded in the player (matches a row in IndexedDB).
// Set by generate() and loadClip(); used by the progress-save throttle to
// know which library row to update with currentTime.
let _currentClipId = null;
// Wall-clock timestamp of the last progress save; throttles timeupdate-driven
// IndexedDB writes to roughly once per PROGRESS_SAVE_INTERVAL_MS.
let _lastProgressSaveAt = 0;
const PROGRESS_SAVE_INTERVAL_MS = 5000;

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

function updateCounts() {
  const len = textEl.value.length;
  charCountEl.textContent = `${len.toLocaleString()} / 500,000`;
}

rateEl.addEventListener("input", () => {
  rateValueEl.textContent = rateEl.value;
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
        };
      }
    } catch {}
  }

  _synthController = new AbortController();
  resetStream();
  sentenceOffsetsSec = [];
  enterBusyState();
  setStatus(regenTargetId ? "Re-synthesizing…" : "Starting synthesis…");

  try {
    const res = await fetch("/api/synthesize/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voiceEl.value || null,
        rate: Number(rateEl.value),
        volume: Number(volumeEl.value) / 100,
        // Only send speaker_id when the speaker row is actually visible —
        // single-speaker voices reject the field harmlessly, but skipping
        // it keeps the wire payload clean.
        speaker_id: speakerRow.hidden ? null : Number(speakerEl.value || 0),
      }),
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
            _lastProgressSaveAt = Date.now(); // suppress an immediate redundant save
            saveClip({
              id: newClipId,
              // For regen, preserve whatever title/note/createdAt the user
              // had on the original clip so re-narration doesn't blow away
              // a custom title or note. For new clips, fall back to the
              // auto-suggested title.
              title: regenExistingMeta
                ? regenExistingMeta.title
                : makeTitle(text),
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
              createdAt: regenExistingMeta
                ? regenExistingMeta.createdAt
                : new Date().toISOString(),
            })
              .then(renderLibrary)
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
  // If we were in the reading view, drop back to the textarea so the user
  // can actually type into the (about to be empty) editor.
  if (!readingView.hidden) exitReadingView();

  textEl.value = "";
  updateCounts();

  // Decouple from the previously-loaded clip: Save text + the regen path
  // both look at _currentClipId, so leaving it pointed at the old clip
  // would mean "Save text" silently saves into the wrong row.
  _currentClipId = null;
  _lastProgressSaveAt = 0;
  saveTextBtn.hidden = true;

  // Wipe the sentence state so any leftover highlight from the previous
  // clip doesn't bleed into the next reading view.
  sentenceOffsetsSec = [];
  sentenceSpans = [];
  activeSentenceIdx = -1;

  textLabel.textContent = "Your text";
  textEl.focus();
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
  // Re-render so the ▶ indicator moves to this clip.
  renderLibrary();
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
    // If we're at the end of the queue (or there's only one clip), just stop.
    if (justEndedId) {
      const nextId = await nextClipId(justEndedId);
      if (nextId) loadClip(nextId);
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
