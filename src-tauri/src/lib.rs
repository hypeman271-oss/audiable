// Narrative desktop — Tauri v2 app runtime.
//
// Phase 2 (v220-AK): spawned the PyInstaller-bundled narrative-server
// as a sidecar before the window opened — that path is kept here as
// an opportunistic fast-path for dev (pyinstaller dist on disk), but
// is no longer required at runtime. Since #704 the window loads the
// bundled `static/index.html` directly and the JS layer talks cross-
// origin to https://narrative-alpha.fly.dev for /api/* calls, so the
// sidecar is optional and a missing exe is not fatal.
//
// v225v4.28 (#706): native Windows app menu. File / View / Help with
// Windows-style mnemonics + accelerators. Each menu item fires a
// `narrative:menu` CustomEvent on the webview via eval(), which the
// JS layer (static/app.js) routes to existing buttons / dialogs.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
// v225v4.42: gate menu + updater imports behind cfg(desktop). tauri::menu
// is #[cfg(desktop)] upstream — it doesn't exist on Android/iOS, so the
// import fails to resolve when cross-compiling for those targets. The
// updater plugin's UpdaterExt is only used by check_for_updates which
// is itself triggered by a desktop-only menu item, so we gate it too.
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

// Sidecar process handle. Stored as Tauri managed state so the window
// close handler can grab it and kill it cleanly. Mutex<Option<Child>>
// rather than just Child so the take()-on-shutdown pattern is safe.
struct SidecarHandle(Mutex<Option<Child>>);

fn find_sidecar_exe() -> PathBuf {
    // Dev path — relative to src-tauri/ where Cargo runs the binary.
    let dev = PathBuf::from("../.pyinstaller-dist/narrative-server/narrative-server.exe");
    if dev.exists() {
        return dev.canonicalize().unwrap_or(dev);
    }
    // Production path — alongside the Tauri binary's resources dir.
    let exe = std::env::current_exe().expect("can't read current_exe");
    let dir = exe.parent().expect("exe has no parent");
    dir.join("resources")
        .join("narrative-server")
        .join("narrative-server.exe")
}

// Block-wait for the sidecar to start serving. Only called when we
// actually managed to spawn the sidecar — never gates window open
// in cloud mode.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let addr = format!("127.0.0.1:{}", port);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(
            &addr.parse().unwrap(),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

// v225v4.28 (#706): build the native Windows menu bar. Using Submenu
// items because that's the cross-platform Tauri v2 menu API — on
// Windows they render as a top-bar menu, on macOS as the native app
// menu (with platform conventions like Quit landing in the app menu).
// Accelerators use Tauri's modifier syntax: "CmdOrCtrl" maps to Ctrl
// on Windows + Cmd on macOS.
// v225v4.42: gated to desktop. tauri::menu and Builder::menu() are
// #[cfg(desktop)] upstream — Android/iOS don't have native menubars
// so the whole function disappears on mobile.
#[cfg(desktop)]
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_item = MenuItem::with_id(app, "new", "&New clip", true, Some("CmdOrCtrl+N"))?;
    let quit_item = PredefinedMenuItem::quit(app, Some("E&xit"))?;
    let file = Submenu::with_items(
        app,
        "&File",
        true,
        &[
            &new_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let reload_item = MenuItem::with_id(app, "reload", "&Reload", true, Some("CmdOrCtrl+R"))?;
    let force_update_item = MenuItem::with_id(
        app,
        "force-update",
        "&Force update",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let book_view_item = MenuItem::with_id(
        app,
        "book-view",
        "Toggle &Book View",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let view = Submenu::with_items(
        app,
        "&View",
        true,
        &[
            &reload_item,
            &force_update_item,
            &PredefinedMenuItem::separator(app)?,
            &book_view_item,
        ],
    )?;

    let manual_item = MenuItem::with_id(app, "manual", "&Manual", true, Some("F1"))?;
    let whats_new_item =
        MenuItem::with_id(app, "whats-new", "&What's new", true, None::<&str>)?;
    // v225v4.29 (#707): user-triggered update check. The plugin also
    // polls at startup (silent), but exposing a menu item lets writers
    // pull a fresh release without restarting the app.
    let check_updates_item = MenuItem::with_id(
        app,
        "check-updates",
        "Check for &updates…",
        true,
        None::<&str>,
    )?;
    let about_item =
        MenuItem::with_id(app, "about", "&About Narrative", true, None::<&str>)?;
    let help = Submenu::with_items(
        app,
        "&Help",
        true,
        &[
            &manual_item,
            &whats_new_item,
            &check_updates_item,
            &PredefinedMenuItem::separator(app)?,
            &about_item,
        ],
    )?;

    Menu::with_items(app, &[&file, &view, &help])
}

// v225v4.29 (#707): updater check coroutine. Runs off the menu thread
// so the UI doesn't block during the HTTP round-trip to Fly. Result is
// signalled back to the webview via three CustomEvents that the JS
// layer renders as alerts:
//
//   - narrative:update-available  detail.version  → "Install v0.1.2?"
//   - narrative:update-none                       → "You're up to date"
//   - narrative:update-error      detail.msg      → "Check failed: ..."
//
// We escape single quotes in interpolated strings — version numbers
// shouldn't contain them but error messages absolutely can, and a stray
// quote in eval() would silently break event dispatch.
// v225v4.42: desktop-only. UpdaterExt is #[cfg(desktop)] upstream, and
// Android updates go through the Play Store, not our manifest endpoint.
#[cfg(desktop)]
async fn check_for_updates<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    fn dispatch<R: tauri::Runtime>(app: &tauri::AppHandle<R>, js: &str) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(js);
        }
    }
    fn escape(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', " ")
            .replace('\r', " ")
    }

    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let v = escape(&update.version);
                dispatch(
                    &app,
                    &format!(
                        "window.dispatchEvent(new CustomEvent('narrative:update-available',{{detail:{{version:'{}'}}}}))",
                        v
                    ),
                );
            }
            Ok(None) => {
                dispatch(
                    &app,
                    "window.dispatchEvent(new CustomEvent('narrative:update-none'))",
                );
            }
            Err(e) => {
                eprintln!("[narrative] updater check failed: {}", e);
                let msg = escape(&e.to_string());
                dispatch(
                    &app,
                    &format!(
                        "window.dispatchEvent(new CustomEvent('narrative:update-error',{{detail:{{msg:'{}'}}}}))",
                        msg
                    ),
                );
            }
        },
        Err(e) => {
            eprintln!("[narrative] updater not configured: {}", e);
            let msg = escape(&e.to_string());
            dispatch(
                &app,
                &format!(
                    "window.dispatchEvent(new CustomEvent('narrative:update-error',{{detail:{{msg:'{}'}}}}))",
                    msg
                ),
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v225v4.42: split the builder chain so we can conditionally add
    // the native menu only on desktop. tauri::menu and Builder::menu()
    // are #[cfg(desktop)] upstream — calling them on Android breaks
    // cross-compilation. We shadow `builder` on desktop so mobile
    // keeps the unmodified one.
    let builder = tauri::Builder::default()
        .manage(SidecarHandle(Mutex::new(None)))
        // v225v4.29 (#707): auto-updater plugin. Reads the endpoint +
        // public key from tauri.conf.json plugins.updater. Calling
        // app.updater()?.check() polls the manifest; download +
        // signature verification + install live inside the plugin.
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    let builder = builder
        .menu(|handle| build_menu(handle))
        .on_menu_event(|app, event| {
            // Forward the menu id to the webview as a CustomEvent. The
            // JS layer (static/app.js) listens for `narrative:menu`
            // and routes the action to the existing button / dialog.
            // We sanitise the id by allowing only the known set, so a
            // mistyped accelerator can't ever inject JS.
            let id = event.id().as_ref().to_string();
            let allowed = [
                "new",
                "reload",
                "force-update",
                "book-view",
                "manual",
                "whats-new",
                "check-updates",
                "about",
            ];
            if !allowed.contains(&id.as_str()) {
                return;
            }

            // v225v4.29 (#707): "Check for updates…" runs entirely in
            // Rust — the plugin's async API is cleaner here than going
            // through JS, and the webview just renders the result via
            // CustomEvent. Every other menu item still routes through
            // `narrative:menu` so the JS layer can dispatch to existing
            // buttons.
            if id == "check-updates" {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle).await;
                });
                return;
            }

            if let Some(win) = app.get_webview_window("main") {
                let js = format!(
                    "window.dispatchEvent(new CustomEvent('narrative:menu',{{detail:{{action:'{}'}}}}))",
                    id
                );
                let _ = win.eval(&js);
            }
        });

    builder
        .setup(|app| {
            // v225v4.43 (#709): on mobile, navigate the WebView to the
            // live Fly shell instead of the embedded static assets.
            // Effect: every Fly deploy ships UI updates to every Android
            // install instantly — no APK rebuild + reinstall loop.
            //
            // Desktop keeps the embedded-assets path (offline-friendly,
            // signed bundles, native menu bar, auto-updater). Mobile is
            // effectively online-only; if Fly is unreachable, the app
            // shows the WebView's default load-failure page. That's the
            // acceptable trade for v1 dogfood — proper offline mobile is
            // gated on #568 (WASM Piper).
            //
            // The embedded index.html still loads briefly before this
            // navigate fires, but it's a single frame at most before the
            // WebView jumps to Fly. After navigation the origin becomes
            // https://narrative-alpha.fly.dev so /api/* fetches are
            // same-origin — the v4.27 cross-origin fetch wrapper becomes
            // a no-op pass-through.
            #[cfg(mobile)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    match "https://narrative-alpha.fly.dev/".parse::<tauri::Url>() {
                        Ok(url) => {
                            if let Err(e) = win.navigate(url) {
                                eprintln!(
                                    "[narrative] mobile: navigate to Fly failed: {}",
                                    e
                                );
                            } else {
                                eprintln!(
                                    "[narrative] mobile: navigated to https://narrative-alpha.fly.dev/"
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!("[narrative] mobile: invalid Fly URL: {}", e);
                        }
                    }
                }
            }

            // v225v4.28 (#706): sidecar is now opportunistic. We try
            // to spawn it for dev convenience (so a `cargo tauri dev`
            // build with the PyInstaller dist on disk still works
            // fully offline against a local server). If the exe isn't
            // present, we shrug and let the JS fetch wrapper route
            // /api/* to Fly via API_ORIGIN. On mobile this is a no-op:
            // find_sidecar_exe() returns a path that never exists, so
            // we drop straight into cloud mode (and the navigate above
            // means we don't talk to :8000 at all on phone).
            let sidecar_path = find_sidecar_exe();
            if sidecar_path.exists() {
                eprintln!("[narrative] spawning sidecar: {:?}", sidecar_path);
                match Command::new(&sidecar_path).spawn() {
                    Ok(child) => {
                        app.state::<SidecarHandle>()
                            .0
                            .lock()
                            .unwrap()
                            .replace(child);
                        let ready = wait_for_server(8000, Duration::from_secs(10));
                        if ready {
                            eprintln!("[narrative] sidecar ready on :8000");
                        } else {
                            eprintln!(
                                "[narrative] WARN: sidecar didn't bind :8000 in 10s — falling back to cloud"
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("[narrative] sidecar spawn failed ({}) — cloud mode", e);
                    }
                }
            } else {
                eprintln!(
                    "[narrative] no sidecar at {:?} — cloud mode (talks to Fly)",
                    sidecar_path
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // When the user closes the window, kill the sidecar so it
            // doesn't linger as a zombie uvicorn process eating CPU.
            // Tauri exits the app after the last window closes, but
            // a spawned subprocess survives unless we explicitly reap it.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Inner block scope drops the MutexGuard before we
                // call into the Child's blocking kill+wait below,
                // so we don't hold a lock across a syscall.
                let handle = window.app_handle().clone();
                let maybe_child = {
                    let state = handle.state::<SidecarHandle>();
                    let x = state.0.lock().unwrap().take();
                    x
                };
                if let Some(mut child) = maybe_child {
                    eprintln!("[narrative] killing sidecar pid {}", child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
