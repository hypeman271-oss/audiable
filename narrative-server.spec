# PyInstaller spec — bundles server.py + extract.py + github_oauth.py
# + the tts/ package + the static/ frontend into a one-folder distribution
# that the Tauri shell launches as a sidecar.
#
# Build:
#   pip install pyinstaller
#   pyinstaller narrative-server.spec --noconfirm \
#       --workpath E:/audiable/.pyinstaller-build \
#       --distpath E:/audiable/.pyinstaller-dist
#
# Output layout (in --distpath):
#   narrative-server/
#       narrative-server.exe        ← launched by Tauri
#       static/                     ← served by FastAPI's StaticFiles
#       _internal/                  ← bundled deps (onnxruntime, lxml, etc.)
#
# Voices (.onnx files) stay external — they're too big to bundle in the
# installer (~150-300 MB each, and the user may want multiple). The
# Phase 2 sidecar boot flow downloads them on first run via the
# existing /api/voices/install endpoint.

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Hidden imports — modules PyInstaller's static analysis misses.
hidden_imports = [
    # pyttsx3 dispatches by platform at import time, so its drivers
    # never appear in static analysis.
    "pyttsx3.drivers.sapi5",
    # uvicorn workers + protocols are loaded by string name at runtime.
    *collect_submodules("uvicorn"),
    # piper is the TTS engine; its model loader uses dynamic imports.
    *collect_submodules("piper"),
]

# Data files — non-Python assets the runtime expects on disk.
datas = [
    # Bundle the PWA shell so server.py's StaticFiles can serve it.
    ("static", "static"),
    # piper-phonemize ships espeak-ng data + the phoneme tables.
    *collect_data_files("piper_phonemize"),
    *collect_data_files("piper"),
    # trafilatura bundles language detection data tables.
    *collect_data_files("trafilatura"),
]

block_cipher = None

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    runtime_hooks=[],
    # Excludes — modules we never use, mostly to keep the bundle slim.
    # If a runtime import fails, drop it from this list.
    #
    # The big-three bloat trio (2.3 GB combined!) comes in transitively
    # via trafilatura → dateparser, which uses babel/pytz/tzdata for
    # locale-aware timestamp parsing. We extract URL TEXT, not timestamps
    # — these tables are pure cost. trafilatura still works fine without
    # dateparser; htmldate has a lighter built-in path.
    excludes=[
        "tkinter",
        "test",
        "unittest",
        "pydoc",
        "doctest",
        "dateparser",
        "dateparser_data",
        "babel",
        "pytz",
        "tzdata",
    ],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="narrative-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Phase 2a: keep the console window visible so we can read uvicorn
    # logs while iterating. Phase 2b will set console=False so the
    # final desktop app doesn't show a console window.
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="narrative-server",
)
