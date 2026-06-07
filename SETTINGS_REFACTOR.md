# Settings dialog refactor — implementation plan

Owner: kmythers
Decided: 2026-06-07 (session #5196b19a)
Target version: v225v4.54
Issue tag: `#settings-hybrid`

## Why

The current settings dialog is a single long scroll with 6 flat subheaders
and ~20 rows. On phones it's the longest dialog in the app; on desktop
it's wider than it is tall. Users get lost looking for Sync, Switch key,
or the GitHub token field. Existing sticky jump-to chips (#529) help but
don't solve the underlying "too many things in one list" problem.

Decision: **hybrid pattern** — Pattern A (sidebar + drill-down) for
structural nav, Pattern E (search) layered on top, Pattern C (per-category
Advanced disclosure) inside each pane. Skip Pattern 4 (tabs) — too few
slots for our category count.

## The 6 categories (sidebar order, top → bottom)

Reading was dropped from the original 7-category sketch — nothing
naturally belonged there yet, and an empty category is worse than no
category. Add it back when there's enough reading-flow chrome to fill
it (annotation defaults, reading ruler config, etc.).

### 1. Account
**Reach for it:** first-run setup, key rotation, sync setup, admin work.

Top of pane:
- **Sync library across devices** (radios off/on + Sync now button + last-synced)
- **API key** (Switch key button + future fingerprint/role badge)

Advanced disclosure:
- Maintenance schedule form (admin-only, JS-hidden for non-admin)
- Tester keys mint/list/revoke (admin-only, JS-hidden for non-admin)

### 2. Appearance
**Reach for it:** new users picking theme, returning users hiding panes.

Top:
- **Theme** (Auto / Dark / Light) + auto-resolve status line
- **Library pane (desktop)** (Show / Hide) — gated by `settings-desktop-only`
- **Notes pane (desktop)** (Show / Hide) — same gate

Advanced disclosure ("Advanced (Book view)"):
- **Text size** (Small / Medium / Large / X-Large)
- **Typography** (Paperback / Magazine / Manuscript)

### 3. Mode
**Reach for it:** once per user; rarely revisited.

Top:
- **UI tier** (Simple / Standard / Author) + unlock hint

No Advanced — the mode picker is the whole category.

### 4. Playback
**Reach for it:** tweaking listening feel.

Top:
- **Skip interval** (2/5/10/15/30s)
- **Pause after paragraph** (Off/2/4/6s)
- **Keep screen on while playing** (Off/On)

No Advanced yet — pull A↔B loop defaults, sleep timer defaults,
repeat default, double-tap behavior in here when those land.

### 5. Help
**Reach for it:** first-run, "how do I…".

Top:
- Help & manual link
- What's new link (+ NEW badge)
- Keyboard shortcuts link
- Send feedback (mail app) link
- Send feedback (Gmail) link

Advanced disclosure:
- **Start-a-new-clip helper** radios (Show / Hide)
- Replay onboarding tips link
- Take the tour link
- Author features tour link
- GitHub section (PAT input + OAuth button + token test + collapsible help with PAT scope audit table + GitHub mock screenshot)

### 6. About
**Reach for it:** diagnostics, support.

Top:
- Version stamp + Force update button
- Listen stats panel (Today / This week / All-time + top voice / most listened + Reset)

Advanced disclosure ("Diagnostics"):
- Push debug log to debugger link (currently `hidden` until server confirms pipeline)
- Push debug log status line
- View debug log link

## Row-by-row mapping (current → new)

Read top-to-bottom of current index.html settings-dialog (lines 626-1534).

| Current home | Row | New category | Bucket |
|---|---|---|---|
| App | Mode picker | Mode | Top |
| App | Theme picker | Appearance | Top |
| App | Sync library across devices | Account | Top |
| App | Start-a-new-clip helper | Help | Advanced |
| App | Library pane (desktop) | Appearance | Top |
| App | Notes pane (desktop) | Appearance | Top |
| Player | Skip interval | Playback | Top |
| Player | Pause after paragraph | Playback | Top |
| Player | Keep screen on | Playback | Top |
| Book view | Text size | Appearance | Advanced (Book view) |
| Book view | Typography | Appearance | Advanced (Book view) |
| Help & docs | Help & manual link | Help | Top |
| Help & docs | What's new link | Help | Top |
| Help & docs | Keyboard shortcuts link | Help | Top |
| Help & docs | Send feedback × 2 | Help | Top |
| Help & docs | Push debug log link | About | Advanced |
| Help & docs | Push debug log status | About | Advanced |
| Stats | Listen stats grid | About | Top |
| Tester tools | Replay onboarding tips | Help | Advanced |
| Tester tools | Take the tour | Help | Advanced |
| Tester tools | Author features tour | Help | Advanced |
| Tester tools | View debug log | About | Advanced |
| Tester tools | Maintenance form | Account | Advanced (admin-gated) |
| Tester tools | Tester keys section | Account | Advanced (admin-gated) |
| Tester tools | GitHub section | Help | Advanced |
| Footer | Version stamp | About | Top |
| Footer | Force update button | About | Top |
| Footer | Switch key button | Account | Top |

## Behavior spec

### Desktop layout (≥ 768px)
```
┌─────────────────────────────────────────────────┐
│ Settings                                  Close │
├─────────────────────────────────────────────────┤
│ 🔍 Search settings…                            │
├──────────────┬──────────────────────────────────┤
│ Account      │ ## Account                       │
│ Appearance   │                                  │
│ Mode      ← active                              │
│ Playback     │ [Sync library row]               │
│ Help         │ [API key / Switch key row]       │
│ About        │                                  │
│              │ ▸ Advanced                       │
└──────────────┴──────────────────────────────────┘
```
- Sidebar: 160-180px wide, vertically scrollable if needed
- Sidebar item active state: accent-tinted background + accent left border
- Right pane: scrolls independently when content exceeds height
- Pane title (h3) at top of each pane — matches sidebar label

### Phone layout (< 768px)
Initial state shows the category list (full width, no content pane).

```
┌─────────────────────────────┐
│ Settings              Close │
├─────────────────────────────┤
│ 🔍 Search settings…         │
├─────────────────────────────┤
│ Account                  ›  │
│ Appearance               ›  │
│ Mode                     ›  │
│ Playback                 ›  │
│ Help                     ›  │
│ About                    ›  │
└─────────────────────────────┘
```

Tap a category → whole view slides to the pane. Header swaps:

```
┌─────────────────────────────┐
│ ← Back   Account      Close │
├─────────────────────────────┤
│ [Sync library row]          │
│ [API key row]               │
│ ▸ Advanced                  │
└─────────────────────────────┘
```

- Back chevron (`←`) replaces sidebar title when in a pane
- Search bar stays in both states; searching from category-list view
  jumps directly to the first matching pane

### Search filter
- Input pinned at top of dialog (sticky), `<input type="search">`
- 150ms debounce on input event
- Filter logic per row: match against `data-search="..."` (lowercased
  keyword soup) OR the row's `<strong>` label text
- Behavior:
  - Sidebar items dim/hide for categories with zero matches
  - Active pane shows only matching rows
  - Advanced disclosure auto-expands if any of its rows match
  - Empty result → "No settings match '<query>'" message
  - Clearing the input restores normal view
- Hitting Enter when one category has all the matches → jump to that pane

### URL hash sync
- Format: `#settings/<cat>` (e.g. `#settings/account`)
- Set when user clicks a sidebar item or opens settings via menu/link
- On openSettings with no hash → default to first category (Account)
- Hash listener: external links can `<a href="#settings/account">`
  deep-link into a pane (used by command palette + future feedback
  flows)

### State persistence
- Active category sticky per device (localStorage `narrative.settingsCat`)
  — so reopen lands you where you were
- Search input is NOT persisted — always opens empty
- Advanced disclosure open/closed state is NOT persisted (starts collapsed
  every open)

## Implementation order

Block this in one focused session. ~4-6 hours total.

1. **HTML restructure** (~90 min)
   - Replace `<dialog id="settings-dialog">…</dialog>` block in index.html
     (lines 626-1534) with the new shell + 6 panes + moved rows
   - Add `data-search="…"` attribute to every row (keyword soup pulled
     from the row's label + description)
   - Preserve EVERY id, name attribute, and class so existing app.js
     event listeners and state-binding code keep working unchanged
   - Verify with a dry boot in the browser that all controls still
     populate from localStorage on first open

2. **CSS additions** (~60 min)
   - New section in styles.css after `.settings-subheader` block
   - Selectors: `.settings-sidebar`, `.settings-sidebar-item`,
     `.settings-sidebar-item.is-active`, `.settings-content`,
     `.settings-pane`, `.settings-pane-title`, `.settings-search-row`,
     `.settings-search`, `.settings-back-btn`, `.settings-advanced`
     (`<details>` styling), `.settings-pane[hidden]` overrides
   - Media query `@media (max-width: 767px)` for drill-down layout
   - Keep existing `.settings-row`, `.settings-toggle-label`,
     `.settings-toggle-desc`, `.settings-section` styles — they still
     apply inside the new panes
   - Delete obsolete: `.settings-subheader`, the sticky jump-to chip
     styles from #529, the chip row CSS

3. **JS wiring** (~90 min)
   - New function `_setupSettingsHybrid()` called at module load
   - State: `_activeSettingsCat`, `_settingsSearchQuery`
   - Sidebar item click → `_switchSettingsCat(cat)`:
     - Update `_activeSettingsCat`
     - Toggle `.is-active` on sidebar items
     - Show target pane, hide others (`hidden` attr)
     - Update title in header
     - Update URL hash
     - Persist to localStorage
   - Phone-only behavior: clicking sidebar item adds `body[data-settings-view="pane"]`
     so CSS can swap layouts; back button removes it
   - Search input event:
     - Debounce 150ms
     - For each row, compute `matches = haystack.includes(query)`
     - Toggle `hidden` per row
     - Auto-expand parent `<details>` if any child matches
     - Update sidebar item visibility based on per-cat match count
     - Show "No matches" message in empty active pane
   - Hash listener: on hashchange, parse `#settings/<cat>` and switch
   - openSettings() — call switchCat to restored category or default to
     `account`, reset search input, collapse all `<details>` to default

4. **Manual update** (~30 min)
   - Section 7 (Settings) in manual.html → rewrite the screenshot ASCII
     and the description to match the new sidebar layout
   - Mention search bar
   - Mention Advanced disclosures
   - Cross-references from other sections (e.g. §9 onboarding) that
     point to specific Settings rows need updating to use the new
     `Settings → Account → Sync library` style breadcrumb

5. **Walkthrough updates** (~20 min)
   - Tutorials that highlight Settings rows use anchor selectors —
     verify each still resolves
   - Update `#settings-take-tour-link` step copy if needed

6. **SW + version stamp** (~5 min)
   - Bump `sw.js` CACHE to `v225v4.54`
   - Bump `#settings-version-tag` default to `v225v4.54`

7. **Smoke test** (~30 min)
   - Boot in browser at narrative-alpha.fly.dev
   - Each category opens and shows its rows
   - Switch key + Force update still work
   - Sync toggle still flips
   - GitHub PAT paste still saves
   - Mode picker still updates body[data-ui-mode]
   - Search filter narrows correctly
   - Phone viewport: drill-down + back button works
   - Hash deep-link works (`#settings/help` opens to Help pane)

8. **Deploy + browser verification** before touching desktop MSI

9. **Optional desktop rebuild** — only if you want the desktop install
   to ship with v4.54 today. Otherwise the v4.53 DevTools build keeps
   working since the API surface is unchanged.

## Gotchas to remember

- **Admin-gated sections** (maintenance, tenants) set `hidden=true` in
  HTML; existing JS unhides them based on `whoami.is_admin`. Keep that
  JS hidden-logic intact — just make sure the JS also doesn't accidentally
  un-hide the parent `<details>` summary, only the inner section
- **`advanced-only` class** still exists for Mode-gated chrome (Simple
  mode hides power-user rows). The new `.settings-advanced` `<details>`
  is a DIFFERENT mechanism (UI-level disclosure, mode-independent). Don't
  conflate them
- **`settings-desktop-only` class** still works the same — it hides the
  Library/Notes pane toggles below 1280px. Keep it
- **GitHub help disclosure** (`<details class="settings-github-help">`)
  is a separate, pre-existing `<details>`. Don't conflict with the new
  `<details class="settings-advanced">`. Nesting is fine
- **Stats panel** uses `id="stats-row"` and `class="advanced-only"`. The
  `advanced-only` class hides it in Simple mode — KEEP that. The
  container goes into About → Top (not About → Advanced disclosure)
  because mode-gating ≠ disclosure-gating
- **Sticky positioning**: don't try to make the sidebar sticky in scrolled
  state — the pane is the scroll container, not the dialog. The sidebar
  should sit in the flex layout naturally
- **Native `<dialog>` Escape handling** still closes the dialog. URL hash
  should clear or revert when dialog closes so a stale `#settings/help`
  doesn't reopen on next click

## Definition of done

- Dialog opens in ≤ 1 frame to a chosen category (no flash of all-content)
- Settings height fits on a 667px-tall iPhone SE viewport without scrolling
  within the longest pane (Help)
- Every row from the old layout has a home in the new one
- Search filter responds inside 150ms of typing stop
- Manual + walkthroughs reference the new structure
- One regression test added: open Settings → click Help → click Replay
  onboarding tips → verify the global hint state was reset (catches the
  most likely "JS handler lost its binding during DOM move" regression)
