# Dead-code audit — `static/app.js` (v225v4.17)

Generated: 2026-06-06

Source: `E:/audiable/static/app.js` (31,098 lines)

Scope: function definitions in `app.js` only. Cross-referenced against:
- `static/app.js`
- `static/index.html`
- `static/sentence-ids.js`
- `static/tutorials.js`
- `static/overlay-tour.js`
- `static/sw.js`

This is **research output**. Nothing was deleted. The human reviewer should
verify each candidate before removal — see the **Risks** section first.

---

## Strong candidates (1 occurrence — definition only)

Only two functions appear *nowhere except their own definition line*.

| Name | Line | Signature | Notes |
|---|---|---|---|
| `_refreshMaintenanceFormVisibility` | 1695 | `function _refreshMaintenanceFormVisibility()` | Admin-only maintenance-window UI helper. Not called from anywhere. Adjacent helpers (`_populateMaintenanceForm`, `_startMaintenanceTick`) are wired up; this one was orphaned. |
| `_pruneOldDays` | 6486 | `function _pruneOldDays(stats)` | Stats-housekeeping helper. Not called from `_loadStats`, `_recordListenDelta`, or any boot path. Likely vestigial from an earlier stats rollup design. |

---

## Review candidates (2 occurrences — definition + 1 caller)

These are real but tightly-coupled: each has exactly one call site. Worth
asking *"why is this its own function?"* — many are good candidates for
inlining, and a few may be dead branches where the lone caller is itself dead.

Each row's caller is in `app.js` unless noted.

### Maintenance / install / settings (lines ~1100–2520)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_isWhatsNewUnread` | 356 | app.js:2660 | Drives the "what's new" badge. Single read. |
| `_addPendingSynth` | 1119 | app.js:10835 | Offline-queue write. Pair with `_clearPendingSynth` (3 refs). |
| `_isIosSafari` | 1227 | app.js:1268 (`_initInstallBanner`) | iOS install-prompt detector. |
| `_maintenanceIsDismissed` | 1567 | called from `_renderMaintenanceBanner` | Dismissed-state check. |
| `_maintenanceMarkDismissed` | 1578 | called from `_renderMaintenanceBanner` | Inverse of above. |
| `_startMaintenanceTick` | 1669 | called from `_renderMaintenanceBanner` | Countdown ticker. |
| `_populateMaintenanceForm` | 1714 | called from `_refreshAdminSectionsVisibility` | Admin-only form. |
| `_initSettingsNav` | 2391 | called from settings init | Nav setup. |
| `_refreshSettingsNavChips` | 2403 | called from settings init | Chip refresh. |
| `_refreshSettingsFingerprint` | 2517 | called from settings init | Fingerprint check. |

### Manual viewer / panes (lines ~2800–3800)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_routeManualClickWithFirstOpen` | 2815 | app.js boot | First-open special-case wrapper. |
| `_applyVoicePaneLayout` | 3041 | called once from layout boot | Voice-pane width. |
| `_ensurePhoneManualViewer` | 3783 | called from `_openPhoneManualViewer` | Lazy-mount helper. |

### Github OAuth / feedback / tour / debug (lines ~4970–5800)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_fetchGithubOAuthStatus` | 4971 | app.js:5016 (`_refreshGithubOAuthUI`) | OAuth status fetch. |
| `_fetchGithubUser` | 4983 | called from `_refreshGithubOAuthUI` | User-info fetch. |
| `_buildFeedbackParts` | 5104 | called from `_refreshFeedbackHref` | mailto link builder. |
| `_refreshFeedbackHref` | 5139 | called once | Top-level boot. |
| `_buildAuthorTour` | 5498 | called from `_launchTour` switch | Author-mode tour. |
| `_pushDebugLogToServer` | 5796 | called from `_autoDownloadDebugLog` | Log shipping. |

### Player / repeat / sleep / stats (lines ~5840–6700)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_loadSavedSpeed` | 5962 | app.js:5967 (init expression) | One-shot localStorage read. |
| `_cycleRepeatMode` | 6082 | wired to repeat-chip click | UI handler. |
| `_formatCountdown` | 6198 | called from `_updateSleepBtn` | Sleep-timer formatter. |
| `_cancelSleepFade` | 6237 | called from `cancelSleepTimer` | Fade-cancel helper. |
| `clearAbLoop` | 6384 | called once | A/B loop UI. |
| `_loadStats` | 6447 | called once at boot | Stats-load boot. |
| `_recordListenDelta` | 6495 | called from media-time tick | Stats accumulator. |
| `_statsTodaySec` | 6552 | called from `_renderStatsPanel` | Today aggregator. |
| `_statsWeekSec` | 6556 | called from `_renderStatsPanel` | Week aggregator. |
| `_statsTopVoiceId` | 6567 | called from `_renderStatsPanel` | Top-voice aggregator. |
| `_statsTopClipId` | 6576 | called from `_renderStatsPanel` | Top-clip aggregator. |
| `_resetStats` | 6601 | called from settings-reset btn | Stats clear. |
| `_sentenceStartSec` | 6715 | called from `addBookmarkAtCurrentTime` | Sentence-time lookup. |

### Bookmarks / mini player / counts (lines ~6700–7800)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `updateBookmarkNote` | 6993 | called from bookmark editor save | Note write. |
| `_loadSkipInterval` | 7267 | called once | Boot localStorage. |
| `setSkipInterval` | 7285 | settings-pane handler | Skip-interval setter. |
| `_scrollToPlayer` | 7429 | called from `_updateMiniPlayerState` | Smooth-scroll helper. |
| `enterBusyState` | 7517 | called from `generate` | Busy-state UI. |
| `exitBusyState` | 7527 | called from `generate` | Inverse. |
| `_estimateReadSeconds` | 7543 | called from `updateCounts` | Read-time estimator. |
| `_countFillerWords` | 7620 | called from `updateCounts` | Filler counter. |
| `_pulseEmptyStateTutorialLinks` | 7758 | called from boot | Empty-state pulse. |

### Voices / speakers / wizard (lines ~7900–9100)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_saveSpeakerMap` | 7978 | called from `rememberSpeaker` | Storage write. |
| `rememberedSpeaker` | 7984 | called from `onVoiceChange` | Storage read. |
| `_getLastGithubRepo` | 8082 | called from `loadClip` | Recent-repo getter. |
| `_setLastGithubRepo` | 8089 | called from openGithubBrowser | Recent-repo setter. |
| `_captureGithubOAuthRedirect` | 8110 | called once at boot | OAuth callback handler. |
| `_isGithubUrl` | 8179 | called from `fetchFromUrl` | URL classifier. |
| `_isGistUrl` | 8202 | called from `fetchFromUrl` | URL classifier. |
| `isFavoriteVoice` | 8222 | called from `renderVoiceCatalog` | Favorite check. |
| `toggleFavoriteVoice` | 8226 | called from voice-card click | Favorite toggle. |
| `_refreshFavoritesInMainPicker` | 8245 | called from `toggleFavoriteVoice` | Picker refresh. |
| `_openVoiceApplyPicker` | 8644 | called from voice-apply btn | Multi-pick picker. |
| `_renderVoiceApplyMultipickList` | 8684 | called from `_openVoiceApplyPicker` | Picker list render. |
| `_saveAllSpeakerFavs` | 8920 | called from `toggleSpeakerFav` | Speaker-fav save. |
| `isStarredSpeaker` | 8932 | called from `renderSpeakerWizard` | Star check. |
| `toggleSpeakerFav` | 8936 | called from speaker-wizard click | Star toggle. |
| `_wizardCurrentIds` | 8955 | called from `_wizardPageIds` | Page-id getter. |
| `_wizardPlay` | 8982 | called from `renderSpeakerWizard` | Audition play. |
| `_updateWizardStarredChip` | 9014 | called from `renderSpeakerWizard` | Chip refresh. |
| `_currentPresetSnapshot` | 9209 | called from preset-save btn | Snapshot helper. |
| `_suggestPresetName` | 9218 | called from preset-save btn | Auto-name helper. |
| `applyPreset` | 9231 | called from preset-row click | Preset application. |
| `deletePreset` | 9274 | called from preset-row click | Preset removal. |

### Characters / attribution (lines ~9500–10500)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_openSentenceAssignmentDialog` | 9668 | called from sentence long-press | Assignment dialog. |
| `_updateAssignSelectVisuals` | 9803 | called from drag selection | Visual update. |
| `_renderAssignSelectBar` | 9815 | called from drag selection | Bar render. |
| `_attachSentenceAssignHandlers` | 9917 | called once per sentence span | Per-sentence wiring. |
| `attributeSentencesForDisplay` | 10008 | called from reading-view renderer | Attribution apply. |
| `findNamed` | 10022 | nested in `attributeSentencesForDisplay` | Inner helper. (Local closure — counted because it's named.) |
| `_populateVoiceOptions` | 10155 | called from `_populateSpeakerOptions`? | Verify caller. |
| `_hslToHex` | 10300 | called from `_characterColor` | Color helper. |

### Synth pipeline / chapters (lines ~10800–13800)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_openSynthJobStream` | 13137 | called from `_preSynthesizeChapter` | SSE stream opener. |
| `_cancelChapterQueue` | 13801 | called once on cancel-btn click | Cancel handler. |
| `_detectParagraphEndIndices` | 13936 | called from `enterReadingView` | Paragraph parser. |
| `_readParagraphPauseSec` | 13960 | called from `_triggerParagraphPause` | Pref read. |
| `_wrapSentenceWordsOnce` | 14553 | called from `_paintActiveWord`? | Word-wrap one-shot. |
| `_computeWordIntervals` | 14605 | called from `_paintActiveWord`? | Interval calc. |
| `_paintActiveWord` | 14630 | called from media-time tick | Word highlight. |

### Reading view / book view (lines ~14800–20000)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_getSelectionInsideSentence` | 15494 | called from highlight handler | Selection probe. |
| `_showHighlightToolbar` | 15539 | called from highlight handler | Toolbar show. |
| `_listAnnotations` | 15746 | called from `_applyAnnotationMarkers` | Anno list getter. |
| `_revealChipDelete` | 15972 | called from chip long-press | Delete reveal. |
| `_showAnnotatePalette` | 16208 | called from sentence long-press | Palette show. |
| `_voicePauseMainPlayback` | 16846 | called from `_voiceStart` | Playback pause. |
| `_voiceUpdateTimer` | 17083 | called from `_voiceStart` timer | Timer tick. |
| `_voiceCancel` | 17104 | called from cancel btn | Voice-note cancel. |
| `_voiceFinalize` | 17143 | called from `_voiceStop` | Finalize handler. |
| `_clearPendingTranscribe` | 17244 | called from `_drainPendingTranscribes` | Pending clear. |
| `_voiceShowRecordRow` | 17375 | called from `_voiceStart` | Record-row UI. |
| `_voicePlayAnno` | 17436 | app.js:17419 | Anno playback. |
| `_bookViewDetectChapters` | 17521 | called from `_bookViewPaginate` | Chapter detect. |
| `_bookViewChapterAt` | 17566 | called from book-view nav | Chapter lookup. |
| `_bookViewAnimationsEnabled` | 18049 | called from `_bookViewRenderSpread` | Anim pref check. |
| `_bookViewV2Setup` | 18158 | called from `_enterBookViewV2` | V2 setup. |
| `_bookViewV2FirstSentenceIdxAtSpread` | 18407 | called from `_bookViewV2GotoSentenceIdx` | V2 lookup. |
| `_enterBookViewV2` | 18491 | called from `enterBookView` v2 branch | V2 entry. |
| `_bookViewV3FirstSentenceIdxAtSpread` | 18880 | called from `_bookViewV3GotoSentenceIdx` | V3 lookup. |
| `_bookViewV3PageOfSentence` | 18904 | called from `_bookViewV3GotoSentenceIdx` | V3 page lookup. |
| `_enterBookViewV3` | 19012 | called from `enterBookView` v3 branch | V3 entry. |
| `_bookViewWireSwipe` | 19191 | called from `enterBookView` | Swipe handler wire. |
| `_bookViewBeginPageJump` | 19238 | app.js:20073 | Page-jump entry. |
| `_bookViewOpenFind` | 19283 | called from book-view find-btn | Find open. |
| `_bookViewRunFind` | 19304 | called from find-input | Find execute. |
| `_bookViewBuildPageElement` | 19563 | called from `_bookViewRenderSpread` | Page el builder. |
| `_bookViewPrintBook` | 19682 | called from print-btn | Print handler. |
| `_bookViewUpdateTocButton` | 19795 | called from `_bookViewRenderSpread` | TOC btn refresh. |

### Sync / library / clip card (lines ~20100–22900)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `clearLibrary` | 20310 | called from settings-reset btn | Library wipe. |
| `_syncFetchAndStoreClip` | 20740 | called from `_syncPull` | Sync fetcher. |
| `_syncRadioChange` | 20953 | wired to settings radio | Sync radio handler. |
| `formatClipMeta` | 21121 | called from `makeClipCard` | Meta formatter. |
| `_saveLibraryOrder` | 21182 | called from `_commitDragOrder` | Order persist. |
| `syncAllFromGithub` | 21303 | called from settings btn | GitHub sync. |
| `renarrateAllOutdated` | 21437 | called from settings btn | Bulk renarrate. |
| `_clipSwatchGradient` | 21581 | called from `makeClipCard` | Swatch gradient. |
| `_clipAccentColor` | 21594 | called from `makeClipCard` | Accent picker. |
| `_clipSwatchInitial` | 21625 | called from `makeClipCard` | Initial letter. |
| `_clearRenarrating` | 22302 | called from `_libraryRenarrate` | State clear. |
| `_bgSetSyncingActive` | 22332 | called from `makeClipCard` | Sync-state set. |
| `resetClipProgress` | 22426 | called from clip-edit btn | Progress reset. |
| `_isFirstClipTourSeen` | 22470 | called from `_updateFirstClipTour` | Tour-seen flag. |
| `_dismissFirstClipTour` | 22473 | called from tour-close btn | Tour dismiss. |
| `_playConfetti` | 22535 | called from `_updateFirstClipTour` | Confetti UI. |
| `_isDragHintDismissed` | 22633 | called from `_updateDragHint` | Hint-state flag. |
| `_dismissDragHint` | 22636 | called from `_updateDragHint` | Hint dismiss. |
| `_updateDragHint` | 22641 | called from `renderLibrary` | Hint refresh. |
| `_attachDragHandle` | 22651 | app.js:21698 (+1 HTML comment) | Drag-handle wire. |
| `_commitDragOrder` | 22727 | called from `_onDragEnd` | Drag commit. |
| `_renderTagFilterRow` | 22904 | called from `renderLibrary` | Tag-filter render. |

### Library cards / clip edit / notes (lines ~23200–25000)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_processCoverImage` | 23245 | called from cover-upload | Cover processing. |
| `_sampleDominantColor` | 23282 | called from `_processCoverImage` | Color extract. |
| `_rgbToHsl` | 23303 | called from `_sampleDominantColor` | Color convert. |
| `_renderProvenanceBlock` | 23346 | called from `openClipEdit` | Provenance UI. |
| `openNotesDialog` | 23642 | called from clip-edit notes btn | Notes dialog open. |
| `_commitNotes` | 23654 | called from notes-save btn | Notes commit. |
| `_slugifyForFilename` | 23713 | called from `_exportClipNotes` | Filename helper. |
| `_buildClipNotesMarkdown` | 23732 | called from `_exportClipNotes` | MD builder. |
| `_parseClipBackupFromMd` | 23926 | called from `_openRestoreMarksConfirm` | MD parser. |
| `_initClearMarksDialog` | 24216 | called once at boot | Dialog wire. |
| `_initRestoreMarksDialog` | 24309 | called once at boot | Dialog wire. |
| `_openRestoreMarksConfirm` | 24368 | called from restore-btn | Restore confirm. |
| `_initLinesConvertDialog` | 24508 | called once at boot | Dialog wire. |
| `_openLinesConvertConfirm` | 24546 | called from lines-convert btn | Lines confirm. |
| `_isStoreByLinesEnabled` | 24613 | called from `_runLinesConversion` | Pref check. |
| `_runLinesConversion` | 24693 | called from `_openLinesConvertConfirm` | Conversion exec. |
| `_crc32` | 24858 | called from `makeZip` | CRC32 helper. |
| `makeZip` | 24869 | called from `exportLibrary` | ZIP builder. |
| `readZip` | 24951 | called from `importLibraryFromFile` | ZIP reader. |
| `importLibraryFromFile` | 25110 | called from import-file picker | Import handler. |
| `_enterMultiSelect` | 25307 | called from long-press | Multi-select entry. |
| `_armBulkDelete` | 25343 | called from delete-btn | Bulk-delete arm. |
| `_openImportMenu` | 25692 | wired to import-btn | Import menu open. |

### Importers (lines ~25800–27900)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `_checkGitSourceFreshness` | 25960 | called from `loadClip` | Freshness check. |
| `_docPickerItemSize` | 26113 | called from `_docPickerMakeFileRow` | Size helper. |
| `_docPickerBuildTree` | 26125 | called from `_docPickerRender` | Tree builder. |
| `_docPickerCollectFiles` | 26153 | called from `_docPickerRender` | File flatten. |
| `_docPickerAutoExpanded` | 26166 | called from `_docPickerRender` | Expand-state init. |
| `_docPickerMakeFileRow` | 26247 | called from `_docPickerRenderTree` | Row builder. |
| `_docPickerRenderTree` | 26317 | called from `_docPickerRender` | Tree render. |
| `_docPickerMakeFolderRow` | 26356 | called from `renderNode` | Row builder. |
| `_suggestFolderChips` | 27048 | called from `openGithubBrowser` | Suggestion helper. |
| `_withGithubBranch` | 27104 | called from `openGithubBrowser` | URL composer. |
| `openScrivenerBrowser` | 27317 | called from `fetchFromUrl` | Scrivener picker. |
| `openObsidianBrowser` | 27370 | called from `fetchFromUrl` | Obsidian picker. |
| `_normalizeGithubUrl` | 27475 | called from `fetchFromUrl` | URL normalizer. |
| `_githubBranchFromUrl` | 27510 | called from `_isGithubRepoRoot` | Branch parser. |
| `_isAcceptedFile` | 27883 | called from drop handler | MIME check. |

### Media session / voice catalog (lines ~28000–28900)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `setupMediaSession` | 28017 | called once at boot | Media-session init. |
| `_voiceProvenance` | 28242 | app.js:11233 | Provenance lookup. |
| `updateInstalledToggle` | 28259 | called from voice-catalog UI | Toggle refresh. |
| `updateCommercialToggle` | 28280 | called from voice-catalog UI | Toggle refresh. |
| `_populateLanguageFilter` | 28298 | called from voice-catalog UI | Filter populate. |
| `updateFavoritesToggle` | 28351 | called from voice-catalog UI | Toggle refresh. |
| `loadVoiceCatalog` | 28360 | called once at boot | Catalog load. |
| `makeCatalogRow` | 28523 | called from `renderVoiceCatalog` | Row builder. |
| `removeCatalogVoice` | 28637 | app.js:28630 | Remove handler. |
| `_markAuditioned` | 28726 | called from preview play | Audition mark. |
| `_revertAuditions` | 28759 | called on dialog close | Audition revert. |
| `_isTouch` | 29092 | called from `_showTooltip` flow | Touch probe. |
| `_showTooltip` | 29107 | called from tooltip hover | Tooltip show. |
| `_formatAbsRecency` | 29236 | called from `_allBookmarksRender` | Date formatter. |
| `_allBookmarksGather` | 29245 | called from `openAllBookmarks` | Bookmark gather. |

### Phone UI (lines ~29380–30850)

| Name | Def line | Caller (file:line) | Notes |
|---|---|---|---|
| `openAllBookmarks` | 29386 | app.js:29395 | All-bookmarks dialog. |
| `_phoneTagRowArm` | 29478 | called from phone-tag-row | Tag-row arm. |
| `_phoneTagRowFireTag` | 29575 | called from `_phoneTagRowApplyArmedToSentence` | Tag fire. |
| `_phoneTagRowMaybeShowHint` | 29778 | called from phone-tag-row boot | Hint show. |
| `_phoneTagRowHintDismissed` | 29762 | called from `_phoneTagRowMaybeShowHint` | Hint flag. |
| `_phoneMenuOpen` | 29828 | called from `_phoneMenuToggle` | Menu open. |
| `_phoneMenuToggle` | 29849 | wired to phone-menu btn | Menu toggle. |
| `_isLandscapeImmersiveBlocked` | 30420 | called from `_resetLandscapeImmersiveTimer` | Block check. |
| `_showLandscapeChrome` | 30459 | called from tap-to-reveal | Chrome show. |
| `_phonePullupOpen` | 30620 | called from `_phonePullupToggle` | Pullup open. |
| `_phonePullupToggle` | 30632 | wired to pullup-btn | Pullup toggle. |

---

## Generic names (manual review)

These function names are too common to count cleanly because the same
identifier is reused as nested helpers inside multiple parent functions
and the count is dominated by inline lookalike strings. Skip the bare
count and review by context:

- `render` — multiple inner closures plus HTML attribute references
- `open` — inner closures plus DOM `.open` calls
- `close` — inner closures plus DOM `.close` calls
- `dismiss` — inner closures plus the `data-action="dismiss"` UI dispatch
- `execute` — inner closure in command palette only
- `walk` — duplicate inner helpers in `_docPickerCollectFiles` and `_docPickerAutoExpanded` (lines 26155, 26168); separate scopes, both live
- `frame` — inner `requestAnimationFrame` helper in `_playConfetti`
- `findNamed` — inner closure inside `attributeSentencesForDisplay`
- `cap` — capitalize utility, called everywhere
- `endDrag` — inner closure inside drag binding
- `download` — global function plus `<a download="...">` HTML attribute hits
- `generate` — global synth entry plus `generate*Page` lookups in HTML

For these, the safest call is *don't count, don't delete*. If you want to
prune them, do it by reading the enclosing scope.

---

## Methodology notes

- Patterns used to extract definitions (in priority order):
  1. `function name(...)` — top-level and nested declarations (632 hits)
  2. `function _name(...)` — same pattern; underscore prefix is convention
  3. `const|let|var name = function...` — **zero hits** in this codebase
  4. `const|let|var name = (...) =>` — 54 hits, but every one I sampled
     was an inner closure (e.g. `const onEnded = () => {…}`), not a
     top-level declaration. Skipped per user instructions.
- Object-literal methods (`name(...) {` inside `{…}`) skipped as instructed.
- **Total `function` definitions found in app.js: 632.**
- After deduplicating names that repeat as inner closures (`walk`, `close`,
  `open`, `render`, `dismiss`, `frame`, `findNamed`, `cleanup`), the
  effective unique-name count is roughly **600**.
- Bucketing (approximate, since some generic names skipped):
  - **1 occurrence** (definition only): **2** functions
  - **2 occurrences** (def + 1 caller): **~145** functions
  - **3+ occurrences**: **~450** functions
- Patterns observed:
  - The `_` prefix is consistent for "internal helper" — every block of
    feature code (`_bookView*`, `_sync*`, `_phone*`, `_voice*`, `_bg*`,
    `_doc*`) uses it.
  - Whole feature families are tightly coupled inside their own region:
    `_bookViewV2*` (lines 18144–18491), `_bookViewV3*` (lines 18563–19012),
    `_phoneTagRow*` (lines 29460–29825), `_phoneMenu*` (29825–30420),
    `_phonePullup*` (30533–30846). These all show up in the review pile
    because most are wired through a single boot function and a single
    button.
  - Many "2-occurrence" entries are **boot-time wires**: definition + one
    `addEventListener("click", fn)` or one `if (document.readyState…)`.
    Those are *not* dead; they are the natural shape of UI handlers.
  - V2 vs V3 book-view families both look live. The user may want to ask
    whether one of them is meant to be the current implementation and the
    other is leftover scaffolding — but that's a *design* question, not a
    dead-code finding.

---

## Risks (read before deleting anything)

1. **`window.foo = foo` exports.** These names are reachable from HTML
   `<script>` blocks, browser dev-tools, or Tauri side-channels. The
   following are exported globally and may have callers outside the
   files I scanned:
   - `_paintImportPreview` (line 550)
   - `_coverImgSrc` (line 588)
   - `_setCurrentClipKind` (line 634)
   - `_openAsEbook` (line 845)
   - `_updateOpenAsEbookEnabled` (line 856)
   - `_paneIsHidden`, `_setPaneHidden`, `_paintPaneHiddenAttrs`
     (lines 2961–2977)
   - `_syncGenerateBar` → exposed as `window._syncPhoneGenerateBar`
     (line 30275)
   - `__narrativeOpenManual` (line 3120) — anonymous wrapper
   None of the **two strong candidates** are in this list, so they're safe
   on this axis.
2. **`data-action` / `data-cmd` dispatch.** Phone-menu dispatches via
   `item.dataset.action` (line 30337) and highlight-toolbar uses
   `btn.dataset.action` (line 17497). Both map action strings to *element
   IDs*, not function names — so dynamic dispatch does **not** falsify
   the bare-identifier counts.
3. **Command palette `buildCommands()`.** The palette pushes
   `{run: () => …}` closures (line 4284 onward). All command runners are
   inline arrow functions; none are named-function references that this
   audit would miss. Safe.
4. **Service worker.** `sw.js` does not import or reference any app.js
   function by name. Safe.
5. **Inline `onclick=` attrs.** Grep for `onclick=` in `index.html`
   returned 0 hits. No inline HTML callback risk.
6. **Boot-time one-shots.** Many "2-occurrence" entries are functions
   that *should* have one call site (boot-time init, single button
   handler). Inlining them is fine but they aren't dead.
7. **Inner closures named the same as a top-level function.** Watch
   for `function close()` inside dialog setup blocks colliding with
   top-level `close` patterns. The persisted dumps show these as
   separate scope-bound entities; treat each definition as its own item.
8. **The two strong candidates were verified by hand:**
   - `_refreshMaintenanceFormVisibility` (1 grep hit, line 1695 only)
   - `_pruneOldDays` (1 grep hit, line 6486 only)
   Both look safe to delete on read-through. `_pruneOldDays` may have
   been intended as a TTL/housekeeping cron for the stats panel; if you
   delete it, check that you don't want it called from `_loadStats`
   instead.

---

## Files searched

- `E:\audiable\static\app.js` — 31,098 lines
- `E:\audiable\static\index.html` — confirmed no inline handlers, only
  `data-action` ID lookups
- `E:\audiable\static\sentence-ids.js` — no `function` definitions, no
  cross-file refs to app.js helpers
- `E:\audiable\static\tutorials.js` — 8 function defs, no references to
  the strong candidates
- `E:\audiable\static\overlay-tour.js` — 10 function defs, only refs to
  `_openAsDrawerOrModal` (already accounted for in the 5-occurrence live
  set) and `_dlog`
- `E:\audiable\static\sw.js` — no references to app.js function names
