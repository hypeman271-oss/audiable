# Connecting with indie authors — outreach plan

Posture: **fellow author who built a tool.** Lead with personal need
("I kept missing typos because my eye glazes over; my ear catches
them — so I built this"), then the product. Don't pitch features
first. Don't say "startup" or "MVP" — say "I built this for myself,
sharing it now."

This is a phased plan. Each phase blocks the next.

---

## Phase 0: Sharpen the elevator pitch (1 sitting)

One sentence. Three versions, pick one and stick with it.

| Audience      | Pitch                                                                                                  |
|---------------|--------------------------------------------------------------------------------------------------------|
| Author        | "TTS that reads my manuscript out loud so I catch the typos my eye keeps skipping."                    |
| Hobbyist      | "I built a web app that turns my .docx into a clean audiobook for revision passes."                    |
| Pro indie     | "Self-hosted TTS for revision. My voice. My pace. My audiobook draft, before I pay a narrator."        |

Default for now: **first one** (revision-as-listening). It's the
clearest "why do I care" hook for an author with an unfinished
manuscript.

---

## Phase 1: Foundation — landing page worth linking to (this week)

Before posting anywhere, every link in every post should land on
something better than the alpha URL with no context. The current
[`static/landing.html`](static/landing.html) was scaffolded in #409
but has placeholders. Fill them.

**Required to ship a link**:

- [ ] Hero copy — 1 sentence pitch + 1 paragraph story ("I'm an
      indie author. Halfway through revising my second book...")
- [ ] 3 pillars — Revise by listening · Your draft, your voice ·
      No subscription lock-in *(or whatever pricing decides)*
- [ ] 1 audio sample — 30 seconds of a public-domain passage
      (Tom Sawyer paragraph) narrated with the default voice
- [ ] 1 product screenshot — phone or desktop showing a clip mid-
      revision with the tag row, an annotation chip, the title row
- [ ] A way to ask for a key — "I'm hand-inviting alpha testers.
      DM me on [Twitter/Reddit/email]" — set expectations that
      this is real, slow, and hand-curated
- [ ] FAQ — 5 questions (Who narrates? Where does my text go?
      Does it sync? What does it cost later? Why not Audible-style
      paid voices?)

**Nice-to-have, post-launch**:

- 60-second screen-recorded demo (#408)
- Per-format walkthroughs (EPUB, .docx, Scrivener bundle)
- Per-genre voice samples

**Done means**: someone tapping a link from a Reddit thread arrives,
reads for 30 seconds, hits the audio sample, and either DMs for a
key or closes the tab knowing exactly what this is.

---

## Phase 2: Venues map (where to show up)

Five communities, prioritized for "fellow author who built a tool."
Each has its own posting culture — read 10 threads before posting.

### A. r/selfpublish (Reddit) — primary

- **Why**: 200k+ subscribers, exactly your audience, active daily.
- **Rules to know**:
  - Self-promo is heavily moderated. You need history (comments
    on other threads, no link-drops) before you can post a tool.
  - "Showcase Saturday" / "Weekly tool" threads are sometimes
    OK for new tools — check current mod policy first.
  - DON'T post a screenshot of your dashboard. DO post a
    text-first thread describing the problem.
- **First post shape**: a question, not a promo. "Anyone else
  catch typos better by listening than reading? I built a tool
  for this — happy to share if anyone wants to try it." Let
  curiosity do the link-pulling.

### B. KBoards Writers' Cafe — high trust, slower

- **Why**: indie author community older than Reddit. Long-term
  relationships. People are pickier but more likely to actually
  use what you share.
- **Rules**: established self-promo etiquette. You need at least
  10-20 substantive comments before pitching anything.
- **First post shape**: introduce yourself in the new-author
  intro thread first. Then engage on craft / revision / audio
  threads for a week. Then post in the "Tools & Tech" subforum.

### C. The Writers' Co-op / Indie Author Discord servers

- **Why**: small (50–500 people), high engagement, more forgiving.
  Voice-channel conversations possible.
- **Approach**: join, lurk for a few days, share when natural in
  #revision-tips / #tools channels. Less risk of self-promo
  backlash because servers are smaller and more conversational.
- **Find them**: search "indie author discord" + 2026 on
  Twitter/X, or ask in r/writing.

### D. Twitter/X #amwriting / #amrevising — broadcast

- **Why**: fast feedback loop, low effort per post, possible
  retweets from author influencers.
- **Approach**: a 4-tweet thread is your best format. Tweet 1 =
  hook (the typo-catching insight). Tweet 2 = product shot.
  Tweet 3 = audio sample (post as video with captions). Tweet 4
  = "DM for a key."
- **Don't**: do not buy follows. Do not run ads. Do not @-spam
  big authors.

### E. NaNoWriMo + writing-craft Substacks/newsletters — long-tail

- **Why**: writers in revision-mode, slower funnel but higher
  intent. Once a newsletter mentions you, the link works for years.
- **Approach**: identify 5-10 newsletters that talk about indie
  publishing tooling (Jane Friedman, The Hot Sheet, etc.). Reply
  to one of their posts with a thoughtful comment about
  revision-by-listening. If they're interested, they'll ask.

---

## Phase 3: Message templates

Story-first. Adapt per venue but the core stays the same.

### The intro paragraph (use everywhere)

> "I'm an indie author. Halfway through revising book two, I
> noticed my eye was skipping over typos but my ear was catching
> them — same sentence, different brain mode. I built a small web
> app that reads my drafts back to me in a clean narrator voice so
> I can revise by listening. It handles .docx, EPUB, Scrivener
> bundles, GitHub repos for chapter-by-chapter workflows. Free
> while it's in alpha. DM me if you want a key — I'm hand-inviting
> testers right now."

### Reddit thread (r/selfpublish)

**Title**: "Anyone else catch typos better by listening than reading?"

**Body**:
> "Genuine question, then a tool I built for it.
>
> I'm halfway through revising book 2. Last week I noticed I kept
> missing the same typo three reads in a row — my eye was
> auto-correcting it. I read it out loud once and caught it
> immediately. Different brain mode.
>
> I couldn't find a TTS app that handled my .docx + Scrivener
> bundle workflow without turning every chapter into a 'subscribe
> to Pro' wall. So I built one over Christmas. It's free while
> I'm in alpha and I'm hand-inviting testers from communities I
> trust.
>
> If you want to try it, DM me. Not pitching subscriptions or
> anything — I just want feedback from real revising authors.
> What voice do you prefer for fiction? How long do you listen
> in one sitting?"

**Why this works**: leads with a question + insight (revision tip
the community will agree with), tool is the SECOND beat, DM-only
ask = no link-drop = mods are happy.

### Twitter/X thread (4 tweets)

1. Insight: "I can read the same paragraph 3x and miss the typo.
   I listen to it once and catch it. Eye-mode and ear-mode are
   different brain modes."
2. Product: "So I built a tool. Drop a .docx, EPUB, or Scrivener
   bundle in. Get a clean narrator voice. Catch the typos."
   *(attach screenshot)*
3. Demo: "Here's 30 seconds." *(attach audio sample as video)*
4. Ask: "Free while in alpha. DM for a key. I'm only inviting
   indie authors right now."

### Discord intro

Shorter than Reddit, more conversational:

> "Hey — I'm [name], indie author. Spent the holidays building a
> TTS web app for revising my own drafts (typing this with my
> ears ringing from rebuilding the third version). If anyone
> wants to play with it, hit me up. Especially curious how folks
> revise long chapters without falling asleep."

---

## Phase 4: Outreach sequence (week 1 → week 4)

**Week 1**: Foundation only. Ship landing page. Pick a default
voice + record 30s sample. Take screenshot. No outreach yet.

**Week 2**: 1 venue. Pick r/selfpublish OR a Discord. Post the
intro. Reply to every comment for the next 48 hours. Hand-invite
the first 5 testers. Track them in tenants.json with a "source"
label so you know which channel produced them.

**Week 3**: 2 more venues. Don't repeat the same post — adapt to
each community's culture. Watch which channels convert best
(invite → first synth → second-day return).

**Week 4**: First feedback synthesis. Email/DM the 10–15 testers
who actually used it. Three questions: what worked, what didn't,
would you pay $X. Use the answers to decide pricing (#608) and
V1 launch shape.

---

## Metrics to watch

Lightweight — don't over-instrument.

- **Invite → first synth**: how many keys turn into a real use?
- **Day-2 return**: did they come back?
- **Word-of-mouth**: did any tester DM a friend for a key without
  prompting?

A single tester who returns three days in a row + invites a friend
is worth 50 sign-ups who never came back.

---

## What NOT to do (anti-patterns)

- ❌ Cold-DM authors with "check out my app." Universally hated.
- ❌ Post in r/writing without reading the self-promo rules.
- ❌ Use words like "AI-powered" or "revolutionary" anywhere.
  Authors are tired of both.
- ❌ Build a Discord server before you have 30 active users.
- ❌ Run paid ads before $1k in revenue exists.
- ❌ Promise V1 dates publicly until V1 is actually a week away.
