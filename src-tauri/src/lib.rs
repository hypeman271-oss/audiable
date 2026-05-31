// Narrative desktop — Tauri v2 app runtime.
//
// Phase 2 (v220-AK): spawns the PyInstaller-bundled narrative-server
// as a sidecar before the window opens. The server serves both the
// PWA shell (static/) and the API (/api/*) on http://localhost:8000;
// the Tauri window is wired to that URL in tauri.conf.json.
//
// Path resolution:
//   - Dev (cargo run from src-tauri/): `../.pyinstaller-dist/narrative-server/narrative-server.exe`
//   - Bundled (release msi/dmg): `<exe_dir>/resources/narrative-server/narrative-server.exe`
//     (configured via tauri.conf.json's `bundle.resources` in Phase 3)
//
// We block on port 8000 readiness in `setup()` so the window doesn't
// flash a "connection refused" page during the ~1-2s the server takes
// to come up.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;

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
    // Phase 3 will configure tauri.conf.json to copy the sidecar
    // folder into resources at bundle time.
    let exe = std::env::current_exe().expect("can't read current_exe");
    let dir = exe.parent().expect("exe has no parent");
    dir.join("resources")
        .join("narrative-server")
        .join("narrative-server.exe")
}

// Block-wait for the sidecar to start serving. Uvicorn takes ~1-2s to
// boot the FastAPI app + import all the TTS/extract modules; without
// this poll the window opens to "ERR_CONNECTION_REFUSED" and the user
// has to manually reload. 10s ceiling guards against runaway startup.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            let sidecar_path = find_sidecar_exe();
            eprintln!("[narrative] spawning sidecar: {:?}", sidecar_path);
            let child = Command::new(&sidecar_path)
                .spawn()
                .expect("failed to spawn narrative-server sidecar");
            app.state::<SidecarHandle>()
                .0
                .lock()
                .unwrap()
                .replace(child);

            // Block until the FastAPI app is actually accepting
            // connections, then return — at this point the window
            // (configured in tauri.conf.json) starts loading and
            // sees a live server.
            let ready = wait_for_server(8000, Duration::from_secs(10));
            if !ready {
                eprintln!("[narrative] WARN: sidecar didn't bind :8000 in 10s — window may show connection error");
            } else {
                eprintln!("[narrative] sidecar ready on :8000");
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
                // Bind the AppHandle to a named variable so its
                // lifetime outlives the State<T> borrow we derive
                // from it. The intermediate `let x = ...; x` pattern
                // is verbatim what rustc suggests — it makes the
                // MutexGuard temporary drop on the assignment line
                // instead of leaking into the block's trailing-expr
                // position where it would outlive `state`.
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
