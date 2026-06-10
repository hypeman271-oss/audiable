# Narrative — 60-second demo video script

Target: landing page hero slot + ad pre-roll. One shot, one cut per
scene, no narration overlay (the in-app audio IS the narration). All
on-screen text appears as overlay captions.

**Frame**: 1920×1080, 30 fps. Capture in a clean Chrome window with
the dock/taskbar hidden. Browser zoom 100%. Theme: Cream (default).

**Audio**: app-audio only for scenes 3–6 (Kokoro narrating the user's
draft). Optional light room tone underneath. No music. The selling
point IS hearing the synthesis — don't bury it.

**Voiceover (optional)**: none. The 5 caption lines do the work. If
testing shows zero conversions without VO, add a single mid-pitch
female VO line at scene 6: "Hear your next chapter before you
publish it." That's it.

---

## Shot list

### Scene 1 — Hook (0:00–0:06)

**Visual**: tight crop on a Scrivener window. Cursor in a paragraph
that ends "—she said." Author squints at it, hits Cmd+Tab.

**Caption (top center, fade in/out)**: *Stuck on a line. Again.*

**Why**: targets the writer who's been re-reading the same paragraph
for 20 minutes. Not the audiobook-buyer.

### Scene 2 — The pivot (0:06–0:14)

**Visual**: Cmd+Tab lands in Scrivener again, then in Narrative.
Cursor drags the chapter file into the import drop zone. Toast
"Chapter 4 imported" flashes. The reading view loads with the chapter
text and the cover swatch appears.

**Caption**: *Open it in Narrative.*

**Why**: shows that import is one drag, no copy-paste.

### Scene 3 — Listening (0:14–0:30)

**Visual**: hit ▶. Reading view auto-scrolls. The current sentence is
highlighted in cream. Kokoro narrates — **the actual app audio is the
soundtrack here.** Author leans back, reaches for coffee, listens.

**Caption** (low third, kept on screen the whole scene): *Hear the
prose, not just read it.*

**Why**: the highest-conversion 16 seconds of the video. If they
don't believe the voice, the rest doesn't matter. Pick a passage
with at least one dialogue line and one descriptive paragraph so the
narration shows range.

### Scene 4 — The bookmark (0:30–0:38)

**Visual**: a sentence plays and sounds clunky. Author taps 🔖 on
the player. Bookmark editor pops up; they type "this line is dead"
and hit Enter. Playback continues uninterrupted.

**Caption**: *Bookmark what breaks. Keep listening.*

**Why**: this is the "loop" the product is about. Most TTS readers
stop here. We don't.

### Scene 5 — Push back (0:38–0:48)

**Visual**: hit ✎ Edit. The bad line is highlighted. Author retypes
it. Hit ⇡ Push to GitHub. The confirm dialog shows the file path.
They hit OK. Toast: "Pushed to GitHub — commit a3f9d2c."

**Caption**: *Fix it. Push it back to your manuscript.*

**Why**: this is the differentiator vs Audible / Speechify / Voice
Dream. The revision loop closes inside the app. (For Scrivener
authors, swap the GitHub button for 📘 Push to Scrivener — both flows
end the same way.)

### Scene 6 — Mac → phone handoff (0:48–0:60)

**Visual**: split-screen. Left half: the desktop reading view, still
on Chapter 4. Right half: a phone wakes up, Narrative opens to the
same chapter at the same position. The phone shows the bookmark
indicator on the timeline. The hero text fades up across both
panels: **Write. Listen. Revise.**

**Caption** (final card): *Write. Listen. Revise.
[narrative-alpha.fly.dev]*

**Why**: closes on the tagline + URL. The split-screen sells "your
work syncs" without a single technical word.

---

## Captions list (for SRT export)

```
00:00:00,500 --> 00:00:05,500
Stuck on a line. Again.

00:00:06,500 --> 00:00:13,500
Open it in Narrative.

00:00:14,500 --> 00:00:29,500
Hear the prose, not just read it.

00:00:30,500 --> 00:00:37,500
Bookmark what breaks. Keep listening.

00:00:38,500 --> 00:00:47,500
Fix it. Push it back to your manuscript.

00:00:48,500 --> 00:00:59,500
Write. Listen. Revise. — narrative-alpha.fly.dev
```

---

## Capture checklist

Before pressing record:

- [ ] Theme: Cream
- [ ] Mode: Author (so the bookmark/edit/push buttons are visible)
- [ ] Sync: ON (so the desktop→phone handoff actually works in scene
      6)
- [ ] Library has at least one Scrivener-imported clip with a SHA
      pinned (so the Push to GitHub button is gated correctly in
      scene 5). If GitHub isn't wired locally, swap in 📘 Push to
      Scrivener — the flow is identical from the camera's POV.
- [ ] Pick a paragraph with one dialogue line + one descriptive line
      for scene 3 so the narration has range to show.
- [ ] Browser window: 1280×800 fits a 1920×1080 frame with margin.
- [ ] Mute the OS notification chimes. Email, Slack, Discord all off.
- [ ] Test that ▶ plays cleanly before recording — RTF is currently
      0.28x on Fly's shared-cpu-1x; if cold-start synth shows in the
      take, re-warm and re-shoot. (Or bump to performance-1x for the
      shoot day per the STRATEGY.md hardware decision.)

## Edit notes

- No talking head. The viewer doesn't care who you are; they care
  what their draft is going to sound like.
- Cuts should land on beat with the synth's sentence pauses, not on
  arbitrary scrub points. If the camera is moving between buttons,
  let the audio keep playing.
- Pacing: scene 3 is the longest because the audio is the proof.
  Resist trimming it.
- The final card holds for at least 3 seconds. URL has to be
  readable.

## Asset dependencies

- `landing-assets/voice-libritts-7.mp3` — exists, used as scene 3
  audio bed in case the app-recorded audio glitches.
- `landing-assets/demo-video.mp4` — output of this script. Drops
  into the `<video>` slot on landing.html (TODO at line ~864).
- `landing-assets/demo-poster.jpg` — single frame from scene 3,
  with the caption visible. Set as `<video poster=…>`.
