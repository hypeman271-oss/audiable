# Narrative — Commercialization strategy

Living document. Captures the thinking from the "I want to sell this"
conversation. Updated as decisions get made and milestones land.

Last meaningful update: 2026-05-29 — four V1 launch decisions made.

---

## Decisions made (2026-05-29)

After shipping the inline-images feature for URL fetches, four V1 strategy
questions were decided. These cascade through every other engineering call
from here.

| Decision | Choice | Reasoning |
| --- | --- | --- |
| **Pricing** | One-time **$129 perpetual** | Scrivener precedent (same audience, 20+ years). Writers buy tools once, write a book over years. Avoids SaaS-at-100-users math, no billing lifecycle, no churn marketing. |
| **Synthesis** | **On-device** (Capacitor + native Piper on mobile; embedded Piper on desktop) | Near-zero recurring infra cost. Privacy story is a Writer-segment differentiator ("your draft never leaves your machine"). Piper already runs locally in the current build. |
| **Native shell** | **Tauri desktop** wrapper | Writers work at desktops. PWA install already covers mobile listening. Tauri is a weekend; Capacitor + native Piper Kotlin plugin is 3–4 weeks of unfamiliar work. |
| **Tier model** | **Paid-only with 7-day free trial** | Trial converts focused-intent users; avoids the "never-going-to-pay" support cohort. Reinforces "serious revision tool" positioning over Speechify's "free with ads" feel. |

**Implied consequences:**

- No Stripe subscription product needed for V1 — just one-time Checkout.
- No hosted synthesis backend — the Fly.toml + Dockerfile already in the
  repo become V3 (Self-Hosted) artifacts, not V1 infrastructure.
- Tauri-first means desktop code signing is on the critical path
  (macOS Developer ID + Windows code sign cert) — those orders take
  multi-week lead times, start early.
- Trial gating needs a client-side timer with a server check on launch.
  Build entitlement gating on first login; trial expiry calls Stripe
  Checkout in-app.
- Mobile stays PWA-only for V1. Capacitor + native Piper moves to V2
  scope when phone-as-primary-listening becomes a target market.

**Not decided yet:**

- Cloud sync layer (Supabase). Strictly an enhancement — V1 ships
  desktop-local-only and adds optional sync as a v1.1 feature once the
  account system is needed for license validation anyway.
- LLC vs Delaware C-corp — accountant call, not a code decision.
- Direct sale vs app store — Tauri-first sidesteps this. Sell direct
  through your own site with Stripe Checkout; skip the 30% cut.

---

## The thesis

**Lead with the writer angle.** The audiobook player / TTS reader market
is saturated (Speechify, NaturalReader, Voice Dream, Audible) and most of
the products are mediocre. But none of them solve "I'm revising my own
draft." That gap is real, you found it by living it, and the existing
features in Narrative already cover the core of it: character voices,
bookmark-notes, save-text-with-auto-regen, the Continue Listening shelf,
word-count + read-aloud-time in Author mode.

Three things differentiate Narrative from anything currently on the market:

1. **Writer-specific features** (character voices, dialogue analysis,
   bookmark-driven revision loop). No competitor does this well or at all.
2. **Privacy / local option.** Every cloud TTS service sends your draft
   to their servers. For writers and regulated industries, that's a real
   problem.
3. **High-quality voices at no recurring cost** (when self-hosted).
   Piper sounds genuinely comparable to ElevenLabs at zero marginal cost.

The strategy: lead with Writers, fund Readers later with Writer revenue,
keep Self-Hosted as a trust play and as protection against your own
business pivots.

---

## Three product versions

Don't ship all three at once. Build one well, learn, expand.

### V1 — Narrative for Writers (ship first)

**Who:** Indie authors, NaNoWriMo crowd, self-publishers, ghostwriters,
screenwriters. Prosumer writers willing to pay $10/month or $80/year for
a real revision tool.

**What's in it:** Everything currently shipped, with Author mode on by
default. Character voices front-and-center. Plus the writer-magnet
BACKLOG items: filler-word callouts, long-sentence highlighter, chapter
auto-split, LLM dialogue detection (Tier 4), Tier 1+2 character
detection improvements.

**Future features specific to this version:**

- [ ] Project-level chapter management (group clips into "books").
- [ ] Bookmark → manuscript line mapping so revision notes round-trip
  to Word / Scrivener.
- [ ] Single-file MP3 export for sending finished audio to beta readers.
- [ ] Rhythm / pacing graph over a chapter (visualize sentence length
  variance).
- [ ] Scrivener / Word / Google Docs integration for paste-and-sync.

**Pricing options:**

- $9/month or $79/year subscription.
- **OR $129 one-time perpetual license** (Scrivener model, $59 one-time,
  has worked for decades in this exact market — strongly worth considering).

**Distribution:**

- Web PWA (current architecture).
- macOS + Windows via Tauri wrapper (lightweight; runs the existing web
  app as a native binary).
- iOS + Android via TWA or Capacitor + native Piper plugin.

### V2 — Narrative for Readers (ship later)

**Who:** Article-stackers, students, commuters, accessibility users. The
volume market.

**What's in it:** Reader-focused UI. Author mode features hidden. Lead
with article fetcher, PDF/EPUB/DOCX support, library, bookmarks, A-B
loop, sleep timer. Speechify's territory but with better voices and a
one-time purchase option.

**Pricing options:**

- Free tier (daily synthesis cap, fewer voices).
- $5–7/month for full access.
- $39 one-time on app stores.

**Reality check:** This is the harder market — saturated, requires
serious marketing budget, hard to differentiate beyond "better voices."
Don't lead with it. Let Writer revenue fund building this.

### V3 — Narrative Self-Hosted (ship in parallel as a trust play)

**Who:** Privacy-conscious users (legal, medical, government), prosumer
technologists, paranoid writers, people in regulated industries.

**What's in it:** Exactly the current local-server build, sold as a
Docker image + license key. Customers run it on their own machine /
NAS. No backend dependence on you.

**Pricing:** $79–149 one-time. Lifetime updates.

**Why this matters:** It's the version *you* would buy. It's a
fallback promise for V1 / V2 customers ("we won't strand you if our
cloud goes away"). Almost zero engineering overhead beyond what V1
already requires — V1 is the same code with Stripe + accounts on top.

---

## Decisions to make first

These cascade through every other decision. Pick before writing more code.

### Hosting model — DECIDED (2026-05-29)

- [ ] **All-cloud** — you pay for synthesis compute, simplest UX, recurring cost.
- [x] **On-device** (Capacitor + native Piper plugin) — phone does the work, near-zero cost, harder to ship. **← V1 choice.**
- [ ] **Hybrid** — cloud for synthesis, local for library/UI, best balance, most engineering.

V1 ships on-device; V2 (Readers) revisits when volume justifies cloud
hosting amortization.

### Subscription vs one-time — DECIDED (2026-05-29)

- [ ] **Subscription** ($9/mo) — more revenue per user over time, but
  needs billing lifecycle, churn marketing, app store revenue cuts,
  needs 1000+ paying users to feel sane.
- [x] **One-time** ($79–129) — better customer feel, simpler legally,
  easier to ship, lower lifetime revenue per user. **← V1 at $129.**
- [ ] **Hybrid** — one-time for desktop, subscription for cloud sync addon.

V1 is one-time $129; V2 / V3 pricing TBD.

### Accounts + sync (build now, before launch)

Retrofitting cloud sync into a launched app is significantly harder than
building it first. Pick the stack early.

- [ ] User auth: Supabase Auth / Clerk / Auth0 / roll-own
- [ ] Database for library metadata: Supabase Postgres / Neon / Turso
- [ ] Audio file storage: Backblaze B2 / Cloudflare R2 / S3
- [ ] Sync layer: real-time (Supabase Realtime) or pull-based

**Recommendation:** Supabase covers auth + Postgres + storage in one
service and works generously on the free tier through ~hundreds of users.
Switch to dedicated infra later if needed.

### Voice licensing audit

**This is the highest legal risk in commercializing. Do this before launch.**

- [ ] Audit each voice in the catalog you plan to ship.
- [ ] Confirm commercial use is permitted by each voice's individual license.
- [ ] LibriTTS is CC-BY 4.0 → commercial OK with attribution.
- [ ] Most single-speaker Piper voices: check per-voice — they vary.
- [ ] Drop any voice from the bundled / featured list that isn't clearly commercial-OK.
- [ ] Add a credits / attribution screen in the app.
- [ ] Decide whether non-commercial voices can be installed by users at their own risk.

---

## Pre-launch checklist

Independent of which version ships first, these are all required:

- [ ] LLC or business entity registered.
- [ ] Business bank account.
- [ ] Stripe (or Paddle) account for billing.
- [ ] Privacy policy URL (iubenda or hand-written; required even if you
  collect nothing).
- [ ] Terms of service URL.
- [ ] Refund policy.
- [ ] Support email + actually checking it.
- [ ] $25 Google Play developer account.
- [ ] $99/year Apple Developer Program account.
- [ ] Domain registered + DNS configured.
- [ ] App icon set in all required Play Store / App Store resolutions.
- [ ] Screenshots / feature graphic for app store listings.
- [ ] Tax setup (especially around state / VAT obligations if selling internationally).
- [ ] Backup + disaster recovery plan for user data.
- [ ] Voice attribution screen built and pointed at from app menu.

---

## 12-week shipping plan — Narrative for Writers beta

This is the recommended path. Adjust dates as needed.

### Weeks 1–4: backend rebuild

- [ ] Set up Supabase project (auth + Postgres + storage).
- [ ] Build user accounts: signup, login, password reset, magic links.
- [ ] Migrate IndexedDB library schema to Postgres (clips, bookmarks,
  presets, characters, library order).
- [ ] Build sync layer: client mutates locally, then writes to Supabase
  in the background.
- [ ] Audio files: blob upload to Backblaze B2 / R2 on save, lazy load
  on play.
- [ ] Migrate `/api/synthesize/stream` to a hosted instance (Railway,
  Fly.io) OR keep using on-device (Piper-via-Capacitor; see below).
- [ ] Stripe integration: subscription product + checkout + customer
  portal.
- [ ] Privacy policy + ToS pages.

### Weeks 5–8: native shells

Two paths here; pick one and commit:

**Path A: Tauri desktop wrapper (Writer-first)**

- [ ] Tauri project initialized.
- [ ] Existing web app loaded in the Tauri webview.
- [ ] Native menu bar with Open / Quit / Preferences.
- [ ] Auto-update infrastructure.
- [ ] Code signing certificates (macOS Developer ID, Windows code sign).
- [ ] DMG / MSI build pipeline.

**Path B: Capacitor + native Piper on Android (Reader-first)**

- [ ] Capacitor project initialized wrapping the existing web app.
- [ ] Kotlin Piper plugin against ONNX Runtime Android.
- [ ] JS bridge so `fetch('/api/synthesize')` calls the native plugin.
- [ ] APK build pipeline.
- [ ] Play Console submission.

**Recommendation:** Path A. Writers work at desktops. Phone is for
listening, where the PWA install already covers the experience. Desktop
app is the bigger writer-conversion win.

### Weeks 9–10: polish + launch prep

- [ ] Landing page: hero copy, demo video showing the revision loop,
  three feature highlights, pricing block, FAQ, signup CTA.
- [ ] Demo video: 60–90 seconds, no voiceover, captioned. Shows the
  full flow: paste chapter → generate → walk away → bookmark → revise →
  re-listen.
- [ ] First-100 customer onboarding email sequence (3–5 emails).
- [ ] Discord or Circle community for early customers.
- [ ] Refund / cancellation flow tested end-to-end.
- [ ] Crash reporting (Sentry).
- [ ] Analytics (Plausible or PostHog — pick one privacy-respecting).

### Weeks 11–12: soft launch

- [ ] Post to r/writing, r/indiepublishing, r/selfpublish.
- [ ] Post to NaNoWriMo forums.
- [ ] Post to indie author Discord servers (find via Reedsy).
- [ ] Email 5–10 friendly writers personally for first-week feedback.
- [ ] Charge $39 for early access (first 50 customers). Anchors V1
  perception toward the lower end of "real software" pricing without
  permanently capping you.
- [ ] Daily check on support email, Stripe dashboard, Sentry.
- [ ] Iterate based on first-week feedback.

---

## Cautions worth re-reading every few weeks

**Don't build for everyone.** The strongest pull will be to add Reader
features, Educator features, Self-Hosted features in V1 to "broaden the
appeal." Resist. Writers want a tool *for them*; the moment your landing
page also mentions students, it stops looking like it's for them.

**SaaS economics at 100 users are brutal.** $9/month × 100 × 0.7 (after
Stripe + app store cuts) = ~$630/month gross. Plan for 500+ paying
customers at a minimum to feel sane. Either get there fast or use
one-time pricing to fix the math.

**Self-hosted is your moat against your own failure modes.** If you ever
stop supporting the cloud version, customers can fall back. That's a
real promise that competitors literally cannot make. Lean into it in
marketing.

**Ship before you're ready.** First 50 customers don't care about the
features you're embarrassed by. They care that the core revision loop
works. Cut everything else from V1, ship, learn.

---

## What I (Claude) can help with from here

- Building the remaining BACKLOG features that strengthen V1's
  positioning (filler-words, long-sentence highlighter, chapter
  auto-split, LLM dialogue detection).
- Migrating IndexedDB schema to Supabase Postgres.
- Building the user account + cloud sync layer.
- Wrapping the web app in Tauri for desktop distribution.
- Building the Capacitor + Piper Android port.
- Setting up Stripe billing + entitlement gating.
- Drafting landing page copy and demo video script.
- Code review on anything you write.

## What you need to figure out outside this codebase

- Marketing positioning, landing page conversion copy, voice. Read
  *Obviously Awesome* by April Dunford. Lurk on r/SaaS and indie hacker
  communities.
- Legal entity setup, business bank, tax registration. Get an
  accountant — cheaper than the mistakes you'd make alone.
- Customer support muscle. Doing it well at scale is its own skill;
  start with email + responding within 24 hours.
- Networking with the writer community. Be a real person on writer
  forums for 3+ months before you launch. Hand-sell the first 10 customers.
- The mental shift from "personal tool" to "business." You're now
  thinking about churn, ARPU, LTV, CAC. That's a real change in
  identity. Books that help: *The Mom Test*, *Traction*, *The Lean Startup*.

---

## Open questions to revisit

- [x] **Subscription or one-time?** → One-time $129. (2026-05-29)
- [x] **On-device or cloud synthesis for V1?** → On-device. (2026-05-29)
- [x] **Tauri (desktop-first) or Capacitor (mobile-first)?** → Tauri. (2026-05-29)
- [x] **Free tier or paid-only?** → Paid-only with 7-day free trial. (2026-05-29)
- [x] **Direct sale or app store distribution?** → Direct sale via Stripe
  Checkout (implicit in Tauri-first; no app store presence in V1).
- [ ] LLC in your home state or Delaware C-corp from the start?
  (Talk to an accountant.)
- [ ] Cloud sync for desktop (Supabase) — V1.1 enhancement once the
  account system exists for license validation. Defer for now.
- [ ] LibriTTS / Piper voice-by-voice licensing audit before public sale.

---

## Cross-reference

Feature ideas still in scope live in [`BACKLOG.md`](./BACKLOG.md). Many
of those (LLM dialogue detection, chapter auto-split, filler-words,
long-sentence highlighter, voice favorites, listen statistics) become
V1 launch features once you commit to commercializing — they were
"nice to have" as a personal tool but become differentiators when
selling against Speechify and friends.

User-facing documentation lives in [`static/manual.html`](./static/manual.html).
That needs to be expanded with V1-specific sections (account setup,
billing, the writer-workflow chapter) before launch.
