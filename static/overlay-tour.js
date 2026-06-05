// v225v3.16 (#622) — Overlay tour engine.
//
// Shepherd-style guided tour over the live app DOM. Used for the
// "Take the tour" onboarding (#623) and any future product-led tours.
//
// Public API (window.OverlayTour):
//   start(tour)  — begin a tour
//   end(skipped) — abort/end a tour
//   next() / prev() — advance / go back (also wired to ←/→ keys)
//
// A tour is a plain object:
//   {
//     id:    "first-tour",
//     steps: [
//       {
//         target: "#voice-trigger",       // CSS selector; null = centered
//         title:  "Your narrator lives here",
//         body:   "Tap to browse voices and try samples.",
//         position: "bottom",             // top | bottom | left | right
//         before: async () => { ... },    // optional setup (open menu, etc.)
//         after:  async () => { ... },    // optional teardown
//       },
//       ...
//     ],
//     onEnd: ({skipped, completed}) => {} // optional completion callback
//   }
//
// Behavior:
//   - Spotlight cuts out the target via a CSS box-shadow trick
//     (no SVG mask needed).
//   - Tooltip auto-positions: prefers the step's `position`, falls back
//     to bottom/top/right/left if it would clip the viewport.
//   - Esc / Skip button ends the tour (onEnd fires with skipped: true).
//   - Enter / → advances; ← goes back.
//   - Targets that don't exist (e.g. phone-only element on desktop) are
//     skipped automatically with a dlog entry.
//   - resize + scroll re-render the current step so the spotlight
//     tracks if the layout shifts (e.g. virtual keyboard appears).
//   - tour state lives on localStorage key "narrative.tour.{id}.seen"
//     so callers can avoid re-prompting completed users.

(function () {
  let _active = false;
  let _tour = null;
  let _idx = -1;
  let _els = null;
  let _onKey = null;
  let _onResize = null;

  function _log(msg, data) {
    try {
      if (typeof window._dlog === "function") {
        window._dlog("tour", msg, data || {});
      }
    } catch (_) {}
  }

  function start(tour) {
    if (_active) end(true);
    if (!tour || !Array.isArray(tour.steps) || !tour.steps.length) return;
    _active = true;
    _tour = tour;
    _idx = 0;
    _mount();
    _renderStep();
    _log("started", { id: tour.id, stepCount: tour.steps.length });
  }

  function _mount() {
    const backdrop = document.createElement("div");
    backdrop.className = "overlay-tour-backdrop";
    backdrop.setAttribute("role", "presentation");
    // Clicking the backdrop is a no-op — users must explicitly Skip or
    // Next so the dismiss action is deliberate.
    backdrop.addEventListener("click", (e) => e.stopPropagation());

    const spotlight = document.createElement("div");
    spotlight.className = "overlay-tour-spotlight";

    const tooltip = document.createElement("div");
    tooltip.className = "overlay-tour-tooltip";
    tooltip.setAttribute("role", "dialog");
    tooltip.setAttribute("aria-live", "polite");

    document.body.appendChild(backdrop);
    document.body.appendChild(spotlight);
    document.body.appendChild(tooltip);
    _els = { backdrop, spotlight, tooltip };

    _onKey = (e) => {
      if (!_active) return;
      if (e.key === "Escape") {
        e.preventDefault();
        end(true);
      } else if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    document.addEventListener("keydown", _onKey);

    _onResize = () => {
      if (!_active) return;
      // Re-render to update spotlight + tooltip positions.
      _renderStep(true);
    };
    window.addEventListener("resize", _onResize);
    window.addEventListener("scroll", _onResize, { passive: true });
  }

  async function _renderStep(positionOnly) {
    if (!_active || !_tour) return;
    const step = _tour.steps[_idx];
    if (!step) {
      end(false);
      return;
    }

    // Run before-callback once per step (not on resize re-renders).
    if (!positionOnly && step.before) {
      try {
        await step.before();
      } catch (e) {
        _log("before-error", { step: _idx, msg: String(e) });
      }
    }

    // Resolve target.
    let target = null;
    if (step.target) {
      try {
        target = document.querySelector(step.target);
      } catch (_) {}
      // v225v3.45 (#779): also treat hidden / zero-sized targets like
      // missing ones. The previous check only caught null returns,
      // but querySelector can return an element that lives inside a
      // display:none ancestor (e.g. #voice-trigger inside .hero on
      // phone). getBoundingClientRect on those returns 0x0 at (0,0),
      // which painted invisible 12x12 spotlights at top-left and
      // floated tooltips with no anchor. Skip them the same way.
      const targetVisible =
        target &&
        (target.offsetWidth > 0 ||
          target.offsetHeight > 0 ||
          target.getClientRects().length > 0);
      if (!target || !targetVisible) {
        _log("target-missing", {
          step: _idx,
          sel: step.target,
          reason: !target ? "null" : "zero-size",
        });
        // Skip this step entirely on first render (don't advance on
        // resize handlers — they shouldn't restart progress).
        if (!positionOnly) {
          _idx++;
          if (_idx >= _tour.steps.length) {
            end(false);
            return;
          }
          _renderStep();
        }
        return;
      }
    }

    // Scroll target into view if needed.
    if (target && !positionOnly) {
      const rect = target.getBoundingClientRect();
      const offScreen =
        rect.top < 0 ||
        rect.bottom > window.innerHeight ||
        rect.left < 0 ||
        rect.right > window.innerWidth;
      if (offScreen) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        // Wait for scroll-into-view to settle before measuring.
        await new Promise((r) => setTimeout(r, 280));
      }
    }

    _positionSpotlight(target);
    _renderTooltip(step, target);
  }

  function _positionSpotlight(target) {
    if (!_els) return;
    if (!target) {
      // v225v3.48 (#782): centered step — hide spotlight, let backdrop
      // alone provide the scrim. Backdrop is fully opaque.
      _els.spotlight.style.display = "none";
      _els.backdrop.style.opacity = "1";
      return;
    }
    // v225v3.48 (#782): targeted step — show spotlight + cutout, HIDE
    // backdrop. Otherwise both layers contribute 0.55 black and the
    // viewport renders ~80% dim instead of 55%. The spotlight's
    // box-shadow already provides the scrim around the target.
    _els.spotlight.style.display = "block";
    _els.backdrop.style.opacity = "0";
    const r = target.getBoundingClientRect();
    const pad = 6;
    _els.spotlight.style.left = r.left - pad + "px";
    _els.spotlight.style.top = r.top - pad + "px";
    _els.spotlight.style.width = r.width + pad * 2 + "px";
    _els.spotlight.style.height = r.height + pad * 2 + "px";
  }

  function _renderTooltip(step, target) {
    if (!_els) return;
    const total = _tour.steps.length;
    const cur = _idx + 1;
    const tip = _els.tooltip;
    tip.innerHTML = "";

    const counter = document.createElement("div");
    counter.className = "overlay-tour-counter";
    counter.textContent = "Step " + cur + " of " + total;
    tip.appendChild(counter);

    if (step.title) {
      const h = document.createElement("h3");
      h.className = "overlay-tour-title";
      h.textContent = step.title;
      tip.appendChild(h);
    }

    if (step.body) {
      const body = document.createElement("div");
      body.className = "overlay-tour-body";
      body.textContent = step.body;
      tip.appendChild(body);
    }

    const actions = document.createElement("div");
    actions.className = "overlay-tour-actions";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "overlay-tour-skip";
    skipBtn.textContent = cur === total ? "Close" : "Skip tour";
    skipBtn.addEventListener("click", () => end(true));
    actions.appendChild(skipBtn);

    const spacer = document.createElement("span");
    spacer.className = "overlay-tour-spacer";
    actions.appendChild(spacer);

    if (_idx > 0) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "overlay-tour-back";
      backBtn.textContent = "Back";
      backBtn.addEventListener("click", prev);
      actions.appendChild(backBtn);
    }

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "overlay-tour-next";
    nextBtn.textContent = cur === total ? "Done" : "Next";
    nextBtn.addEventListener("click", next);
    actions.appendChild(nextBtn);

    tip.appendChild(actions);

    _positionTooltip(target, step.position || "bottom");
  }

  function _positionTooltip(target, pref) {
    if (!_els) return;
    const tip = _els.tooltip;
    tip.style.display = "block";
    // Reset so we can measure natural size.
    tip.style.left = "-9999px";
    tip.style.top = "-9999px";
    const tr = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 14;
    const margin = 8;

    if (!target) {
      // Center in viewport for "welcome" / "done" steps.
      tip.style.left = (vw - tr.width) / 2 + "px";
      tip.style.top = (vh - tr.height) / 2 + "px";
      return;
    }

    // v225v3.47 (#781): "viewport-top" / "viewport-bottom" anchor the
    // tooltip to a fixed slot on screen regardless of target position.
    // The spotlight still tracks the target. Used when the target
    // lives inside a non-modal dialog at the bottom half of the
    // viewport (Library / Voice tour steps): the bottom half is busy
    // with dialog contents, the top half is empty space — that's
    // where the tooltip should sit.
    if (pref === "viewport-top") {
      tip.style.left = (vw - tr.width) / 2 + "px";
      tip.style.top = margin + "px";
      return;
    }
    if (pref === "viewport-bottom") {
      tip.style.left = (vw - tr.width) / 2 + "px";
      tip.style.top = vh - tr.height - margin + "px";
      return;
    }

    const r = target.getBoundingClientRect();
    // Try the preferred position first, then the others in a sensible
    // fallback order if the preferred would clip.
    const order = [pref, "bottom", "top", "right", "left"].filter(
      (p, i, a) => a.indexOf(p) === i
    );

    let placed = false;
    for (const pos of order) {
      let left = 0;
      let top = 0;
      let fits = true;

      if (pos === "bottom") {
        left = r.left + (r.width - tr.width) / 2;
        top = r.bottom + gap;
        if (top + tr.height > vh - margin) fits = false;
      } else if (pos === "top") {
        left = r.left + (r.width - tr.width) / 2;
        top = r.top - tr.height - gap;
        if (top < margin) fits = false;
      } else if (pos === "right") {
        left = r.right + gap;
        top = r.top + (r.height - tr.height) / 2;
        if (left + tr.width > vw - margin) fits = false;
      } else if (pos === "left") {
        left = r.left - tr.width - gap;
        top = r.top + (r.height - tr.height) / 2;
        if (left < margin) fits = false;
      }

      if (fits) {
        // Clamp horizontally within viewport.
        left = Math.max(margin, Math.min(left, vw - tr.width - margin));
        top = Math.max(margin, Math.min(top, vh - tr.height - margin));
        tip.style.left = left + "px";
        tip.style.top = top + "px";
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Nothing fit — fall back to viewport-centered.
      tip.style.left = (vw - tr.width) / 2 + "px";
      tip.style.top = (vh - tr.height) / 2 + "px";
    }
  }

  async function next() {
    if (!_active || !_tour) return;
    const step = _tour.steps[_idx];
    if (step && step.after) {
      try {
        await step.after();
      } catch (e) {
        _log("after-error", { step: _idx, msg: String(e) });
      }
    }
    _idx++;
    if (_idx >= _tour.steps.length) {
      end(false);
      return;
    }
    _renderStep();
  }

  function prev() {
    if (!_active || !_tour || _idx <= 0) return;
    _idx--;
    _renderStep();
  }

  function end(skipped) {
    if (!_active) return;
    _active = false;
    const tour = _tour;

    if (_els) {
      _els.backdrop.remove();
      _els.spotlight.remove();
      _els.tooltip.remove();
      _els = null;
    }
    if (_onKey) {
      document.removeEventListener("keydown", _onKey);
      _onKey = null;
    }
    if (_onResize) {
      window.removeEventListener("resize", _onResize);
      window.removeEventListener("scroll", _onResize);
      _onResize = null;
    }

    if (tour) {
      try {
        if (tour.id) {
          localStorage.setItem(
            "narrative.tour." + tour.id + ".seen",
            skipped ? "skipped" : "completed"
          );
        }
      } catch (_) {}
      if (typeof tour.onEnd === "function") {
        try {
          tour.onEnd({ skipped: !!skipped, completed: !skipped });
        } catch (e) {
          _log("onEnd-error", { msg: String(e) });
        }
      }
    }
    _tour = null;
    _idx = -1;
    _log("ended", { skipped: !!skipped });
  }

  function hasSeen(id) {
    try {
      return localStorage.getItem("narrative.tour." + id + ".seen") !== null;
    } catch (_) {
      return false;
    }
  }

  // v225v3.46 (#780): expose active state so other surfaces can adapt.
  // Currently used by _openAsDrawerOrModal in app.js: when the tour is
  // running and asks to open the library/voice dialog mid-step, the
  // app uses .show() (non-modal) instead of .showModal() so the
  // dialog stays IN the normal stacking context. Otherwise <dialog>
  // would promote to the browser's top layer and obscure the tour
  // overlay (z-index 9000) completely.
  function isActive() {
    return _active;
  }

  window.OverlayTour = { start, end, next, prev, hasSeen, isActive };
})();
