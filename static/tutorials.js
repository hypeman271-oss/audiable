// v225eh (#625) — Walkthrough engine for §10 Tutorials.
//
// Loaded by both manual.html (top-of-body <script> tag) and app.js
// (for the phone manual viewer, which clones manual sections into a
// fresh DOM where inline scripts don't run). Exposes one global:
//
//   window.__narrativeBootTutorialsIn(rootEl) — scans rootEl for
//     .wt[data-walkthrough] elements and animates each.
//
// Each walkthrough is defined by an entry in WALKTHROUGHS:
//   { steps: [{action, target, ...}, ...], reset(stage) }
//
// Step actions: type, click, show, showplayer, scrub
// Each step also carries { callout: "side annotation copy",
// duration: ms } so the next step fires after a delay long enough
// to read the annotation.
//
// Off-screen walkthroughs pause via IntersectionObserver — no CPU
// spent animating things the reader can't see.

(function () {
  // Cross-frame dlog: same shape as manual.html's old inline wtlog.
  // Posts to parent if we're in an iframe; falls back to console +
  // localStorage breadcrumb for the standalone case.
  function wtlog(category, message, data) {
    const entry = {
      t: new Date().toISOString(),
      category: "tutorial:" + category,
      message: message,
      data: data || null,
    };
    try { console.log("[wt]", category, message, data || ""); } catch (_) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "tutorial-dlog", entry: entry },
          "*"
        );
      }
    } catch (_) {}
    try {
      const key = "narrative.tutorialLog";
      const cur = JSON.parse(localStorage.getItem(key) || "[]");
      cur.push(entry);
      while (cur.length > 50) cur.shift();
      localStorage.setItem(key, JSON.stringify(cur));
    } catch (_) {}
  }

  wtlog("boot", "tutorials.js loaded", {
    readyState: document.readyState,
    inIframe: window.parent !== window,
    href: location.href,
  });

  // v225ek (#627) / v225el (#628): public-domain Mark Twain. Tom
  // Sawyer is the canonical sample throughout the manual (the
  // gutenberg.org/files/74 URL is wired into both the URL-fetch
  // walkthrough and the test-resources section), so the tutorial
  // matches what the user will actually try first. Opening line of
  // Chapter 2 — the whitewash scene — picked because it's clean
  // prose, instantly recognisable, and clearly not anyone's
  // working draft.
  const SAMPLE_TEXT =
    "Tom appeared on the sidewalk with a bucket of whitewash and a long-handled brush.";

  // v225el (#628): three sentences from the whitewash scene (Tom
  // Sawyer, Chapter 2). Same public-domain source as SAMPLE_TEXT
  // above. The mirroring strings are hardcoded into manual.html's
  // mock reading view; these constants stay here for any future
  // demo that wants to surface them as JS-controlled content.
  const SAMPLE_S1 =
    "Tom appeared on the sidewalk with a bucket of whitewash and a long-handled brush.";
  const SAMPLE_S2 =
    "He surveyed the fence, and all gladness left him and a deep melancholy settled down upon his spirit.";
  const SAMPLE_S3 =
    "Thirty yards of board fence nine feet high.";

  const WALKTHROUGHS = {
    "first-listen": {
      steps: [
        {
          callout:
            "Paste or type your draft into the editor. Anything from a sentence to a full chapter works.",
          action: "type",
          target: '[data-wt="textarea"]',
          text: SAMPLE_TEXT,
          duration: 2800,
        },
        {
          callout:
            "Tap <strong>Generate</strong> to start synthesis.",
          action: "click",
          target: '[data-wt="generate"]',
          duration: 1400,
        },
        {
          callout:
            "Sentences synthesize one at a time, streaming as the audio fills in.",
          action: "show",
          target: '[data-wt="status"]',
          text: "Synthesizing — 3 of 12 sentences",
          duration: 2200,
        },
        {
          callout:
            "When the synth completes the player bar slides up.",
          action: "showplayer",
          duration: 1600,
        },
        {
          callout: "Tap ▶ to start listening.",
          action: "click",
          target: '[data-wt="play"]',
          duration: 1200,
        },
        {
          callout:
            "Audio plays. The scrubber advances; the elapsed time ticks.",
          action: "scrub",
          duration: 2800,
        },
      ],
      reset(stage) {
        const ta = stage.querySelector('[data-wt="textarea"]');
        const status = stage.querySelector('[data-wt="status"]');
        const player = stage.querySelector('[data-wt="player"]');
        const fill = stage.querySelector('[data-wt="scrub-fill"]');
        const thumb = stage.querySelector('[data-wt="scrub-thumb"]');
        const time = stage.querySelector('[data-wt="time"]');
        if (ta) { ta.textContent = ""; ta.classList.remove("typing"); }
        if (status) { status.classList.remove("shown"); status.textContent = ""; }
        if (player) player.classList.remove("shown");
        if (fill) { fill.style.transition = "none"; fill.style.width = "0%"; }
        if (thumb) { thumb.style.transition = "none"; thumb.style.left = "0%"; }
        if (time) time.textContent = "0:00 / 2:34";
        if (fill) void fill.offsetWidth;
        if (fill) fill.style.transition = "";
        if (thumb) thumb.style.transition = "";
        // v225em (#629): reset phone-variant bottombar swap state so
        // the loop starts fresh with Generate visible, Player hidden.
        const bottombar = stage.querySelector(".wt-mock-phone-bottombar");
        if (bottombar) bottombar.classList.remove("player-shown");
      },
    },

    // Tutorial 2: the indie-author revision arc. Walks through the
    // five things you can do to a sentence while listening — select,
    // flag, bookmark, voice-note, export — using a 3-sentence mock
    // reading view with a tag row above and a top bar.
    "revise-listen": {
      steps: [
        {
          callout:
            "While the audio plays, the current sentence is <strong>highlighted</strong> so you know where you are.",
          action: "show",
          target: '[data-wt="sent-2"]',
          addClass: "playing",
          duration: 1800,
        },
        {
          callout:
            "Heard something to flag? <strong>Tap a sentence</strong> to select it (dashed ring appears).",
          action: "select",
          target: '[data-wt="sent-1"]',
          duration: 1600,
        },
        {
          callout:
            "Then <strong>tap a tag</strong> in the row above — Cut, Fact, Love, Weak, etc.",
          action: "click",
          target: '[data-wt="tag-love"]',
          duration: 1600,
        },
        {
          callout:
            "The flag attaches to the sentence as a small chip — visible at a glance when you scroll back.",
          action: "show",
          target: '[data-wt="flag-1"]',
          duration: 1900,
        },
        {
          callout:
            "Long-press 🎤 to record a voice note for the current sentence. Whisper transcribes it automatically.",
          action: "click",
          target: '[data-wt="tag-mic"]',
          addClass: "recording",
          duration: 1800,
        },
        {
          callout:
            "When the transcript lands, it shows under the sentence — searchable, edit-ready, exportable.",
          action: "show",
          target: '[data-wt="transcript-2"]',
          duration: 2200,
        },
        {
          callout:
            "When the listen-through is done, tap <strong>☰ → Export notes (.md)</strong> for a single Markdown file of every flag, voice note, and bookmark.",
          action: "click",
          target: '[data-wt="menu-btn"]',
          duration: 2400,
        },
      ],
      reset(stage) {
        stage.querySelectorAll(".wt-mock-sentence").forEach((s) => {
          s.classList.remove("playing", "selected");
        });
        stage.querySelectorAll(".wt-mock-flag, .wt-mock-transcript").forEach((el) => {
          el.classList.remove("shown");
        });
        const mic = stage.querySelector('[data-wt="tag-mic"]');
        if (mic) mic.classList.remove("recording");
      },
    },

    // v225fc (#645): three new tutorials, one per Import-flow tile.
    // Each is a slimmer walkthrough than first-listen/revise-listen
    // — single mock surface, no phone variant — focused on showing
    // the path through the Import dropdown to the specific source.
    // The mock shells share .wt-mock-import structure so CSS stays
    // tight.

    // Tutorial 3: Paste an article URL.
    "paste-url": {
      steps: [
        {
          callout:
            "Tap <strong>📥 Import</strong> in the hero to open the source menu.",
          action: "show",
          target: '[data-wt="import-btn"]',
          addClass: "pressed",
          duration: 1500,
        },
        {
          callout:
            "Pick <strong>🌐 Paste URL</strong>.",
          action: "show",
          target: '[data-wt="import-menu"]',
          addClass: "shown",
          duration: 1700,
        },
        {
          callout:
            "A URL row appears. Paste any article URL — blog post, Wikipedia page, Gutenberg chapter.",
          action: "type",
          target: '[data-wt="url-input"]',
          text: "https://www.gutenberg.org/files/74/74-h/74-h.htm",
          duration: 2600,
        },
        {
          callout:
            "Tap <strong>Fetch</strong>. Narrative pulls the article text out of the HTML.",
          action: "click",
          target: '[data-wt="fetch-btn"]',
          duration: 1600,
        },
        {
          callout:
            "The clean prose lands in the editor — tap <strong>Generate</strong> to listen.",
          action: "show",
          target: '[data-wt="result"]',
          text:
            "Tom appeared on the sidewalk with a bucket of whitewash and a long-handled brush.",
          addClass: "shown",
          duration: 2400,
        },
      ],
      reset(stage) {
        const btn = stage.querySelector('[data-wt="import-btn"]');
        if (btn) btn.classList.remove("pressed");
        const menu = stage.querySelector('[data-wt="import-menu"]');
        if (menu) menu.classList.remove("shown");
        const input = stage.querySelector('[data-wt="url-input"]');
        if (input) { input.textContent = ""; input.classList.remove("typing"); }
        const fetchBtn = stage.querySelector('[data-wt="fetch-btn"]');
        if (fetchBtn) fetchBtn.classList.remove("pressed");
        const result = stage.querySelector('[data-wt="result"]');
        if (result) { result.textContent = ""; result.classList.remove("shown"); }
      },
    },

    // Tutorial 4: Upload a file.
    "upload-file": {
      steps: [
        {
          callout:
            "Tap <strong>📥 Import</strong>.",
          action: "show",
          target: '[data-wt="import-btn"]',
          addClass: "pressed",
          duration: 1500,
        },
        {
          callout:
            "Pick <strong>📄 Upload file</strong>.",
          action: "show",
          target: '[data-wt="import-menu"]',
          addClass: "shown",
          duration: 1700,
        },
        {
          callout:
            "Your system file picker opens. Choose a PDF, EPUB, DOCX, TXT, or MD up to 25 MB.",
          action: "show",
          target: '[data-wt="file-picker"]',
          addClass: "shown",
          duration: 2200,
        },
        {
          callout:
            "Narrative extracts the text — pulls clean prose out of layout, strips headers and page numbers.",
          action: "show",
          target: '[data-wt="extracting"]',
          addClass: "shown",
          duration: 2000,
        },
        {
          callout:
            "The extracted text lands in the editor — tap <strong>Generate</strong> to listen.",
          action: "show",
          target: '[data-wt="result"]',
          text:
            "Chapter 1. Down the Rabbit-Hole. Alice was beginning to get very tired of sitting by her sister on the bank…",
          addClass: "shown",
          duration: 2400,
        },
      ],
      reset(stage) {
        const btn = stage.querySelector('[data-wt="import-btn"]');
        if (btn) btn.classList.remove("pressed");
        ["import-menu", "file-picker", "extracting", "result"].forEach((k) => {
          const el = stage.querySelector('[data-wt="' + k + '"]');
          if (el) {
            el.classList.remove("shown");
            if (k === "result") el.textContent = "";
          }
        });
      },
    },

    // Tutorial 5: Browse a GitHub repo.
    "browse-github": {
      steps: [
        {
          callout:
            "Tap <strong>📥 Import</strong>.",
          action: "show",
          target: '[data-wt="import-btn"]',
          addClass: "pressed",
          duration: 1500,
        },
        {
          callout:
            "Pick <strong>📚 GitHub repo</strong>. (One-time: sign in or paste a personal access token in Settings.)",
          action: "show",
          target: '[data-wt="import-menu"]',
          addClass: "shown",
          duration: 1900,
        },
        {
          callout:
            "Paste the repo URL — Narrative remembers your recent repos and shows them as quick chips.",
          action: "type",
          target: '[data-wt="repo-input"]',
          text: "github.com/kmyth/narrative-test",
          duration: 2400,
        },
        {
          callout:
            "The picker opens a file tree. Tap any chapter — it imports text + commit SHA in one step.",
          action: "show",
          target: '[data-wt="tree"]',
          addClass: "shown",
          duration: 2200,
        },
        {
          callout:
            "The chapter lands in the editor. Later, if you push a new commit, Narrative shows an outdated banner — one tap refetches and re-narrates.",
          action: "show",
          target: '[data-wt="result"]',
          text:
            "Tom appeared on the sidewalk with a bucket of whitewash and a long-handled brush.",
          addClass: "shown",
          duration: 2600,
        },
      ],
      reset(stage) {
        const btn = stage.querySelector('[data-wt="import-btn"]');
        if (btn) btn.classList.remove("pressed");
        ["import-menu", "tree", "result"].forEach((k) => {
          const el = stage.querySelector('[data-wt="' + k + '"]');
          if (el) {
            el.classList.remove("shown");
            if (k === "result") el.textContent = "";
          }
        });
        const input = stage.querySelector('[data-wt="repo-input"]');
        if (input) { input.textContent = ""; input.classList.remove("typing"); }
      },
    },
  };

  function initWalkthrough(el) {
    // Don't double-init if app.js calls us after manual.html already did.
    if (el.dataset.wtInited === "1") {
      wtlog("init", "already inited — skipping", {
        id: el.dataset.walkthrough,
      });
      return;
    }
    el.dataset.wtInited = "1";

    const id = el.dataset.walkthrough;
    const def = WALKTHROUGHS[id];
    if (!def) {
      wtlog("init", "no definition for id", { id: id });
      return;
    }

    // v225em (#629): strip the off-viewport mock variant from the
    // DOM so querySelector only finds the active one. Without this,
    // the cursor positioning math could land on a hidden element
    // (display:none → getBoundingClientRect returns zeros), and
    // the type/click/show actions would silently target the wrong
    // mock. Belt-and-suspenders with the CSS media queries: CSS
    // handles initial paint, JS guarantees only one set of targets.
    const isPhone = window.matchMedia("(max-width: 600px)").matches;
    const keepClass = isPhone
      ? "wt-mock-variant-phone"
      : "wt-mock-variant-desktop";
    const dropClass = isPhone
      ? "wt-mock-variant-desktop"
      : "wt-mock-variant-phone";
    const dropped = el.querySelectorAll("." + dropClass);
    dropped.forEach((n) => n.remove());
    wtlog("init", "variant selected", {
      id: id,
      kept: keepClass,
      droppedCount: dropped.length,
    });

    const stage = el.querySelector(".wt-stage");
    const cursor = el.querySelector('[data-wt="cursor"]');
    const callout = el.querySelector(".wt-callout");
    const headStep = el.querySelector(".wt-head-step");
    const restartBtn = el.querySelector(".wt-head-restart");
    wtlog("init", "DOM lookup", {
      id: id,
      hasStage: !!stage,
      hasCursor: !!cursor,
      hasCallout: !!callout,
      hasHeadStep: !!headStep,
      hasRestartBtn: !!restartBtn,
      steps: def.steps.length,
    });
    if (!stage || !cursor || !callout) {
      wtlog("init", "missing required element — aborting", { id: id });
      return;
    }

    const calloutNum = document.createElement("span");
    calloutNum.className = "wt-callout-num";
    const calloutTxt = document.createElement("div");
    calloutTxt.className = "wt-callout-text";
    callout.replaceChildren(calloutNum, calloutTxt);

    let stepIdx = 0;
    let timer = null;
    let typingTimer = null;
    let visible = false;
    let started = false;

    function positionCursorOver(targetSel) {
      const target = stage.querySelector(targetSel);
      if (!target) return;
      const t = target.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const x = t.left - s.left + Math.min(28, t.width / 2);
      const y = t.top - s.top + Math.min(20, t.height / 2);
      cursor.style.transform =
        "translate3d(" + x + "px, " + y + "px, 0)";
    }

    function setCallout(text, idx, total) {
      calloutNum.textContent = idx + 1;
      calloutTxt.innerHTML = text;
      if (headStep)
        headStep.textContent =
          "Step " + (idx + 1) + " of " + total;
    }

    function runStep() {
      if (!visible) { timer = null; return; }
      if (stepIdx >= def.steps.length) {
        timer = setTimeout(() => {
          def.reset(stage);
          stepIdx = 0;
          runStep();
        }, 1800);
        return;
      }
      const step = def.steps[stepIdx];
      setCallout(step.callout, stepIdx, def.steps.length);
      if (step.target) positionCursorOver(step.target);

      if (step.action === "type") {
        const ta = stage.querySelector(step.target);
        if (ta) {
          ta.textContent = "";
          ta.classList.add("typing");
          let i = 0;
          const total = step.text.length;
          const interval = Math.max(
            20,
            Math.floor((step.duration - 400) / total)
          );
          const tick = () => {
            if (!visible) return;
            if (i < total) {
              ta.textContent = step.text.slice(0, ++i);
              typingTimer = setTimeout(tick, interval);
            } else {
              ta.classList.remove("typing");
            }
          };
          tick();
        }
      } else if (step.action === "click") {
        cursor.classList.remove("clicking");
        void cursor.offsetWidth;
        cursor.classList.add("clicking");
        const target = stage.querySelector(step.target);
        if (target) {
          target.classList.add("pressed");
          setTimeout(() => target.classList.remove("pressed"), 400);
          // Allow click steps to also add a sticky class (e.g.
          // "recording" on the mic button so its glow persists past
          // the press animation).
          if (step.addClass) target.classList.add(step.addClass);
        }
      } else if (step.action === "show") {
        const target = stage.querySelector(step.target);
        if (target) {
          if (step.text) target.textContent = step.text;
          target.classList.add("shown");
          // Optional class for "show with a state" — e.g. add
          // "playing" to a sentence to give it the active highlight.
          if (step.addClass) target.classList.add(step.addClass);
        }
      } else if (step.action === "select") {
        // Sentence-selection cue. Adds "selected" class so the
        // dashed-ring CSS kicks in; clears any prior selection on
        // sibling sentences so only the latest one is selected.
        const target = stage.querySelector(step.target);
        if (target) {
          const parent = target.parentElement;
          if (parent) {
            parent.querySelectorAll(".wt-mock-sentence.selected").forEach((s) => {
              if (s !== target) s.classList.remove("selected");
            });
          }
          target.classList.add("selected");
        }
      } else if (step.action === "showplayer") {
        const status = stage.querySelector('[data-wt="status"]');
        if (status) status.classList.remove("shown");
        const player = stage.querySelector('[data-wt="player"]');
        if (player) player.classList.add("shown");
        // v225em (#629): on the phone variant the Generate button
        // and Player bar share the bottom-bar slot. Toggling
        // .player-shown on the bottombar swaps which one is visible,
        // mirroring the real phone flow (Generate → Player after
        // synth completes). No-op on the desktop variant.
        const bottombar = stage.querySelector(".wt-mock-phone-bottombar");
        if (bottombar) bottombar.classList.add("player-shown");
        positionCursorOver('[data-wt="player"]');
      } else if (step.action === "scrub") {
        const fill = stage.querySelector('[data-wt="scrub-fill"]');
        const thumb = stage.querySelector('[data-wt="scrub-thumb"]');
        const time = stage.querySelector('[data-wt="time"]');
        const target = "85%";
        const dur = step.duration + "ms";
        if (fill) {
          fill.style.transition = "width " + dur + " linear";
          fill.style.width = target;
        }
        if (thumb) {
          thumb.style.transition = "left " + dur + " linear";
          thumb.style.left = target;
        }
        if (time) {
          const startMs = 0;
          const endMs = 134;
          const startT = performance.now();
          const updateTime = () => {
            if (!visible) return;
            const elapsed = performance.now() - startT;
            const frac = Math.min(1, elapsed / step.duration);
            const sec = Math.floor(startMs + frac * (endMs - startMs));
            const mm = Math.floor(sec / 60);
            const ss = String(sec % 60).padStart(2, "0");
            time.textContent = mm + ":" + ss + " / 2:34";
            if (frac < 1) requestAnimationFrame(updateTime);
          };
          requestAnimationFrame(updateTime);
        }
      }

      timer = setTimeout(() => {
        stepIdx++;
        runStep();
      }, step.duration);
    }

    function start() {
      if (started) {
        wtlog("start", "already started — skipping", { id: id });
        return;
      }
      wtlog("start", "begin", { id: id, totalSteps: def.steps.length });
      started = true;
      def.reset(stage);
      stepIdx = 0;
      runStep();
    }

    function stop() {
      wtlog("stop", "pausing", { id: id, lastStepIdx: stepIdx });
      if (timer) clearTimeout(timer);
      if (typingTimer) clearTimeout(typingTimer);
      timer = null;
      typingTimer = null;
      started = false;
    }

    if (restartBtn) {
      restartBtn.addEventListener("click", () => {
        stop();
        if (visible) start();
      });
    }

    if (typeof IntersectionObserver === "undefined") {
      wtlog("init", "no IntersectionObserver — falling back to immediate start", { id: id });
      visible = true;
      start();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          visible = entry.isIntersecting;
          wtlog("io", "fired", {
            id: id,
            intersecting: entry.isIntersecting,
            ratio: Math.round(entry.intersectionRatio * 100) / 100,
          });
          if (visible) {
            start();
          } else {
            stop();
          }
        });
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    wtlog("init", "observer attached", { id: id });
  }

  // Public API: scan rootEl for walkthroughs and init each.
  window.__narrativeBootTutorialsIn = function (rootEl) {
    const root = rootEl || document;
    const all = root.querySelectorAll(".wt[data-walkthrough]");
    wtlog("bootAll", "scanning", {
      found: all.length,
      ids: Array.from(all).map((el) => el.dataset.walkthrough),
      readyState: document.readyState,
      rootIsDoc: root === document,
    });
    all.forEach(initWalkthrough);
    wtlog("bootAll", "done");
  };

  // Auto-boot at document level for manual.html standalone / iframe cases.
  function autoBoot() {
    window.__narrativeBootTutorialsIn(document);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
})();
