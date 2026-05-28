const $ = (id) => document.getElementById(id);

const textEl = $("text");
const charCountEl = $("char-count");
const voiceEl = $("voice");
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
const textLabel = $("text-label");
const libraryCard = $("library-card");
const libraryList = $("library-list");
const libraryClearBtn = $("library-clear");
const playModeBtn = $("play-mode-btn");
const libraryLabel = $("library-label");
const librarySearch = $("library-search");
const browseVoicesBtn = $("browse-voices-btn");
const voiceBrowser = $("voice-browser");
const voiceBrowserClose = $("voice-browser-close");
const voiceBrowserSearch = $("voice-browser-search");
const voiceBrowserList = $("voice-browser-list");
const uploadBtn = $("upload-btn");
const uploadInput = $("upload-input");
const speedBtn = $("speed-btn");
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

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    if (!res.ok) throw new Error(`voices request failed: ${res.status}`);
    const data = await res.json();
    voiceEl.innerHTML = "";
    if (!data.voices || data.voices.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No voices found on this system";
      opt.disabled = true;
      voiceEl.appendChild(opt);
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
        opt.textContent = `${v.name}${suffix}`;
        og.appendChild(opt);
      }
      voiceEl.appendChild(og);
    }
  } catch (err) {
    setStatus(`Could not load voices: ${err.message}`, true);
  }
}

// Decode a base64 string to a Uint8Array for Blob construction.
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function generate() {
  const text = textEl.value.trim();
  if (!text) {
    setStatus("Type or paste some text first.", true);
    textEl.focus();
    return;
  }

  _synthController = new AbortController();
  resetStream();
  sentenceOffsetsSec = [];
  enterBusyState();
  setStatus("Starting synthesis…");

  try {
    const res = await fetch("/api/synthesize/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voiceEl.value || null,
        rate: Number(rateEl.value),
        volume: Number(volumeEl.value) / 100,
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
          const newClipId = Date.now();
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
              title: makeTitle(text),
              text,
              voiceId: voiceEl.value || null,
              voiceName,
              rate: Number(rateEl.value),
              volume: Number(volumeEl.value) / 100,
              sentenceOffsetsSec: sentenceOffsetsSec.slice(),
              blob: combined,
              durationSec: isFinite(playerEl.duration) ? playerEl.duration : 0,
              progressSec: 0,
              createdAt: new Date().toISOString(),
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
  textLabel.textContent = "Now reading";
}

function exitReadingView() {
  textEl.hidden = false;
  readingView.hidden = true;
  editTextBtn.hidden = true;
  textLabel.textContent = "Your text";
  sentenceSpans.forEach((s) => s.classList.remove("active", "played"));
  activeSentenceIdx = -1;
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
  const activeSpan = sentenceSpans[idx];
  if (activeSpan) {
    // Keep the active sentence visible inside the scrollable reading view.
    activeSpan.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
const PLAY_MODES = ["newest", "oldest", "longest", "shortest", "shuffle"];
const PLAY_MODE_LABELS = {
  newest: "Newest first",
  oldest: "Oldest first",
  longest: "Longest first",
  shortest: "Shortest first",
  shuffle: "Shuffle",
};
const PLAY_MODE_KEY = "narrative.playMode";

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
        (c.voiceName || "").toLowerCase().includes(query)
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

  for (const clip of clips) {
    const item = document.createElement("div");
    item.className = "clip" + (clip.id === _currentClipId ? " current" : "");

    const playBtn = document.createElement("button");
    playBtn.className = "clip-play";
    playBtn.type = "button";
    playBtn.setAttribute("aria-label", `Play ${clip.title}`);
    const titleEl = document.createElement("span");
    titleEl.className = "clip-title";
    titleEl.textContent = clip.title || "(untitled)";
    const metaEl = document.createElement("span");
    metaEl.className = "clip-meta";
    metaEl.textContent = formatClipMeta(clip);
    playBtn.append(titleEl, metaEl);
    playBtn.addEventListener("click", () => loadClip(clip.id));

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

    item.append(playBtn, delBtn);
    libraryList.appendChild(item);
  }
}

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
  if (clip.voiceId) voiceEl.value = clip.voiceId;
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
  const q = voiceBrowserSearch.value.trim().toLowerCase();
  const matches = _voiceCatalog.filter((v) => {
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
    voiceBrowserList.innerHTML =
      '<div class="voice-browser-loading">No voices match.</div>';
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
  return row;
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
  await loadVoiceCatalog();
  renderVoiceCatalog();
  voiceBrowserSearch.focus();
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
