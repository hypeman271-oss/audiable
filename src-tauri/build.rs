// Tauri build script — wires up tauri-build's codegen so
// generate_context!() in main.rs has the config + assets to hand to
// the runtime.
fn main() {
    tauri_build::build()
}
