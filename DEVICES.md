# Device & viewport map

Owner: kmythers
Living doc — update when a new surface ships or a breakpoint moves.

## Why this exists

Narrative has three viewport tiers and two native shells. Most UI surfaces
exist on only ONE or TWO of them. Changes that look like "fix the
settings dialog" or "tweak the player bar" often only touch one tier —
but the CSS, JS, and HTML can still affect the others if we're not
careful. This map answers: **before I touch X, which devices does X
actually live on?**

**Workflow rule:** before writing code that touches any UI surface,
state explicitly which tiers will be affected and confirm with the user
if more than one is in scope. If a "phone-only" surface request slips
out as "make this change" without specifying, default to phone-only +
ask before extending to desktop. Same in reverse.

## Viewport tiers

| Tier | Breakpoint | Typical device |
|------|------------|----------------|
| **Phone** | `< 768px` width | Android, iPhone (PWA + Tauri shell) |
| **Tablet / narrow desktop** | `768px – 1279px` | iPad, small laptop windows, half-screen browsers |
| **Wide desktop** | `≥ 1280px` | Full-screen laptop/monitor, Tauri Windows + macOS |

CSS media queries in styles.css that gate tier-specific chrome:
- `@media (max-width: 767px)` — phone-only rules
- `@media (max-width: 1279px)` — phone + tablet (anything BELOW wide)
- `@media (min-width: 1280px)` — wide-desktop-only (side panes live here)
- `.settings-desktop-only` class — hidden below 1280px

Body data attributes that gate behavior:
- `body[data-multipane-library]` — wide-desktop only, library pinned to left
- `body[data-multipane-author]` — wide-desktop only, notes pane pinned to right
- `body[data-pane-hidden-library="1"]` — user hid the left pane (≥1280)
- `body[data-pane-hidden-author="1"]` — user hid the right pane (≥1280)
- `body[data-ui-mode]` — Simple / Standard / Author (independent of tier)

## Native shell layers

| Shell | Origin | Notes |
|-------|--------|-------|
| Browser PWA | `narrative-alpha.fly.dev` | Default. All tiers reachable. Service Worker active. |
| Tauri desktop (Windows) | `http://tauri.localhost` (v2) | Wraps wide-desktop UI. Native File/View/Help menu. Auto-updater. CORS allow-list must include this origin. |
| Tauri desktop (macOS) | `tauri://localhost` (v2) | Same UI as Windows shell. Different scheme. Not yet shipped. |
| Tauri Android | navigates WebView → `https://narrative-alpha.fly.dev/` | Bypasses embedded static; runs the live Fly shell at phone tier. |

## Device matrix — what lives where

✅ = present, native to that tier · 🔁 = present but moves/swaps between tiers · ❌ = absent

| UI surface | Phone | Tablet | Wide desktop |
|---|:---:|:---:|:---:|
| Hero header (brand + tagline + icon rail) | 🔁 phone variant | ✅ | ✅ |
| Top icon rail (?, Ctrl K, ⚙) | ❌ | ✅ | ✅ |
| Phone icon rail (?, 📥, 🎤, ☰) | ✅ | ❌ | ❌ |
| ☰ menu sheet (Library / Settings / Help / Voice) | ✅ | ❌ | ❌ |
| Pull-up drawer (chevron above player bar) | ✅ | ❌ | ❌ |
| Tag row (annotation chips above player) | ✅ | ❌ | ❌ |
| Fixed-bottom player bar | ✅ | ❌ | ❌ |
| Fixed-bottom Generate audio bar | ✅ | ❌ | ❌ |
| Reading view (main content) | ✅ | ✅ | ✅ |
| Player card (full-size with controls) | ❌ | ✅ | ✅ |
| Library list as dialog | ✅ | ✅ | ❌ |
| Library pinned to LEFT pane | ❌ | ❌ | ✅ |
| Voice picker as dialog | ✅ | ✅ | ❌ |
| Voice picker pinned to RIGHT pane (top) | ❌ | ❌ | ✅ |
| Notes/Author pane (RIGHT, "This clip") | ❌ | ❌ | ✅ |
| Pane reopen pills (📚 left, 📝 right) | ❌ | ❌ | ✅ |
| Drag-to-resize handles on side panes | ❌ | ❌ | ✅ |
| Mini-player (sticky top bar on scroll) | ❌ | ✅ | ✅ |
| Dual chip strips (hero inline + floating clone) | ❌ | ✅ | ✅ |
| Command palette (Cmd/Ctrl+K) | ❌ | ✅ | ✅ |
| Phone manual viewer (swipeable section sheets) | ✅ | ❌ | ❌ |
| Desktop manual (iframe dialog with TOC sidebar) | ❌ | ✅ | ✅ |
| Book view 3D page-flip | ✅ | ✅ | ✅ |
| Two-page spread ("magazine mode") in book view — flag-gated, OFF by default (`narrative.bookTwoUp`/`?booktwoup=1`); single centered page is the v4.140 default on all tiers | ❌ | ✅ | ✅ |
| Phone tour (overlay walkthrough) | ✅ | ❌ | ❌ |
| Desktop tour (overlay walkthrough) | ❌ | ✅ | ✅ |
| Author features tour | ❌ | ✅ | ✅ |
| Settings dialog | ✅ | ✅ | ✅ |
| Bookmark editor (centered floating card) | ✅ | ✅ | ✅ |
| Annotate palette | ✅ | ✅ | ✅ |
| Native menu bar (File / View / Help) | ❌ | ❌ | ✅ Tauri only |
| Auto-updater (Help → Check for updates) | ❌ | ❌ | ✅ Tauri only |
| Force update / Switch key buttons | ✅ | ✅ | ✅ |
| Stale-audio banner (per-card + in-view) | ✅ | ✅ | ✅ |
| Re-narrate chip on library card | ✅ | ✅ | ✅ |

## Per-feature lookup — where the same intent lives on each tier

These are common features users invoke from different surfaces depending
on tier. When changing how a feature works, hit ALL the entry points.

### Open the library
- **Phone:** ☰ menu → Library item, opens dialog
- **Tablet:** Library icon in hero rail, opens dialog
- **Wide desktop:** Library is the LEFT side pane — always visible unless user hid it; can also reopen via 📚 pill

### Open the voice picker
- **Phone:** 🎤 icon in phone header, opens dialog
- **Tablet:** Voice icon in hero rail, opens dialog
- **Wide desktop:** Voice picker is at the TOP of the RIGHT pane — always visible unless user hid the pane

### Import a document
- **Phone:** 📥 icon in phone header → centered modal Import sheet
- **Tablet / desktop:** "Import ▾" dropdown next to YOUR TEXT label → dropdown menu

### See "what's in this clip" (flags, bookmarks, notes)
- **Phone:** pull-up drawer (tap chevron) → tag row + drawer sections
- **Tablet:** scroll through reading view; no dedicated panel
- **Wide desktop:** RIGHT pane, "This clip" section (flags, bookmarks, notes preview)

### Re-narrate this clip with a new voice
- **All tiers:** Library → card's 🔄 Re-narrate chip
- **Wide desktop also:** voice picker in the right pane is visible while reading

### Adjust playback (skip, speed, sleep, A↔B, repeat)
- **Phone:** pull-up drawer → Playback strip (Listening slot for now-playing)
- **Tablet / desktop:** chip row in/around the player card; floating chip strip when scrolled

### Edit a sentence inline (Smart ✎)
- **All tiers:** select sentence → ✎ icon in hero/header lights up → tap
- Sentence-select gestures differ: drag on touch, click on desktop

## Common change scopes — "if you touch X, also check Y"

| Change | Also check |
|---|---|
| Hero header / icon rail | Phone variant in `#phone-header` is a separate DOM tree |
| Settings dialog | Lives in ALL tiers; refactor must work in modal at < 1280 and in modal at ≥ 1280 |
| Player chip behavior | Three places: phone pull-up Playback strip · player-card chip row · floating hero chip clone (≥ 768) |
| Library item rendering | One source `makeClipCard()`, but it renders inside library dialog (phone/tablet) AND inside the pinned left pane (wide desktop) |
| Voice picker | One source `#voice-dialog`, but its body is relocated into the right pane on wide desktop (#647). Code must handle the "where am I rendered?" question |
| Book view paginator | v4.140: single centered page (one-up) is the default on ALL tiers — text capped to a 40rem readable column (`.book-view-spread.v3.one-up`). The two-page spread ("magazine mode") is preserved behind `_bookViewTwoUpEnabled()` (off by default, never on phone). Viewport size still affects page height + how much text fits per page |
| Manual content | `manual.html` is shared, but the phone viewer clones sections into its own DOM (#525); the desktop manual loads it in an iframe with sticky TOC sidebar (#530) |
| Tour steps | Phone tour has its own step content (#779) separate from desktop tours (#622+) |
| New first-tap hint | Phone gets a pill anchored to a phone surface; desktop usually doesn't need one (icons are always visible) |
| API call surface (`/api/*`) | Same on all tiers — server-side change affects every shell at once. Browser-PWA reloads via SW; Tauri picks up next launch |
| CORS allow-origin list | Affects every Tauri shell separately (Windows `http://tauri.localhost`, macOS `tauri://localhost`, Android navigates to Fly so it's same-origin) |

## How to use this in practice

When the user says **"on the desktop, …"**:
- Wide desktop only by default (≥1280)
- Check the device matrix — is the surface really wide-only? If it lives on tablet too, ask whether to include tablet
- The matching wide-desktop CSS is usually inside `@media (min-width: 1280px)` blocks OR uses `body[data-multipane-*]` gates

When the user says **"on the phone, …"**:
- Phone tier only (< 768)
- Check whether the surface is `#phone-header`, `#phone-menu`, `#phone-pullup`, or the reading view in phone mode
- Most phone-only CSS is in `@media (max-width: 767px)` blocks; some scope by tag inside `#phone-pullup` / `#phone-menu` (#778)
- Tauri Android also runs phone tier — usually nothing extra to do, since it just opens Fly

When the user says **"everywhere"** or doesn't specify:
- Ask explicitly which tiers are in scope BEFORE writing code
- If the surface is genuinely shared (Settings, Bookmark editor, Annotate palette), proceed but note in the commit which tiers were verified

When the user says **"in the Tauri desktop app"**:
- Wide desktop tier + Tauri-shell layer
- Changes can be in lib.rs (Rust), tauri.conf.json (bundle config), capabilities/default.json (perms), or the static UI (which is embedded in the binary at build time — needs a desktop rebuild to ship)
- Server-side fixes (CORS, etc.) reach the Tauri shell at next launch without a rebuild

When the user says **"in the Android app"**:
- Phone tier + Tauri Android shell
- Since v4.43 the Android shell navigates to Fly directly, so most fixes ship via Fly deploy and reach Android on next launch
- Native Android changes (manifest, build) need an APK rebuild + sideload

## Maintenance

Update this file when:
- A new UI surface lands → add it to the matrix
- A breakpoint moves → update the Viewport tiers section
- A surface migrates between tiers → both old and new rows change
- A Tauri config change affects what works in a shell → add to the shell layers
