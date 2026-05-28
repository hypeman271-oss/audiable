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
            }
        )
    return voices


# Per-process cache of preview sample bytes so flipping through the voice
# browser doesn't hammer HuggingFace. Samples are small (~50-100KB each), so
# 100 entries cap RAM at ~10MB worst case before we just drop the cache.
_SAMPLE_CACHE: dict[str, bytes] = {}
_SAMPLE_CACHE_MAX = 100


def _sample_url(voice_id: str) -> str:
    parts = voice_id.split("-")
    if len(parts) != 3:
        raise ValueError(f"invalid voice id format: {voice_id!r}")
    locale, name, quality = parts
    lang = locale.split("_")[0]
    return f"{DOWNLOAD_BASE}/{lang}/{locale}/{name}/{quality}/samples/speaker_0.mp3"


def fetch_sample(voice_id: str) -> bytes:
    """Return the official Piper preview MP3 for a voice (~50-100KB).

    Raises FileNotFoundError if the voice has no published sample (some
    voices don't ship one — most do). Cached in-process.
    """
    if voice_id in _SAMPLE_CACHE:
        return _SAMPLE_CACHE[voice_id]
    url = _sample_url(voice_id)
    req = urllib.request.Request(url, headers={"User-Agent": "narrative/0.1 (+local)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise FileNotFoundError(f"no sample for {voice_id}") from e
        raise
    # Crude eviction — drop the whole cache if it's full. Lookups are
    # bursty (one click of "preview" per voice) so an LRU would be overkill.
    if len(_SAMPLE_CACHE) >= _SAMPLE_CACHE_MAX:
        _SAMPLE_CACHE.clear()
    _SAMPLE_CACHE[voice_id] = data
    return data


def download_voice(voice_id: str) -> dict:
    """Download a voice's .onnx + .onnx.json pair into VOICES_DIR.

    Idempotent — already-present files are left alone. Partial downloads
    are cleaned up on failure so a retry doesn't see a zero-byte stub
    and skip the redownload.

    Returns the catalog entry for callers that want to surface metadata.
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

    for ext in ("onnx", "onnx.json"):
        fname = f"{voice_id}.{ext}"
        out = VOICES_DIR / fname
        if out.exists() and out.stat().st_size > 0:
            continue
        url = f"{DOWNLOAD_BASE}/{lang}/{locale}/{name}/{quality}/{fname}"
        try:
            urllib.request.urlretrieve(url, out)
        except urllib.error.HTTPError as e:
            if out.exists():
                out.unlink()
            raise RuntimeError(f"failed to fetch {fname}: HTTP {e.code}") from e
        except Exception as e:
            if out.exists():
                out.unlink()
            raise RuntimeError(f"failed to fetch {fname}: {e}") from e

    return catalog[voice_id]
