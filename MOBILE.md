# Mobile — Tauri Android build runbook

Narrative's phone story is a Tauri mobile build that extends the
existing `src-tauri/` desktop project. Same Rust glue, same webview,
same JS. The Android target produces an `.apk` that wraps
`static/index.html` and routes `/api/*` cross-origin to
`narrative-alpha.fly.dev` — same v4.27 cloud-pointed pattern as the
desktop build, no Python sidecar in the bundle.

iOS is gated on macOS access (see tracker #722-#725).

## Architecture

```
  .apk        Tauri shell  ┐
  (~10 MB)   ─ index.html  │  app.js: API_ORIGIN detects Tauri →
              ─ app.js     │   rewrites /api/* to https://...fly.dev
              ─ styles.css ┘   X-Narrative-Key header set per-tenant
              ─ sw.js          (the SW + IndexedDB still work on
              ─ icons/          Android Chrome's webview — sync
                                survives just like desktop browser)

  Fly backend (unchanged)
    GET /api/voices, /api/synth/jobs, /api/library/clips...
    CORS allowlist includes tauri://localhost (mobile uses same origin)
```

## Prerequisites

Windows host can build for Android. macOS is required for iOS.

### One-time install (Windows host)

1. **JDK 17** (Android Gradle Plugin 8.x requires it). Easiest:
   ```powershell
   winget install Microsoft.OpenJDK.17
   ```
   Then `[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Microsoft\jdk-17.0.x.x-hotspot", "User")`
   (path varies; check `C:\Program Files\Microsoft\` after install).

2. **Android Studio** (provides SDK, NDK, platform tools, AVD):
   ```powershell
   winget install Google.AndroidStudio
   ```
   - First launch: SDK Setup wizard. Accept defaults (installs to
     `%LOCALAPPDATA%\Android\Sdk`).
   - SDK Manager (`Tools → SDK Manager`):
     - Platforms tab: install Android 14 (API 34) or newer.
     - SDK Tools tab: install **NDK (Side by side)** + **CMake**.
   - Set env vars:
     ```powershell
     [Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
     [Environment]::SetEnvironmentVariable("NDK_HOME", "$env:LOCALAPPDATA\Android\Sdk\ndk\<version>", "User")
     ```

3. **Rust mobile targets**:
   ```powershell
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

4. **Tauri CLI** (same as desktop):
   ```powershell
   cargo install tauri-cli --version "^2.0"
   ```

### Verify

```powershell
java -version                  # 17.x
echo $env:ANDROID_HOME          # %LOCALAPPDATA%\Android\Sdk
echo $env:NDK_HOME              # ...\ndk\26.x.xxxxx
rustup target list --installed  # should show 4 android targets
cargo tauri --version           # 2.x
```

If any of these fail, re-open PowerShell — `[Environment]::SetEnv…` only
takes effect on next launch.

## First-time Android scaffold

From `src-tauri/` (where `tauri.conf.json` lives):

```powershell
cd E:\audiable\src-tauri
cargo tauri android init
```

This creates `src-tauri/gen/android/` — a Gradle project that wraps
`lib.rs` as a `cdylib`. Most files are auto-generated and shouldn't be
hand-edited; the exception is `gen/android/app/src/main/AndroidManifest.xml`
if you need to add permissions later.

Files that DO need to live in version control after init:
- `gen/android/app/build.gradle.kts`
- `gen/android/app/src/main/AndroidManifest.xml`
- `gen/android/app/proguard-rules.pro`

Add `gen/android/.gradle/`, `gen/android/build/`, `gen/android/app/build/`,
and `gen/android/local.properties` to `.gitignore` (already covered by
the existing `build/` line).

## Build + sideload an APK

Debug build (signed with the auto-generated debug key, not for Play
Store):

```powershell
cd E:\audiable\src-tauri
cargo tauri android dev          # live-reload to a connected device
                                  # OR
cargo tauri android build        # produce gen/android/app/build/outputs/apk/
```

To sideload onto a phone:

1. Phone: Settings → About → tap "Build number" 7× to enable Developer
   mode → Developer options → enable USB debugging.
2. Connect via USB. `adb devices` should list it (adb lives in
   `$ANDROID_HOME\platform-tools\`).
3. `adb install gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

## Release build (Play Store path, future)

1. Generate a release keystore (one-time):
   ```powershell
   keytool -genkey -v -keystore narrative-release.jks `
     -keyalg RSA -keysize 2048 -validity 10000 -alias narrative
   ```
   Treat this like the Tauri updater key — back it up, never commit.
2. Add signing config to `gen/android/app/build.gradle.kts`.
3. `cargo tauri android build --apk --release`
4. Produces a signed AAB for Play Store + APKs for direct distribution.

Pairs with #708 (DMG/MSI/NSIS build pipeline) — both flows want
GitHub Actions running them on a clean runner, not a dev laptop.

## What does and doesn't work on mobile

| Feature                          | Mobile status                   |
|----------------------------------|---------------------------------|
| Webview shell + `static/`        | ✅ identical to desktop          |
| Cloud `/api/*` via API_ORIGIN    | ✅ same CORS path as #704        |
| Native menu bar (#706)           | ⚠️ no-op on mobile (no menu bar) |
| Auto-updater (#707)              | ⚠️ Tauri 2.10 supports APK side-update; needs separate `android-aarch64` target string in DESKTOP_SIGNATURES and a `.apk` (not `.msi.zip`) on the CDN |
| Python sidecar                   | ❌ never bundled on mobile       |
| IndexedDB sync                   | ✅ Android webview supports it   |
| Service worker offline cache     | ✅ works in WebView              |
| MediaRecorder voice notes (#829) | ✅ on Android Chrome WebView 70+ |
| Web Speech transcript            | ⚠️ Chrome WebView Speech API spotty; fall back to server Whisper |

## Common failure modes

- **`cargo tauri android init` fails with "ANDROID_HOME not set"** —
  set the env var, close + reopen PowerShell.
- **`cargo tauri android dev` fails with "no connected device"** — USB
  debugging not enabled on the phone, or the OEM USB driver isn't
  installed. Try `adb kill-server; adb start-server; adb devices`.
- **Webview shows "ERR_CLEARTEXT_NOT_PERMITTED"** — only if you point
  `API_ORIGIN` at an http:// URL during dev. Fly is https so this
  shouldn't bite in production.
- **Build size > 100 MB** — debug builds embed debug symbols. Release
  builds with the existing `[profile.release]` config (LTO, opt=s,
  strip) should land around 8-12 MB.
