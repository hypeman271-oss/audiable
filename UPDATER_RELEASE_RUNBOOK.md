# Auto-updater release runbook

Owner: kmythers
Status: tonight ships the **install side** (v0.1.1 MSI with startup auto-poll
+ plugin dialog). The **release side** (server-side signature pipeline +
first end-to-end test) lands in a fresh session per this doc.

## Where we are tonight (v0.1.1 baseline)

Shipped in the v0.1.1 MSI:
- `lib.rs` startup auto-poll — calls `check_for_updates(app)` ~immediately
  after launch
- `tauri.conf.json` plugins.updater.dialog = **true** — Tauri plugin shows
  its own "Install update v0.1.X?" dialog with download progress
- Versions bumped to **0.1.1** in `Cargo.toml` + `tauri.conf.json`
- Auto-updater plugin (#707) already installed

What we DEFERRED:
- `server.py` LATEST_DESKTOP_VERSION still **"0.1.0"** so the v0.1.1 install
  will check, get HTTP 204 ("you're past the listed latest"), and stay
  silent. No false popup.
- `DESKTOP_DOWNLOAD_BASE` still points at `/downloads` on Fly which
  doesn't exist yet
- `DESKTOP_SIGNATURES` still empty
- Target naming bridge (Tauri's `Narrative_0.1.X_x64-setup.exe.zip` vs
  server's `Narrative_X.Y.Z_{target}.zip`) — not aligned

When you install the v0.1.1 MSI tonight, every launch will:
1. Quietly poll `/api/updates/latest/windows-x86_64/0.1.1`
2. Get a 204 (server's LATEST is 0.1.0, your 0.1.1 ≥ 0.1.0)
3. Stay silent — no popup, no error

That's the desired baseline. Next session we make a release THAT THIS
INSTALL CAN FIND.

## Next session — first real release (target: v0.1.2)

### Pre-flight: pick the asset hosting model

Two options, both work with the Tauri updater plugin:

**Option 1 — GitHub Releases (recommended)**
- Use the existing `.github/workflows/release.yml` workflow (#708)
- Tag-push → CI builds + signs + uploads to GH Release
- Update `DESKTOP_DOWNLOAD_BASE` in server.py to the GH Release URL pattern
- Pros: free hosting, version-immutable, no Fly bandwidth
- Cons: need to copy .sig contents from each asset by hand

**Option 2 — Fly /downloads/**
- Add a FastAPI static route for `/downloads/*` in server.py
- Mount a Fly volume to host the bundles
- Upload bundles after each build
- Pros: same domain everywhere, simpler URL pattern
- Cons: counts against Fly bandwidth quota, manual upload

**Pick Option 1 unless there's a reason not to.**

### Steps (assuming Option 1)

1. **Align target naming in server.py**

   Tauri 2 on Windows emits update bundles as:
   - `Narrative_0.1.2_x64-setup.exe.zip` (NSIS)
   - `Narrative_0.1.2_x64_en-US.msi.zip` (MSI)
   - Plus `.sig` next to each

   The plugin's target string for Windows x64 is `windows-x86_64`.

   Update the URL template in `server.py`:
   ```python
   # Was:  f"{DESKTOP_DOWNLOAD_BASE}/Narrative_{LATEST_DESKTOP_VERSION}_{target}.zip"
   # New:  f"{DESKTOP_DOWNLOAD_BASE}/v{LATEST_DESKTOP_VERSION}/Narrative_{LATEST_DESKTOP_VERSION}_x64-setup.exe.zip"
   ```
   (and analogous patterns for darwin-aarch64 / darwin-x86_64 / linux-x86_64
   when we add them — for now, Windows-only is fine for V1)

2. **Set DESKTOP_DOWNLOAD_BASE to the GH Releases pattern**
   ```python
   DESKTOP_DOWNLOAD_BASE = "https://github.com/<owner>/<repo>/releases/download"
   ```

3. **Make a real change** (UI fix, copy tweak, whatever)

4. **Bump versions:**
   - `src-tauri/Cargo.toml` → `version = "0.1.2"`
   - `src-tauri/tauri.conf.json` → `"version": "0.1.2"`
   - `server.py` → `LATEST_DESKTOP_VERSION = "0.1.2"`

5. **Commit + tag + push:**
   ```powershell
   git add -A
   git commit -m "Release v0.1.2"
   git tag v0.1.2
   git push origin main --tags
   ```

6. **Wait for CI** (~15-20 min). The release workflow builds Windows +
   macOS + Linux, signs the updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`,
   creates a draft GH Release with all bundles attached.

7. **Grab the signatures.** For each platform target:
   - Download the corresponding `.sig` file from the draft release
   - The `.sig` is a small text file with a base64 blob
   - Copy the entire contents (one long line)

8. **Paste into server.py `DESKTOP_SIGNATURES`:**
   ```python
   DESKTOP_SIGNATURES = {
       "windows-x86_64": "<paste the .sig content here>",
       # macOS/Linux added later
   }
   ```

9. **Publish the GH Release** (move from draft to published)

10. **Deploy Fly:**
    ```powershell
    & D:\audiable\scripts\deploy.ps1 -Force
    ```

11. **Test the popup.** On your existing v0.1.1 install:
    - Close Narrative
    - Reopen
    - Within a couple seconds, Tauri's update dialog should appear:
      *"A new version of Narrative is available. v0.1.2 — Would you like to install it now?"*
    - Click Yes
    - Plugin downloads, verifies signature against the embedded
      pubkey, installs, restarts
    - You're on v0.1.2 with zero manual MSI work

12. **If the popup doesn't appear:**
    - Check Fly server log for the `/api/updates/latest/...` request
    - Verify response is `200 + JSON` (not 204)
    - If 204: signature missing or version comparison wrong
    - If 200 but no popup: plugin install / signature mismatch — check
      WebView's console (right-click → Inspect on the DevTools build)

13. **From here on, every release** is steps 3-10. ~10 minutes per release.

## Per-release checklist (steady state)

After the v0.1.2 first-release validation:

```
□ Make code changes (whatever)
□ Bump Cargo.toml + tauri.conf.json + server.py version
□ git add -A && git commit -m "Release v0.1.X" && git tag v0.1.X
□ git push origin main --tags
□ Wait for CI (~15 min)
□ Download .sig files from the new draft release. As of v0.1.9 (#859)
  there are FOUR Windows + Mac sigs to grab, named per-arch:
    - Narrative_0.1.X_x64-setup.exe.sig   (NSIS, used for both
                                            windows-x86_64-nsis + windows-x86_64)
    - Narrative_aarch64.app.tar.gz.sig    (macOS Apple Silicon)
    - Narrative_x64.app.tar.gz.sig        (macOS Intel)
  Linux ships its own sig once #860 lands.
□ Paste into DESKTOP_SIGNATURES_BY_KEY (server.py). Windows gets the
  same sig pasted into BOTH windows keys (Tauri only emits one x64
  NSIS bundle). macOS aarch64 + x64 each get their own arch sig.
□ Publish the GH Release  (release.yml auto-publishes — usually already done)
□ Deploy Fly via scripts/deploy.ps1 — auto-runs verify_updater_manifest.py
   (catches forgot-to-repaste-sig + draft-release + wrong-key bugs;
    blocks the deploy declaring success if the manifest is broken)
□ Open desktop install → confirm popup → click Install → confirm v0.1.X is running
```

## Future cleanup

- Add automated step for "fetch .sig contents from latest GH release and
  PR the server.py update" — eliminates the copy-paste step
- macOS sign+notarize workflow (#722) — currently the macOS bundle is
  ad-hoc signed; will need real Apple Developer cert for Gatekeeper to
  not warn
- Windows code-sign cert (#214) — currently the MSI is unsigned;
  SmartScreen shows "Unknown publisher" warning on first install
- Consider auto-merge of CI release tag PRs once signing keys are in
  hand for both platforms

## Why this is two sessions, not one

Real talk: the first end-to-end test of a Tauri updater pipeline can
take an hour or two on its own (target string mismatches, URL pattern
typos, signature paste errors). Doing that at the end of a long debug
session — after we already spent four hours on CORS + dialog work — is
exactly how broken pipelines ship. Tonight ships the install side as a
clean, low-risk baseline. Next session is focused, fresh, and
test-driven against a brand-new draft release.

## What "one-click update" looks like to the user (the goal)

1. Open Narrative on Tuesday morning
2. See a small native dialog: "Narrative v0.1.7 is available. Install
   now? [Install] [Later]"
3. Click **Install**
4. ~10 seconds of download progress
5. App quits and relaunches on v0.1.7
6. Get back to writing

That's the experience we're shipping toward.
