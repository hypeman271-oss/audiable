# Narrative — alpha deploy walkthrough

Step-by-step guide for putting Narrative on Fly.io so your alpha testers
can reach a public HTTPS URL without your local PC being on.

Estimated time: **~30 minutes the first time**, ~30 seconds for redeploys.

---

## What you'll have at the end

- A public HTTPS URL like `https://narrative-alpha.fly.dev` (or your
  custom domain).
- A single shared `NARRATIVE_KEY` your alpha testers paste once.
- Auto-stop when idle (you pay only for time the machine is running).
- One-command redeploys when you change code.

---

## Before you start

You need:

- [ ] **Fly.io account** — sign up at <https://fly.io/app/sign-up>. They'll
  ask for a credit card for the trial. Alpha usage typically lands at
  $5–10/month.
- [ ] **Docker installed** locally — Fly.io builds with `docker` if it's
  there, or remote-builds without it. Either works. Get Docker Desktop at
  <https://docker.com> if you don't have it.
- [ ] **`flyctl` CLI** — the Fly.io command-line tool.
- [ ] **A random secret string** for `NARRATIVE_KEY` — run
  `python -c "import secrets; print(secrets.token_urlsafe(24))"` and
  save the output. You'll paste this on your phone the first time.
- [ ] **An email address** to swap into `static/app.js` for the
  feedback link.

---

## 1. Install flyctl

**Windows (PowerShell as administrator):**

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

After install, restart your terminal so PATH picks up the new binary.

**macOS:**

```bash
curl -L https://fly.io/install.sh | sh
```

**Linux:**

```bash
curl -L https://fly.io/install.sh | sh
```

Verify:

```
fly version
```

---

## 2. Log in

```
fly auth login
```

Browser opens; complete the flow. Done.

---

## 3. Swap the feedback email

Open `static/app.js`, find this near the top:

```javascript
const FEEDBACK_EMAIL = "you@example.com";
```

Change `you@example.com` to wherever you want your alpha testers' emails
to land. Save the file.

---

## 4. Launch the app

From the project root (`E:\audiable`):

```
fly launch --no-deploy
```

Interactive prompts you'll see:

- **"Choose an app name"** — anything unique on Fly. `narrative-alpha`,
  `your-handle-narrative`, etc. This determines the default URL
  (`https://YOUR-APP-NAME.fly.dev`). Hit Enter to accept the default
  Fly suggests if you don't care.
- **"Select region for deployment"** — pick whatever's closest to your
  alpha testers. `iad` (Ashburn, VA — US East) is the default.
- **"Would you like to set up a Postgresql database?"** → **No**
- **"Would you like to set up an Upstash Redis database?"** → **No**
- **"Would you like to set up Tigris object storage?"** → **No**
- **"Create .dockerignore from 1 .gitignore files?"** → **No** (we
  already have one).
- **"Would you like to deploy now?"** → **No** (we want to set secrets first).

If asked anything else, the safe answer is whatever's the simplest option
("No" or "Default").

This generates / updates `fly.toml` for you. Don't worry — the file
already in the repo will be merged with anything Fly adds.

---

## 5. Set your secrets

The API key your friends paste in once:

```
fly secrets set NARRATIVE_KEY=paste-the-token-you-generated-earlier
```

Replace `paste-the-token-you-generated-earlier` with the
`secrets.token_urlsafe(24)` output. Save this string somewhere safe (a
password manager, your notes app) — you'll send it to your alpha
testers.

---

## 6. Deploy

```
fly deploy
```

This:

1. Builds the Docker image (using the `Dockerfile` in the repo). Voices
   are baked in — image size will be ~200–300 MB depending on which
   voices you have installed locally.
2. Uploads the image to Fly's registry.
3. Starts a machine running the image.
4. Runs the healthcheck (hits `/api/voices`).
5. Routes the public URL at the new machine.

First deploy takes 5–15 minutes (mostly the image build + upload).
Subsequent deploys after code changes are 1–3 minutes.

When it finishes, the CLI prints something like:

```
Visit your newly deployed app at https://narrative-alpha.fly.dev/
```

That's your URL.

---

## 7. Smoke-test

Open the URL in a browser. You should hit the API-key prompt the moment
the app tries to load `/api/voices`. Paste the key you set in step 5.

Now:

- Generate a short clip. (First synthesis may be slow as the machine
  warms up.)
- Confirm the voice loaded properly.
- Open Settings → tap **Send feedback →**. Your mail client opens with a
  pre-filled report addressed to the email you set in step 3.

If anything errors, see Troubleshooting at the bottom.

---

## 8. Share with your alpha testers

Text / email each tester something like:

> Hey — I built a TTS app for revising my own writing. Looking for ~5
> people to try it for a few weeks and tell me what's broken. Free,
> obviously, no signup.
>
> URL: https://narrative-alpha.fly.dev/
> When it prompts for an API key, paste: `xyz123abc`
>
> On phone: open the URL in Chrome (Android) or Safari (iOS), tap
> the install prompt, and it lives on your home screen.
>
> Reply here or use Settings → Send feedback in the app for anything
> that breaks or feels weird. There's a manual at the ⚙ icon.

If they have questions, the manual at `https://narrative-alpha.fly.dev/manual.html`
covers most of the app.

---

## Redeploying after code changes

When you update code and want to push it live:

```
fly deploy
```

That's the whole update flow. Service worker will pick up new code on
testers' next visit (one extra page reload to fully activate the new
shell).

---

## Cost monitoring

```
fly status         # current state of your machine
fly logs           # live logs from the running container
fly dashboard      # opens the web dashboard in your browser
```

Fly bills monthly. With `auto_stop_machines = "stop"` in `fly.toml`,
your machine spins down when idle (no requests for ~5 minutes) and
spins back up on the first request. That cold start is ~5–10s, and
alpha testers should be warned ("first request after a quiet period
might take a few seconds"). The trade is that idle hours don't bill.

Expected monthly bill for ~10 alpha testers using it occasionally:
**$5–10**.

If billing surprises you, run `fly dashboard` and look at the metrics
graph. The two things that drive cost are machine-hours (auto-stop
keeps this low) and bandwidth (Narrative is text + small audio files —
should be negligible).

---

## Updating the API key

If the key leaks or you want to rotate:

```
fly secrets set NARRATIVE_KEY=new-token-here
```

Fly automatically restarts the machine with the new env var. Every alpha
tester gets re-prompted for the key on their next request. You text them
the new one.

---

## Adding more voices to the hosted instance

Voices are baked into the image. To add one:

1. On your local machine, use Browse voices → Install (or `python
   scripts/get_voice.py de_DE-thorsten-medium`).
2. Verify the new `voices/de_DE-thorsten-medium.onnx` + `.onnx.json` are
   in your local `voices/` directory.
3. `fly deploy` from the project root. The new image includes the
   voice; the running machine cycles in the updated version.

Larger voices (LibriTTS at 130 MB) noticeably bloat the image — fine for
a few but if you ship 10 voices the image gets to ~1 GB. At that scale,
switch to a Fly volume (`fly volumes create voices --size 1`) mounted at
`/app/voices` and download voices via the in-app catalog at runtime.

---

## Troubleshooting

### "Address already in use" or healthcheck fails

The server might not be binding to the right interface. Confirm
`server.py` ends with `uvicorn.run(..., host="0.0.0.0", port=PORT, ...)`
— not `127.0.0.1`. The default in this repo is already `0.0.0.0`, but
worth a glance.

### "401 missing or invalid X-Narrative-Key" on first load

Either you forgot to set `NARRATIVE_KEY` as a secret, or your tester is
trying to hit `/api/*` before pasting it. The static assets (index,
JS, manual) don't require auth, so the app loads — but the first
voice-list request errors. Make sure `fly secrets list` shows
`NARRATIVE_KEY` is present.

### 503 Server Unavailable on every request after setting NARRATIVE_KEY

The Fly healthcheck path is configured to hit `/` (static index) for
exactly this reason — if you pointed it at any `/api/*` endpoint, the
auth gate would also block the healthcheck, Fly would mark the machine
unhealthy, and you'd get 503s everywhere. If you see this and your
`fly.toml` healthcheck path starts with `/api/`, change it to `/` and
`fly deploy`.

### "Module not found: piper" or similar import error in logs

`fly logs` will show this. Means `requirements.txt` didn't install
something. Check the build log — sometimes piper-tts hits architecture
issues. Try forcing the platform in your `Dockerfile`:

```dockerfile
FROM --platform=linux/amd64 python:3.12-slim AS base
```

Fly's machines are amd64 by default, but explicit doesn't hurt.

### Synthesis is painfully slow

The shared-CPU 1× VM is the cheapest tier. If alpha testers complain
synthesis is too slow:

```toml
[[vm]]
  cpu_kind = "performance"  # was "shared"
  cpus = 2                  # was 1
  memory_mb = 2048          # was 1024
```

Then `fly deploy`. Bumps your monthly bill to ~$15–25 but speeds up
synthesis 3–5×.

### Out-of-memory crashes during synthesis

Same fix — bump `memory_mb` to 2048. Piper for `_high` quality voices
sometimes spikes over 1 GB during a long render.

### "Could not pull image" / build hanging

Sometimes Fly's remote builders have hiccups. Try a local Docker build
first to confirm your image works:

```
docker build -t narrative .
docker run --rm -p 8000:8000 narrative
```

If that works locally, retry `fly deploy`. If it consistently fails,
try `fly deploy --local-only` to use your local Docker daemon for the
build.

---

## When alpha turns into "this is going somewhere"

The path from here to V1 is in `STRATEGY.md`. The architectural changes
(user accounts, Supabase migration, Stripe billing) layer on top of this
deployment cleanly — Fly continues to host the backend while you add
the database and billing services around it.
