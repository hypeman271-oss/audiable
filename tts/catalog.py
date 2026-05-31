"""Voice catalog browsing + on-demand download.

Reads the master list from rhasspy/piper-voices/voices.json on HuggingFace,
cross-references with what's already installed in voices/, and lets the
frontend trigger installs without dropping to the CLI.

The catalog (~280 KB JSON for 160-ish voices) is cached in-process for an
hour so the browser doesn't re-fetch on every dialog open. The piper engine
re-scans voices/ on every list_voices() call, so freshly-installed voices
appear immediately without a server restart.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from .voice_licenses import license_for

VOICES_DIR = Path(__file__).resolve().parent.parent / "voices"
CATALOG_URL = "https://huggingface.co/rhasspy/piper-voices/raw/main/voices.json"
DOWNLOAD_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

_CACHE_TTL_SEC = 3600
_catalog_cache: dict | None = None
_catalog_fetched_at: float = 0.0


def fetch_catalog(force_refresh: bool = False) -> dict:
    """Return the parsed voices.json (id → metadata)."""
    global _catalog_cache, _catalog_fetched_at
    if (
        not force_refresh
        and _catalog_cache is not None
        and time.time() - _catalog_fetched_at < _CACHE_TTL_SEC
    ):
        return _catalog_cache
    req = urllib.request.Request(
        CATALOG_URL, headers={"User-Agent": "narrative/0.1 (+local)"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        _catalog_cache = json.loads(resp.read().decode("utf-8"))
        _catalog_fetched_at = time.time()
    return _catalog_cache


def installed_ids() -> set[str]:
    """Set of voice IDs already on disk (paired .onnx + .onnx.json)."""
    if not VOICES_DIR.exists():
        return set()
    out: set[str] = set()
    for onnx in VOICES_DIR.glob("*.onnx"):
        cfg = onnx.with_suffix(".onnx.json")
        if cfg.exists() and onnx.stat().st_size > 0:
            out.add(onnx.stem)
    return out


def _voice_size_mb(voice: dict) -> float:
    """Combined .onnx + .onnx.json size from the catalog entry, in MB."""
    total = 0
    for path, info in (voice.get("files") or {}).items():
        if path.endswith(".onnx") or path.endswith(".onnx.json"):
            total += (info or {}).get("size_bytes", 0)
    return round(total / (1024 * 1024), 1)


def list_for_ui() -> list[dict]:
    """Flatten the catalog into the shape the frontend wants."""
    catalog = fetch_catalog()
    installed = installed_ids()
    voices = []
    for voice_id, v in catalog.items():
        lang = v.get("language") or {}
        lic = license_for(voice_id)
        voices.append(
            {
                "id": voice_id,
                "name": v.get("name") or voice_id,
                "language_code": lang.get("code") or "",
                "language_name": lang.get("name_english") or "",
                "language_native": lang.get("name_native") or "",
                "country": lang.get("country_english") or "",
                "quality": v.get("quality") or "",
                "num_speakers": v.get("num_speakers") or 1,
                "size_mb": _voice_size_mb(v),
                "installed": voice_id in installed,
                # v217: every voice carries license metadata. UI surfaces
                # `commercial` as a badge; `attribution` is what the user
                # must credit when distributing generated audio.
                "license": lic.get("license") or "Unaudited",
                "license_dataset": lic.get("dataset") or "",
                "license_dataset_url": lic.get("dataset_url") or "",
                "license_commercial": bool(lic.get("commercial")),
                "license_attribution": lic.get("attribution") or "",
                "license_notes": lic.get("notes") or "",
            }
        )
    return voices


# Per-process cache of preview sample bytes so flipping through the voice
# browser doesn't hammer HuggingFace. Samples are small (~50-100KB each), so
# 100 entries cap RAM at ~10MB worst case before we just drop the cache.
_SAMPLE_CACHE: dict[str, bytes] = {}
_SAMPLE_CACHE_MAX = 100


def _sample_url(voice_id: str, speaker_id: int = 0) -> str:
    parts = voice_id.split("-")
    if len(parts) != 3:
        raise ValueError(f"invalid voice id format: {voice_id!r}")
    locale, name, quality = parts
    lang = locale.split("_")[0]
    return (
        f"{DOWNLOAD_BASE}/{lang}/{locale}/{name}/{quality}"
        f"/samples/speaker_{speaker_id}.mp3"
    )


def fetch_sample(voice_id: str, speaker_id: int = 0) -> bytes:
    """Return the official Piper preview MP3 for a (voice, speaker) pair.

    Multi-speaker voices like LibriTTS publish one sample per speaker
    (speaker_0.mp3 through speaker_N-1.mp3). Single-speaker voices only
    have speaker_0.mp3. Raises FileNotFoundError if the requested combo
    has no published sample. Cached in-process per (voice, speaker).
    """
    cache_key = f"{voice_id}#{speaker_id}"
    if cache_key in _SAMPLE_CACHE:
        return _SAMPLE_CACHE[cache_key]
    url = _sample_url(voice_id, speaker_id)
    req = urllib.request.Request(url, headers={"User-Agent": "narrative/0.1 (+local)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise FileNotFoundError(
                f"no sample for {voice_id} speaker {speaker_id}"
            ) from e
        raise
    # Crude eviction — drop the whole cache if it's full. Lookups are
    # bursty (one click of "preview" per voice/speaker) so an LRU would be overkill.
    if len(_SAMPLE_CACHE) >= _SAMPLE_CACHE_MAX:
        _SAMPLE_CACHE.clear()
    _SAMPLE_CACHE[cache_key] = data
    return data


def download_voice_iter(voice_id: str):
    """Generator: yields download progress dicts then a final done dict.

    Events:
      {"type": "start",    "voice_id": str, "total_bytes": int}
      {"type": "progress", "downloaded": int, "total": int}
      {"type": "done",     "voice_id": str}

    Idempotent. Already-present files are reported instantly at 100%
    of their expected byte count so the UI snaps to "Installed" without
    re-downloading. Partial files on failure are cleaned up so a retry
    re-fetches instead of seeing a zero-byte stub and skipping.
    """
    catalog = fetch_catalog()
    if voice_id not in catalog:
        raise ValueError(f"unknown voice: {voice_id}")

    parts = voice_id.split("-")
    if len(parts) != 3:
        raise ValueError(f"invalid voice id format: {voice_id!r}")
    locale, name, quality = parts
    lang = locale.split("_")[0]

    VOICES_DIR.mkdir(parents=True, exist_ok=True)

    voice = catalog[voice_id]
    files_in_catalog = voice.get("files") or {}

    # Build the per-file plan with expected sizes from the catalog so we know
    # the total up-front (no extra HEAD request per file).
    file_specs: list[tuple[str, Path, int]] = []
    for ext in ("onnx", "onnx.json"):
        fname = f"{voice_id}.{ext}"
        rel_path = f"{lang}/{locale}/{name}/{quality}/{fname}"
        info = files_in_catalog.get(rel_path) or {}
        size_bytes = int(info.get("size_bytes") or 0)
        out = VOICES_DIR / fname
        url = f"{DOWNLOAD_BASE}/{rel_path}"
        file_specs.append((url, out, size_bytes))

    total_bytes = sum(s for _, _, s in file_specs)
    yield {"type": "start", "voice_id": voice_id, "total_bytes": total_bytes}

    downloaded = 0
    CHUNK = 64 * 1024  # ~5-30 progress events per file at typical Piper sizes

    for url, out, expected_size in file_specs:
        if out.exists() and out.stat().st_size > 0:
            downloaded += expected_size or out.stat().st_size
            yield {
                "type": "progress",
                "downloaded": downloaded,
                "total": total_bytes,
            }
            continue

        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "narrative/0.1 (+local)"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp, open(out, "wb") as f:
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    yield {
                        "type": "progress",
                        "downloaded": downloaded,
                        "total": total_bytes,
                    }
        except urllib.error.HTTPError as e:
            if out.exists():
                out.unlink()
            raise RuntimeError(f"failed to fetch {out.name}: HTTP {e.code}") from e
        except Exception as e:
            if out.exists():
                out.unlink()
            raise RuntimeError(f"failed to fetch {out.name}: {e}") from e

    yield {"type": "done", "voice_id": voice_id}


def download_voice(voice_id: str) -> dict:
    """Backward-compatible wrapper that drains download_voice_iter."""
    for _ in download_voice_iter(voice_id):
        pass
    return fetch_catalog()[voice_id]


def remove_voice(voice_id: str) -> None:
    """Delete a voice's .onnx + .onnx.json from VOICES_DIR.

    Validates the voice ID format before touching anything so a malformed
    request can't be used to point at arbitrary paths. Evicts the in-memory
    PiperVoice cache too, so the next call to list/use this voice sees the
    files genuinely gone.

    Raises:
        ValueError if the voice ID isn't <locale>-<name>-<quality>.
        FileNotFoundError if neither file existed (idempotent for partials).
    """
    parts = voice_id.split("-")
    if len(parts) != 3:
        raise ValueError(f"invalid voice id format: {voice_id!r}")

    # Reject any voice ID component that's not safe for a filename — extra
    # belt over the catalog's split.
    for piece in parts:
        if not piece or "/" in piece or "\\" in piece or piece in (".", ".."):
            raise ValueError(f"invalid voice id segment: {piece!r}")

    removed = False
    for ext in ("onnx", "onnx.json"):
        out = VOICES_DIR / f"{voice_id}.{ext}"
        if out.exists():
            out.unlink()
            removed = True
    if not removed:
        raise FileNotFoundError(f"voice not installed: {voice_id}")

    # Drop the cached PiperVoice (if any) so a fresh re-install actually
    # reloads from disk instead of replaying the old onnxruntime session.
    from . import piper_engine  # avoid import cycle at module load
    piper_engine._cache.pop(voice_id, None)

    # The sample cache is keyed by (voice_id, speaker_id). It doesn't point
    # at any local file, just held bytes — fine to leave or drop. Drop it
    # so a future preview re-hits HF and stays consistent with "I just
    # removed this voice."
    for key in [k for k in _SAMPLE_CACHE if k.startswith(f"{voice_id}#")]:
        _SAMPLE_CACHE.pop(key, None)
