# Narrative — Debug Playbook

Hard-won lessons from session-long bug hunts. Read this before chasing
any "user reports X looks wrong" bug. The whole point is to not redo
the same wrong turns we made before.

This is a methodology doc — what diagnostic order to follow, what
data to gather, what fixes NOT to ship blind. Specific bug stories
live at the bottom as case studies.

---

## The Cardinal Rules

### Rule 1: Get a debug log before shipping fixes

Every speculative "this might be the bug" CSS change costs:

- A deploy (~2-5 min of downtime on Fly's rolling deploy)
- An SW cache bump (forces every user to force-update)
- The user's time testing the fix
- Adds complexity that the next bug-hunter has to revert

Five speculative fixes is half a working day burned. One debug log
captured in 60 seconds tells you definitively which surface is broken.

**Default path (v225v3.38+):** the phone auto-uploads logs to a
private GitHub repo (`narrative-debug-logs`) whenever
`_autoDownloadDebugLog(reason)` fires, AND from the manual
**Settings → Push debug log to debugger** button. The debugger
agent reads them by `git pull` of that repo. See Method 6.

If the user can't easily reach `Settings → Send feedback` (e.g.
because the bug itself traps them), **add auto-download as your first
move, not your fifth**. See Method 4.

### Rule 2: Wait for user-confirmed verification before declaring a bug closed

A probe that looks like a smoking gun is a HYPOTHESIS, not a fix.
Shipping the candidate fix is step one; **the user testing it on
their actual phone and confirming the visual outcome is step two**.
Both are required before:

- Marking the task `completed`
- Writing "Bug closed" in the playbook
- Reverting diagnostic code
- Moving on to the next item

The pattern that burned the phone-manual-contrast session: ship
fix → assume it worked → declare done in three places → user tests
and it didn't work → revert everything and embarrass-update three
documents. Skipping the wait costs more time than waiting would have.

The honest summary in a session log: "Shipped candidate fix v3.X
based on probe data. Pending user verification on phone." Then
when the user confirms — and only then — close it.

---

## The diagnostic ladder

Climb in order. Each rung is cheaper than the next. Stop as soon as
you have a clear cause.

### Rung 1: Read the bug report literally

- What surface is broken? (Specific page, specific dialog, specific
  element — not "the app".)
- What does "broken" mean? (Unreadable / unclickable / wrong
  content / wrong style / crashes.)
- What's the device + browser + theme? (Phone Chrome light theme is
  different from desktop Safari dark theme.)
- Are NEARBY surfaces broken too, or just this one? (If Settings on
  the same phone renders correctly, device-level theories are dead.)

The screenshot the user sends is data, but **what they call it is
often wrong**. A screenshot labeled "phone" could be Claude Code's
preview pane. The icons in the screenshot chrome tell you definitively
which surface it is. Look at them.

### Rung 2: Capture a debug log

**Default (v225v3.38+):** pull `../narrative-debug-logs` and read
the newest log (Method 6). The phone uploads automatically on
every Method-4 trigger and on demand via **Settings → Push debug
log to debugger**.

`Settings → Send feedback` still exports `_debugLog[]` as a local
`.txt` file — useful when the user prefers to email it, or when
the push pipeline is disabled (local dev with no env vars).
Every `_dlog(category, message, data)` call appears in there with a
timestamp, the current mode, and the build version.

If no recent log exists in the repo → ask the user to tap
**Settings → Push debug log to debugger** (or re-trigger the auto-
upload surface), then re-pull. Don't diagnose from stale logs.

### Rung 3: Probe the rendering directly

When the bug is "X looks wrong", instrument the broken surface to
report what it actually is via `_dlog`. Computed styles, theme
attribute, CSS variable values, ancestor chain — capture everything
at once.

See "Probe template" below for copy-paste code.

### Rung 4: Inject a control element

When the probe says "the CSS is correct" but the user still sees
something wrong, inject a control element with **hard-coded inline
styles** matching what the broken element should look like. If the
control looks crisp and the broken element looks wrong, the issue
is somewhere between the control's authority and the broken
element's. If both look equally wrong, the issue is below the CSS
layer (device, browser, screenshot encoder).

This is the ultimate "is it CSS or environment" test.

---

## Diagnostic Methods

Named techniques you can pull off the shelf. Each one has a specific
question it answers — pick by what you need to learn next.

### Method 1: Computed-style probe with ancestor walk

**Answers:** "What styles ARE being applied to the broken element,
and is any ancestor dimming it via opacity/filter/blend-mode?"

**When to use:** First diagnostic move on any visual bug ("X looks
wrong / faint / discolored"). Cheap, runs in milliseconds, captures
everything CSS-related at once.

**Template:** See "Probe template" section below.

**What good output looks like:** Every ancestor in the chain reports
`opacity: 1`, `filter: none`, `backdrop-filter: none`,
`mixBlendMode: normal`, `transform: none`. If all those are clean AND
the target's own color/bg values look right, **CSS is not the
problem** — move to Method 2.

**What bad output looks like:** Some ancestor has
`opacity: 0.5` or `filter: brightness(0.5)` or
`mix-blend-mode: multiply` or a non-identity transform. That
ancestor's selector is your fix target.

---

### Method 2: Control element injection

**Answers:** "Is the broken element's rendering different from a
known-good element with the same intended styles?"

**When to use:** When Method 1 came back clean — CSS is right — but
the element still looks wrong. This is the tiebreaker between
**cloning-pipeline issue**, **container-level rendering issue**,
**device-level rendering**, and **user perception**.

**Template:**

```js
// Inject a control element styled with INLINE styles matching what
// the probe says the broken element should render as. Inline styles
// have maximum CSS authority — they bypass every selector cascade,
// every injected stylesheet, every parent rule. The only things that
// can affect a control element's rendering are properties that the
// CSS engine can't override: ancestor opacity/filter/blend-mode
// (already checked in Method 1) and the device's own rendering
// pipeline.
//
// Place the control somewhere VISUALLY ADJACENT to the broken
// element so the user can compare them side by side without
// scrolling.
function _injectVisualControl(parentEl, knownGoodColor, knownGoodBg) {
  const existing = document.querySelector(".__diag-control");
  if (existing) existing.remove();
  const control = document.createElement("div");
  control.className = "__diag-control";
  control.style.cssText = [
    "position: fixed",
    "top: 72px",
    "left: 8px",
    "right: 8px",
    "z-index: 9999",
    "padding: 12px 14px",
    "background: " + knownGoodBg,
    "color: " + knownGoodColor,
    "font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
    "font-size: 14px",
    "line-height: 1.6",
    "border: 2px solid " + knownGoodColor,
    "border-radius: 8px",
    "opacity: 1",
    "filter: none",
  ].join("; ");
  control.innerHTML =
    "<strong>CONTROL TEST:</strong> Read this. Then look at the " +
    "broken content. " +
    "<button onclick=\"this.parentNode.remove()\">Dismiss</button>";
  document.body.appendChild(control);
}
```

**Three possible outcomes:**

| Control | Broken element | Conclusion |
|---------|----------------|------------|
| Crisp | Faint | Issue is in cloning/injection pipeline OR in the broken element's container (scroll, flex, etc.) |
| Faint | Faint | Issue is device-level: phone display, browser font hinting, screenshot encoder. Not a code bug. |
| Crisp | Crisp | The bug was perception or a stale screenshot. Phone displays the page correctly. |

**Tactical tip:** Use the SAME font-family, font-size, and font-weight
in the control as the broken element is supposed to use. If your
control uses a different font and only LOOKS the same to you, you
haven't actually isolated the variable.

---

### Method 3: Token resolution check

**Answers:** "What value does `var(--fg)` actually resolve to in
this context?"

**When to use:** Suspect that a CSS variable is being overridden in
a scope you didn't expect, or that the theme-boot script didn't run
in a parsed/cloned document context.

**Template:**

```js
const cs = getComputedStyle(document.documentElement);
_dlog("diag", "token resolution", {
  dataTheme: document.documentElement.getAttribute("data-theme"),
  fg: cs.getPropertyValue("--fg").trim(),
  fgDim: cs.getPropertyValue("--fg-dim").trim(),
  bg: cs.getPropertyValue("--bg").trim(),
  bgCard: cs.getPropertyValue("--bg-card").trim(),
  accent: cs.getPropertyValue("--accent").trim(),
  // ... add the tokens you care about
});
```

**Interpretation:** If `data-theme` is `light` but `--bg` resolves to
the dark value (or vice versa), the theme-boot didn't run or got
overridden. If the values match the theme but the rendered colors
look wrong, the tokens aren't the problem — move on.

---

### Method 4: Auto-download log on trigger

**Answers:** N/A — this isn't a question, it's a mechanism for
capturing the answer when the user can't.

**When to use:** When the bug itself prevents the user from reaching
`Settings → Send feedback`. Examples: modal dialog blocks taps; a
viewer covers the whole screen; the user can't read the navigation
chrome.

**Template:**

```js
// Place inside the function that opens the trapping UI, after the
// UI is rendered. ~200ms delay ensures any dlog entries fired
// during render land in the log before snapshot.
function _openTrappingUi() {
  // ... open the thing ...
  setTimeout(() => {
    try { _autoDownloadDebugLog("opened-trapping-ui"); } catch {}
  }, 200);
}
```

Always pair with a hardware-back escape (see "Auto-download log"
section below) so the user can dismiss the trap without losing the
log.

---

### Method 5: Hardware-back escape

**Answers:** N/A — this is preventive infrastructure.

**When to use:** Any overlay UI on phone. Add it once when you ship
the overlay; from then on, the back button always works as a
dismiss.

**Template:**

```js
function _openOverlay() {
  // ... open the thing ...
  try {
    history.pushState({ overlay: "my-overlay" }, "");
    const onBack = () => {
      window.removeEventListener("popstate", onBack);
      const stillOpen = /* check if the overlay is visible */;
      if (stillOpen) _closeOverlay();
    };
    window.addEventListener("popstate", onBack, { once: true });
  } catch {}
}
```

Without this, when a broken overlay traps the user, Android's back
button exits the app instead of dismissing the overlay — making it
impossible for the user to recover even via `narrative-alpha.fly.dev/`
in the address bar.

---

### Method 6: Live log fetch from GH (debugger-agent pipeline)

**Answers:** "Where's the log? What did the broken surface report?"

**When to use:** Always. This is now Step 0 of every diagnosis. It
replaces "ask the user to paste a debug log."

**How it works (v225v3.38+):**

The phone-side `_autoDownloadDebugLog(reason)` does two things:
1. Downloads the log locally (the user always has a copy).
2. Fires a background POST to `/api/debug-log` on Narrative's server.

The server (`debug_log_push.py`) commits that log to a private
GitHub repo via the Contents API:
- Repo: `hypeman271-oss/narrative-debug-logs` (env:
  `NARRATIVE_DEBUG_LOGS_REPO`)
- Token: fine-grained PAT with Contents:write on that repo only
  (env: `NARRATIVE_DEBUG_LOGS_TOKEN`)
- Filename: `logs/<UTC-iso>-<reason>-<version>.txt` —
  lexicographically sortable by upload time
- A small server-prepended header records reason, version, UA,
  tenant, upload timestamp; the body is the raw `_dlog` output.

Two trigger paths on the phone:
- **Automatic** — every existing `_autoDownloadDebugLog(reason)`
  call now also pushes. Phone manual viewer auto-uploads on open
  (reason `phone-manual-open`); other Method-4 traps inherit
  automatically.
- **Manual** — `Settings → Push debug log to debugger` (reason
  `manual-share`). Hidden by JS when `/api/debug-log/status`
  reports the pipeline is disabled (local dev with no env vars).

**Debugger agent usage:**

```bash
# First time only — clone next to the project root:
if [ ! -d ../narrative-debug-logs ]; then
  git clone https://github.com/hypeman271-oss/narrative-debug-logs ../narrative-debug-logs
fi

# Every run — pull + list newest 5:
git -C ../narrative-debug-logs pull --quiet
ls -t ../narrative-debug-logs/logs/ | head -5

# Read the matching log:
cat ../narrative-debug-logs/logs/<filename>
# or filter by reason:
ls ../narrative-debug-logs/logs/ | grep phone-manual-open | tail -1
```

**Failure modes to recognize:**

- No new log after the user reports the bug → the phone-side push
  may have failed (network, expired token, repo deleted). Ask the
  user to tap the manual Settings button so the response surfaces
  the failure reason next to the version stamp.
- Newest log is from an old session (>24h) → either the user
  hasn't reproduced yet, or auto-upload didn't fire. Don't
  diagnose from stale data — ask for a fresh capture.
- The log is missing the surface telemetry you need → add a
  Method 1 probe and re-deploy, then ask the user to trigger
  the surface and confirm a new log lands.

**Privacy / scope:** The repo is private; logs are verbatim (no
redaction) because the only readers are the operator and the
debugger agent. Logs can contain user-visible content (clip text,
narrator names) so the repo MUST stay private.

---

## Probe template

Copy this when you're chasing a visual bug. Adjust the selector and
the captured properties to your case.

```js
// Place this somewhere it'll run after the broken surface renders.
// Two requestAnimationFrames lets injected styles settle.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try {
      const html = document.documentElement;
      const cs = getComputedStyle(html);
      const target = document.querySelector(/* the broken element */);

      // Walk ancestors capturing properties that propagate visually
      // but don't show on the child's own computed style.
      const ancestors = [];
      let node = target;
      let depth = 0;
      while (node && node !== document) {
        const ncs = getComputedStyle(node);
        ancestors.push({
          depth: depth++,
          tag: node.tagName,
          id: node.id || null,
          cls: node.className || null,
          opacity: ncs.opacity,
          filter: ncs.filter,
          backdropFilter: ncs.backdropFilter || ncs.webkitBackdropFilter,
          mixBlendMode: ncs.mixBlendMode,
          isolation: ncs.isolation,
          transform: ncs.transform === "none" ? "none" : "set",
          willChange: ncs.willChange,
          color: ncs.color,
          background:
            ncs.backgroundColor === "rgba(0, 0, 0, 0)"
              ? "transparent"
              : ncs.backgroundColor,
        });
        node = node.parentNode;
      }

      _dlog("diag", "rendering probe", {
        dataTheme: html.getAttribute("data-theme"),
        viewport: window.innerWidth + "x" + window.innerHeight,
        // Resolved CSS variables:
        fgVar: cs.getPropertyValue("--fg").trim(),
        bgVar: cs.getPropertyValue("--bg").trim(),
        // ... add your own variables
        targetColor: target ? getComputedStyle(target).color : null,
        targetBg: target ? getComputedStyle(target).backgroundColor : null,
        ancestors,
      });
    } catch (e) {
      try { _dlog("diag", "probe failed", { msg: String(e) }); } catch {}
    }
  });
});
```

### Properties to check when "looks dim / faint / washed out"

These all visually dim descendants without leaving a trace on the
descendant's own computed style:

- **opacity** on any ancestor
- **filter** (blur, brightness, contrast, opacity, etc.) on any ancestor
- **backdrop-filter** on the element itself
- **mix-blend-mode** on any ancestor
- **isolation: isolate** combined with blend mode
- **transform** with `translate3d` or `perspective` (can trigger
  separate compositor layer with different rendering)
- **will-change** can do the same as transform

### Properties to check when "wrong color"

- The computed `color` value (definitive — what was actually applied)
- The resolved CSS variable values via
  `getComputedStyle(html).getPropertyValue("--fg")`
- The `data-theme` attribute on `<html>` (proves the theme-boot ran)
- Any injected `<style>` blocks in `document.head`
- Selectors that apply (use DOM Inspector → Styles panel, or
  enumerate via `Array.from(document.styleSheets)` in a pinch)

---

## Auto-download log

When a bug traps the user (UI is broken in a way that prevents
reaching `Settings → Send feedback`), don't ask them to navigate the
broken UI. Auto-download the log the moment the trap fires.

`_autoDownloadDebugLog(reason)` is defined in app.js. Call it from
anywhere — the `reason` string gets baked into the filename so
multiple auto-exports during one session are distinguishable.

```js
function _openSomeUiThatMightTrapTheUser() {
  // ... open the thing ...
  setTimeout(() => {
    try { _autoDownloadDebugLog("opened-the-thing"); } catch {}
  }, 200);
}
```

For overlay UIs specifically, pair this with a hardware-back escape:

```js
try {
  history.pushState({ overlay: true }, "");
  const onBack = () => {
    window.removeEventListener("popstate", onBack);
    if (overlayStillOpen()) closeOverlay();
  };
  window.addEventListener("popstate", onBack, { once: true });
} catch {}
```

The phone manual viewer in app.js has both. Copy that pattern.

---

## Anti-patterns

Things we've already tried that don't work as fixes. Stop yourself
from re-trying these next time.

### "Add `!important` until something sticks"

If `color: var(--fg) !important` doesn't fix it, **a more-specific
!important isn't the answer either**. CSS specificity has a ceiling.
If you're at it and it's still wrong, the cause is below the CSS layer
(opacity/filter on parent, computed style is wrong, or rendering
itself is the bug).

### "Redefine the token to a different value"

E.g. `--fg-dim: var(--fg)`. This works in development because you
can see the change. But if your selectors weren't matching the right
elements in the first place, redefining tokens just changes the value
that the wrong rule sets. Doesn't fix the cascade.

### "Brute-force every prose element"

`.manual, .manual p, .manual li, .manual h2, ... { color: var(--fg) }`.
Looks comprehensive, but if the cause is on a parent (opacity/filter)
or below CSS (rendering), no list of selectors will help. Run the
probe first.

### "Revert each guess one at a time"

If you've shipped a chain of speculative fixes and want to roll back,
do it **all at once** with one revert deploy. Don't revert v3.25, ship,
check, revert v3.26, ship, check. Each deploy costs minutes and you
end up testing a noisy combination.

### "Trust the screenshot tells you the cause"

A screenshot showing "faint text on cream" doesn't tell you whether
the CSS is wrong, the device is rendering it differently, the
screenshot encoder washed it out, or the user perceives a perfectly
crisp display as faint. The probe data tells you. The screenshot
tells you what to suspect, but probe before you fix.

---

## Quick-reference: what we have for diagnostics

| Tool | Purpose | Where |
|------|---------|-------|
| `_dlog(cat, msg, data)` | Self-diagnosing log entry | Everywhere in app.js |
| `_autoDownloadDebugLog(reason)` | Programmatic log export | app.js |
| Settings → Send feedback | User-initiated log export | Settings dialog |
| Settings → View debug log | In-app log viewer | Settings dialog |
| `?bookviewv3=0` | Disable V3 paginator | URL param |
| `_currentAppVersion()` | Build stamp string | Used in log filenames |

---

## Case study: phone manual contrast bug — closed at v3.43 (root cause: ID collision)

**Symptom:** User reports manual is unreadable on phone (Samsung Chrome
148, Android 10, light theme). Body text renders as faint slate on
cream. Settings on the same phone renders correctly.

**Total cost:** ~21 deploys across two sessions. ~6 hours of session
time. The bug went down. The pipeline built to chase it
(`narrative-debug-logs` + the debugger agent + Method 6) outlasts
the bug and will compress every future hunt.

### Phase 1: speculative fixes (v3.23–v3.30) — six deploys, zero progress

Without a debug log, jumped straight to fix attempts based on the
symptom:

| Version | Theory | Result |
|---|---|---|
| v3.23 | Samsung force-dark filter — add `color-scheme: light dark` | Didn't help |
| v3.25 | CSS rules in styles.css were too low-specificity | Didn't help |
| v3.26 | Add `!important` | Didn't help |
| v3.27 | Revert v3.23 to isolate | Didn't help |
| v3.28 | Brute-force on body + every prose element | Didn't help |
| v3.29 | Redefine `--fg-dim = --fg` | Didn't help |
| v3.30 | Revert everything, clean baseline | Necessary cleanup |

**All were guesses, none were tested against actual data.** This is
the Rung-3-skipped pattern the playbook exists to prevent.

### Phase 2: disciplined probes (v3.31–v3.36) — found a "smoking gun" that was actually a red herring

| Version | Move | Result |
|---|---|---|
| v3.31 | Hardware-back escape from phone manual viewer | User no longer trapped |
| v3.32 | Computed-style probe runs on phone manual open | Telemetry started flowing |
| v3.33 | Auto-download log on viewer open | Sidesteps the navigation trap |
| v3.34 | Probe walks ancestor chain | Captures parent-level dimming |
| v3.35 | Inject control element (Method 2) | Control = readable; manual = faint → not device, not perception |
| v3.36 | Twin control inside `.pmv-pages` + three-way font probe | font-family was the ONLY computed-style diff between controls and cloned content |

**The misleading hypothesis (v3.37):** Scoped font-family override
on `.pmv-pages`. **User verified it did not fix the bug.** The
font-family difference was real but downstream of the actual cause.

### Phase 3: pipeline build (v3.38) — the infrastructure win

Built a private GitHub repo (`narrative-debug-logs`) + server
endpoint (`/api/debug-log`) + phone auto-push so the debugger agent
could `git pull` and read logs directly. This is now Method 6.

### Phase 4: agent-driven elimination (v3.39–v3.42) — narrowed the search space

| Version | Method | What it killed |
|---|---|---|
| v3.39 | Restored phone-manual-open auto-trigger (v3.37 had reverted it prematurely) | Restored data flow |
| v3.40 | Method 1 — full ancestor walk scoped to phone viewer DOM | Killed: opacity/filter/blend-mode/transform/will-change on ancestors |
| v3.41 | Method 1 extended — `contain`/`clipPath`/`maskImage`/`::before`/`::after` + Method 2 dual controls inside `.pmv-pages` + user photograph | Killed: paint container + pseudo-element hypotheses. Photograph proved a translucent cream wash overlays the content, including `!important`-styled controls. |
| v3.42 | Sibling walk + `elementsFromPoint` at the photographed faint pixel | Identified `<h2 id="book-view">` at z-index 60, position:fixed as topmost layer at that pixel |

### Phase 5: root cause (v3.43) — ID collision

Inspection of `styles.css:9706` revealed the actual bug:

```css
#book-view:not([hidden]) {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: linear-gradient(180deg,
    rgba(225, 210, 180, 0.95), rgba(200, 175, 140, 0.98));
  ...
}
```

This rule was written for the app's `<div id="book-view" hidden>`
container (the book view takeover surface). But `manual.html`
section 6 has `<h2 id="book-view">6. Book view</h2>` — an anchor
target for the manual's table of contents.

When `_loadPhoneManualContent` cloned manual sections into the
parent document via DOMParser → cloneNode, the H2 entered the live
DOM with `id="book-view"`. The original `<div>` had the `hidden`
attribute so it was excluded by `:not([hidden])`, but the cloned H2
was visible — so the CSS rule applied to **the H2**:

- `position: fixed; inset: 0` — H2 became viewport-sized overlay
- `z-index: 60` — sat above the manual content
- `background: linear-gradient(rgba(225,210,180,0.95), rgba(200,175,140,0.98))` — **THE TRANSLUCENT CREAM WASH**

Every observation reconciled:
- ✅ `elementsFromPoint` showed `H2#book-view` topmost at the faint pixel
- ✅ The H2's own text content ("6. Book view") rendered crisp at the
  top of the viewport — that was the H2 itself, painting normally
- ✅ Real prose and inline-`!important` controls all rendered through
  the translucent gradient — washed
- ✅ Yellow background on controls became cream (mixed with the
  gradient); red border became pink (mixed); dark navy text became
  faded gray (mixed)
- ✅ Every ancestor-walk probe (v3.34/3.40/3.41) came back clean —
  because the dimming element was a SIBLING-by-id-match, not an
  ancestor

### The fix (v3.43)

Two changes, both shipped together:

**Fix A** — scope the CSS selector by element type:
```css
/* before: */ #book-view:not([hidden]) { ... }
/* after: */  div#book-view:not([hidden]) { ... }
```
One char added (`div`). H2 cloned content no longer matches.

**Fix B** — prefix every cloned id with `pmv-` in
`_loadPhoneManualContent` (H2 + nested IDs on H3/H4/anchor targets).
Defends against ALL future `#some-id` collisions on any of the 12
manual sections.

```js
const clonedH2 = h2.cloneNode(true);
if (clonedH2.id) clonedH2.id = "pmv-" + clonedH2.id;
// (and same for every nested [id] inside section content)
```

`_phoneManualGotoByAnchor` updated to try the `pmv-` prefixed
selector first.

### Lessons (priority order)

1. **ID uniqueness across document boundaries is a load-bearing
   assumption when cloning HTML.** If you `cloneNode` content
   authored for a different page into your live DOM, the cloned ids
   inherit every CSS rule, JS query, and accessibility relationship
   the host page binds to those ids. **Prefix or strip on clone.**

2. **`backgroundColor` in a probe is not `backgroundImage`.** The
   v3.42 elementsFromPoint output showed the H2 with `bg:
   rgba(0,0,0,0)` — that was the `backgroundColor` property; the
   gradient was on `backgroundImage`, which we hadn't captured. **Any
   future paint-stack probe should capture both** (`background`
   shorthand or both individual properties).

3. **An ancestor chain coming back pristine across four probes IS
   the data.** It means the cause isn't an ancestor — pivot to
   siblings, stacking contexts, or `elementsFromPoint`. Don't keep
   running the same probe class hoping for a different answer.

4. **The user's photograph was the breakthrough, not the log.** The
   logs told us font/color were correct on the broken element. The
   photograph told us the CONTROLS — with `!important` inline styles
   — also rendered washed. That ruled out "the cloned `<p>` is the
   problem" and forced the pivot to "something is overlaying
   everything." A 30-second screenshot beat hours of probe analysis.

5. **Don't claim closure before user-verified verification.** v3.37
   was shipped with "fix landed, marked closed" in three places. The
   user tested and it hadn't. Rule 2 of this playbook was born here.

6. **Speculative-fix backstop kicked in at the right time.** Phase 1
   was six deploys of guessing. Phase 2+ was fifteen deploys of
   data-driven elimination. The backstop is "stop after THREE
   speculative fixes," and the moment we stopped speculating and
   started probing was where progress restarted.

7. **The debug-log push pipeline is a force multiplier.** Once Method 6
   was in place, the agent could read fresh phone telemetry without
   human paste-and-format. v3.39 → v3.43 ran on this loop; each
   round took ~2 minutes of human time (force-update, open, back
   out) and yielded a fresh log the agent could diagnose from.

8. **`elementsFromPoint` is gold for "everything looks fine in CSS
   but it's still wrong" bugs.** It tells you what the browser is
   ACTUALLY painting at a known-broken pixel. Add it to Method 1
   when ancestor walks come back clean.

---

## When updating this doc

- Add a case study after every multi-deploy bug hunt. The pattern
  is: symptom → wrong theories → the data that closed it → lessons.
- Don't append history. If a probe template improves, replace the
  old one; don't list both.
- Link from ARCHITECTURE.md when this doc becomes load-bearing.
