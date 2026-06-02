# Tester invite templates

Copy-paste messages for handing a fresh tester key to an alpha user. Three
templates here, from shortest to longest. Pick whichever fits the channel
you're using to reach the tester (Signal / SMS / email / paper note).

Replace placeholders before sending:

- `<KEY>` — the bearer just shown in the green box in
  Settings → Tester keys (looks like `narrative-xxxx-xxxx-xxxx-xxxx`).
- `<URL>` — your deployment URL (e.g. `https://narrative-alpha.fly.dev`).
- `[Name]` — the tester's first name.
- `— [Your name]` — your sign-off.

The raw key is shown ONCE in the Settings form. Copy it immediately, paste
it into the placeholder below, and send. After Settings closes you can't
re-display the key in the UI (the listing endpoint redacts it).

---

## 1. Short — Signal / SMS (under 300 chars)

```
Welcome to the Narrative alpha! Your key:
  <KEY>

1. Open <URL> on your phone or laptop
2. A prompt asks for an API key — paste the above
3. That's it. Full guide: the ? icon top right.

Don't share the key — it's yours alone.

— [Your name]
```

---

## 2. Medium — email handoff with onboarding steps

```
Subject: Your Narrative alpha key

Hey [Name],

Thanks for testing Narrative. Your key:

  <KEY>

To get started:

1. Open <URL> (on phone or desktop, your choice — same key works
   on both, see below).
2. A small browser prompt appears asking for your "X-Narrative-Key."
   Paste the key above and click OK. The app loads; no reload needed.
3. To use on a second device of yours, paste the SAME key there too,
   then Settings → "Sync library across devices" → On (on both
   devices). Your library is then shared between them.

A couple of things to know:

- The key is unique to you. Don't share it — anyone with it sees and
  can edit your library.
- If you lose it (cleared browser data, etc.), tell me and I'll mint
  you a new one.

Full manual: tap the ? icon in the top-right of the app, or scroll to
§9 ("Listening on your phone") for the onboarding walkthrough. §10
walkthrough 6 covers the two-device sync flow.

Feedback button is in Settings (⚙) → Send feedback. Please use it.

— [Your name]
```

---

## 3. Long — invite + the "why I'm building this" pitch

Use this when the tester doesn't already know what Narrative is or why
they should care. Strongest version of the message; lets them know what
lens to test through.

```
Subject: You're invited to the Narrative alpha

Hey [Name],

Thanks for being one of my alpha testers. Here's what you need:

  Key:  <KEY>
  URL:  <URL>

Open the URL on any device, paste the key when prompted, click OK.
That's it. The first-time API key flow is described in detail in
the in-app manual (? icon, §9), but it really is "paste, click."

---

WHY I'M BUILDING THIS

Writers have a feedback loop problem. When you write something, you
read it silently in your head and it sounds fine. But when you read
it OUT LOUD — your voice trips on awkward sentences, repeated words,
places where the rhythm breaks. That's the feedback your draft
actually needs.

The trouble is you can't read your own book out loud while you're
doing the dishes, walking the dog, or driving to your day job. And
paying someone to narrate every revision pass isn't an option.

Narrative is for that gap. You paste (or import) a chapter at your
desk, it narrates with a real-sounding voice, and you listen on your
phone — gym, car, walk, whatever. When you hear the bad sentence,
you go home, fix it, re-narrate, listen again. Repeat until the
prose flows the way you wanted.

THREE THINGS I'M BETTING ON

1. Write at your desk, listen on your phone, revise at your desk.
   Cross-device sync is core, not an add-on. Your library follows
   you. Bookmark a rough spot from the gym; fix it in the morning.

2. Built for indie authors. Import directly from GitHub / Scrivener
   / Obsidian / Word. Re-narrate a chapter in place without losing
   your bookmarks, notes, or cover art. Cast characters with
   different voices.

3. Honest about quality. The voices are good (Kokoro, ~82M params,
   commercial-safe) but not big-studio. The point isn't "publishable
   audiobook narration" — it's "good enough that your ear catches
   the bad sentences." Probably better than you expect.

---

WHY YOU'RE HERE

You're an alpha tester. Things will break. The things I most want
your eyes on:

- Does the sync flow feel reliable when you swap between phone and
  desktop?
- Is import obvious from your writing tool of choice?
- Do the voices sound clean enough that you'd actually use this on
  a real revision pass?
- What's annoying enough that you'd give up?

HOW TO TELL ME

Settings (⚙) → Send Feedback. It goes straight to me. Be blunt —
polite feedback at this stage is wasted feedback. Say "I tried to
import X and Y happened" not "looks great, thanks!"

The key is unique to you, so don't share it with anyone. If you ever
lose it, tell me and I'll mint a new one. Your old library will stay
on the server but become unreachable — practically a fresh start.

— [Your name]
```

---

## Operational notes

**Minting workflow.** Settings (⚙) → scroll to "Tester keys" → type a
label that helps you identify the tester later
(e.g. `alice — alice@gmail.com`) → click Mint key → COPY THE KEY
IMMEDIATELY from the green box → paste into your invite message → send.

**Once-per-mint reminder.** The raw key is only visible in the UI for
the duration of that Settings dialog session. After you close it, the
listing endpoint redacts it. If you lose the key before sending,
revoke + re-mint. Recovery via `fly ssh console -C 'cat /data/tenants.json'`
is possible but annoying.

**Revoking.** Settings → Tester keys → "Revoke" next to the row. The
bearer stops authenticating immediately. The tester's library rows
stay in the DB but become unreachable from any bearer.

**Troubleshooting.** Admin-only debug page at
`/admin-troubleshooting.html` (also linked from the manual §9). Covers
the three failure modes when the Tester keys section isn't visible,
plus operational basics.
