# Updates — Tauri desktop auto-update runbook

Narrative's desktop shell (`src-tauri/`) ships with the Tauri v2 updater
plugin wired in. This file explains how a new release reaches existing
installs.

## Architecture

```
  installed app ─── poll ───► narrative-alpha.fly.dev
                              GET /api/updates/latest/{target}/{version}

  server returns:
    • 204         → "you're up to date"
    • 200 + JSON  → { version, signature, url } per platform

  plugin downloads signed bundle, verifies Ed25519 signature
  against the public key baked into the binary, then prompts
  the user to restart.
```

Two failure modes the design protects against:

1. **MITM forcing a malicious update**  — every bundle is signed; the
   verify step rejects anything that doesn't match the embedded pubkey.
2. **Signing-key leak**  — the public key is committed in
   `tauri.conf.json`; the private key (a `.key` file) is `.gitignore`d
   and lives on a single trusted machine. If it leaks, all future
   updates would have to ship a NEW pubkey and existing installs would
   need to be replaced from scratch — there's no recovery path. Treat
   the file like a code-signing cert.

## First-time setup (one-off, before V1 release)

1. Install the Tauri CLI: `cargo install tauri-cli --version "^2.0"`
2. Generate the signing keypair:
   ```powershell
   New-Item -ItemType Directory -Force E:\audiable\src-tauri\.tauri
   cargo tauri signer generate -w E:\audiable\src-tauri\.tauri\narrative-updater.key
   ```
   - **Private key**: `narrative-updater.key` — gitignored, back this up to
     a password manager or hardware token. Losing it ends update delivery.
   - **Public key**: printed to stdout. Looks like
     `dW50cnVzdGVkIGNvbW1lbnQ6...` (base64 minisign format).
3. Paste the public key into `src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey`, replacing `REPLACE_WITH_TAURI_SIGNER_PUBKEY`.
4. Commit the conf.json change. NEVER commit the `.key` file.

## Releasing a new desktop version

1. Bump versions to match across:
   - `src-tauri/Cargo.toml`              → `version = "0.1.1"`
   - `src-tauri/tauri.conf.json`         → `"version": "0.1.1"`
   - `server.py` `LATEST_DESKTOP_VERSION` → `"0.1.1"`
2. Build the bundle:
   ```powershell
   cd E:\audiable\src-tauri
   cargo tauri build
   ```
   This produces `target/release/bundle/{msi,dmg,appimage}/Narrative_0.1.1_*.{msi,dmg,AppImage}`
   plus matching `.sig` files (since `createUpdaterArtifacts: true`).
3. Sign each bundle that the plugin will download (the updater wants
   the `.zip`/`.tar.gz`-wrapped versions in `bundle/`):
   ```powershell
   cargo tauri signer sign `
     -k E:\audiable\src-tauri\.tauri\narrative-updater.key `
     E:\audiable\src-tauri\target\release\bundle\msi\Narrative_0.1.1_x64_en-US.msi.zip
   ```
   The signature prints to stdout as a base64 string.
4. Upload each signed bundle to a CDN or to Fly's `/downloads/` path
   (decide before release; see `DEPLOY.md`).
5. Paste each `target → signature` pair into `DESKTOP_SIGNATURES` in
   `server.py`.
6. Deploy:
   ```powershell
   & E:\audiable\scripts\deploy.ps1
   ```
7. Verify from an installed older copy: Help → Check for updates…

## Verifying the wiring without a real release

Even with `LATEST_DESKTOP_VERSION = "0.1.0"` and the installed app at
`0.1.0`, the menu item should:

- Hit `/api/updates/latest/windows-x86_64/0.1.0`
- Receive HTTP 204 (no update available)
- Show the "You're on the latest version" alert

If you instead see "Couldn't check for updates" with an error about an
invalid public key, you skipped step 3 of first-time setup.

## Why we go through Rust instead of the JS updater SDK

The webview shell intentionally ships without a JS bundler (see
`/static/app.js` line 1 comment about `withGlobalTauri: false`). That
makes the JS-side updater plugin unusable — we'd need to bundle
`@tauri-apps/plugin-updater`. Driving the check from the Rust side and
firing `CustomEvent`s into the webview keeps the bundler-less story
intact while still surfacing nice UI for the user.
