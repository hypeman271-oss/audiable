// Narrative desktop — Tauri v2 entry point.
//
// The `windows_subsystem = "windows"` attribute on release builds
// suppresses the otherwise-spawned console window on Windows. Debug
// builds keep the console so we can read panic output during dev.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Delegate to the lib crate's run() so the same entry point can
    // be used by mobile targets later (Tauri v2's standard pattern).
    narrative_lib::run()
}
