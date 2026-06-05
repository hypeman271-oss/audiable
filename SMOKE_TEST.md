# Cross-device sync smoke test (#431, Path B sync-7)

Manual two-device pass to verify every sync surface lands correctly. Run
after a major sync change, before declaring sync work "done", or before
inviting a new tester.

## Setup

- **Device A**: desktop (Chrome / Edge / Firefox).
- **Device B**: phone (Android Chrome works; iOS Safari should too).
- Both signed in with the **same** narrative key.
- Both on v225v3.57 or later.
- Sync **ON** on both (Settings → Sync library).
- Start with **A populated** (at least: 1 audio clip, 1 ebook clip,
  1 saved bookmark, 1 voice preset). B's library should match A within
  ~60s of opening B (boot-time pull).

If B's library doesn't match A on first open, stop and diagnose — the
rest of the test assumes baseline sync is working.

---

## Scenarios

Mark each as **PASS** / **FAIL** / **SKIP**. For FAIL, note what
happened. Push a debug log from whichever device misbehaved.

### 1. Create audio clip on A → appears on B
- A: paste short text, Generate, save.
- B: ☰ Library within 60s. New clip is listed with title + duration.
- B: tap the clip. Audio plays.

### 2. Create ebook clip on A → opens in book view on B
- A: import any EPUB / DOCX / paste text, tap "📖 Open as ebook".
- B: ☰ Library. New ebook clip shows the 📖 badge.
- B: tap it. Auto-flips into book view (v3.56 path). Pages render.
- B: close book view (× or back). Lands at empty state, not the
  "can't read" stacked-images dump (v3.57 path).

### 3. Add a bookmark on A → visible on B
- A: open an existing audio clip, tap 🔖 mid-playback, save.
- B: open the same clip within 60s. The bookmark appears in the
  bookmarks drawer at the same timestamp + label.

### 4. Add an annotation on A → marker + chip on B
- A: in reading view, tap a sentence → annotate palette → pick a
  flag symbol → save.
- B: open the same clip. The annotated sentence shows the marker chip
  inline (the v3.tn21 chip render path).

### 5. Re-narrate on A → B's audio refreshes
- A: change voice on an existing clip, tap 🔄 Re-narrate.
- B: open the clip. The stale-audio banner appears (v225+phone-author
  UX-4 / #536). Tap "Sync". Audio is the new voice.

### 6. Delete clip on A → disappears on B
- A (desktop): tap the **×** button on the library card.
- A (phone): long-press the card → Delete.
- B: ☰ Library within 60s. The clip is gone (v222.bug / #458 — soft
  delete sync).

### 7. Save preset on A → visible on B
- A: voice card → save current as preset (e.g. "Snappy LibriTTS").
- B: voice picker → preset row should include "Snappy LibriTTS"
  within 60s (v225fz8 / #674 — preset sync).

### 8. Reorder library on A → B reflects order
- A: switch sort to Custom order, drag a clip up to the top.
- B: ☰ Library. The top clip matches A's drag target.

### 9. Conflict — same clip, both devices, near-simultaneous edits
- A: edit clip's notes, save.
- B (within ~10s): edit the same clip's title, save.
- Wait 60s. Both devices should converge on whichever edit had the
  later `updatedAt`. The losing edit's status line says "Library was
  updated on another device; using the latest."

### 10. Clear library on A → wipes B
- A: Settings → "Clear all clips" (or Switch key).
- B: ☰ Library within 60s. Empty (v222.bug / #459 — clearLibrary
  sync).

### 11. Migration UX (only fires on a never-migrated device)
- Need a third device or a key the user hasn't used before. Skip
  if no fresh device available.
- C: sign in with same key (sync OFF default).
- C: Settings → flip Sync ON. **Confirm dialog appears** showing
  clip count + estimated MB (v225v3.52 / #785).
- C: Cancel → radio reverts to OFF, no upload.
- C: flip ON again → Confirm → status shows "Pushing 1/N…" then
  "Synced N/N just now." Future OFF→ON flips are silent.

### 12. Audio dedup across devices (content-addressed sha)
- A: synth a clip with text "Hello world." (any voice).
- B: synth same text with same voice (independently).
- Server should serve both clips from the same audio sha — no
  double-store (v221.sync-4). Verify by checking
  `GET /api/library/clips/{id}` on both — same `audioSha256`.

---

## After the run

If everything passes, mark #431 complete and update SYNC.md with the
last-verified date.

If anything fails, capture:
- Device + browser version.
- Which scenario.
- Push a debug log from the device that misbehaved.
- File a follow-up task.
