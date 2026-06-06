"""Live verification harness for Phase B spike (#811).

Drives a real clip through the production v4.18 endpoints to validate
the seam-free output audibly. Run locally; the resulting MP3 saves to
disk for you to play.

Usage:
    $env:NARRATIVE_KEY = "your-bearer"   # PowerShell
    # or: export NARRATIVE_KEY=...        # bash
    python scripts/verify_phase_b_live.py
    python scripts/verify_phase_b_live.py --voice piper:libritts_r-medium --speaker 7
    python scripts/verify_phase_b_live.py --host https://narrative-alpha.fly.dev

What it does:
    1. Mint a unique throwaway clip_id (timestamp-based) on the server.
    2. PUT a clip with lines_json populated for 3 short sentences.
    3. For each sentence, call /api/synthesize → get a per-sentence WAV.
    4. POST each WAV to the new B.2 endpoint:
       POST /api/library/clips/{id}/lines/{line_id}/audio
    5. POST /api/library/clips/{id}/restitch → server stitches FLACs,
       encodes MP3, updates clip row.
    6. GET /api/library/audio/{sha}.mp3 → save to
       ./phase_b_verify_<clip_id>.mp3 for you to play.

If the output plays start-to-finish with no audible click between
sentences, the spike is validated. Compare against splice.py path
(any partial re-narrate in v4.17 or earlier) if you want a baseline.

Cleanup: the throwaway clip stays on the server. Delete it via the
library UI (long-press → Delete) or via:
    DELETE /api/library/clips/{id}?updated_at=...
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


# Three short, distinct sentences. Hardcoded so the verification is
# reproducible and doesn't rely on a sample-text file. Tom Sawyer
# whitewash scene — public domain, matches the tutorial sample.
TEST_SENTENCES = [
    "Tom appeared on the sidewalk with a bucket of whitewash.",
    "He surveyed the fence, and all gladness left him.",
    "Thirty yards of board fence nine feet high.",
]


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def http(
    method: str,
    url: str,
    *,
    key: str,
    body: bytes | None = None,
    content_type: str | None = None,
    accept: str = "application/json",
    retries: int = 0,
) -> tuple[int, dict, bytes]:
    """Return (status, headers_lower, body_bytes). Raises on network
    error after retries are exhausted. Does NOT raise on 4xx/5xx —
    caller decides what to do.

    Set retries=N to retry on network errors (timeout, conn reset,
    incomplete read). Kokoro synth on Fly's CPU tier can be slow
    and occasionally drops a connection mid-response."""
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("X-Narrative-Key", key)
        req.add_header("Accept", accept)
        if content_type:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return (
                    resp.status,
                    {k.lower(): v for k, v in resp.getheaders()},
                    resp.read(),
                )
        except urllib.error.HTTPError as e:
            # Read body so the caller can pretty-print 4xx detail.
            body_bytes = b""
            try:
                body_bytes = e.read()
            except Exception:
                pass
            return (
                e.code,
                {k.lower(): v for k, v in e.headers.items()},
                body_bytes,
            )
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            last_exc = e
            if attempt < retries:
                print(f"[verify]   transient network error ({e!r}), "
                      f"retrying ({attempt + 1}/{retries})...")
                continue
            raise
    # Unreachable but keeps type-checker happy
    raise last_exc or RuntimeError("http: no attempts made")


def jp(data: bytes) -> dict | list | None:
    try:
        return json.loads(data)
    except Exception:
        return None


def fail(msg: str) -> "None":
    print(f"\nFAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    p = argparse.ArgumentParser(description="Phase B spike live verification")
    p.add_argument("--host", default="https://narrative-alpha.fly.dev",
                   help="server base URL")
    p.add_argument("--voice", default=None,
                   help="voice id (must be installed on the server); "
                        "auto-detected if omitted")
    p.add_argument("--speaker", type=int, default=None,
                   help="speaker_id; auto-detected if omitted (0 for single-"
                        "speaker voices, prefers 7 for multi-speaker)")
    p.add_argument("--rate", type=int, default=100, help="speech rate")
    args = p.parse_args()

    key = os.environ.get("NARRATIVE_KEY", "").strip()
    if not key:
        fail("NARRATIVE_KEY env var not set. Set it in your shell first.")

    host = args.host.rstrip("/")
    print(f"[verify] host: {host}")

    # ── 0. Quick server sanity ───────────────────────────────────────────
    status, _, _ = http("GET", f"{host}/sw.js", key=key)
    if status != 200:
        fail(f"server not reachable: GET /sw.js → {status}")
    print("[verify] server reachable")

    # ── 0b. Voice resolution ─────────────────────────────────────────────
    voice_id = args.voice
    speaker_id = args.speaker
    if voice_id is None:
        # Query the voice catalog and pick the first installed voice. The
        # /api/voices endpoint returns {voices: [{id, name, installed,
        # num_speakers, ...}, ...]}.
        status, _, b = http("GET", f"{host}/api/voices", key=key)
        if status != 200:
            fail(f"GET /api/voices → {status}: "
                 f"{b[:300].decode('utf-8', 'replace')}")
        catalog = jp(b) or {}
        voices = catalog.get("voices") or []
        # /api/voices already filters to voices the server can actually
        # use right now (tts.list_voices() returns the working set —
        # Kokoro bundled-at-build-time voices, plus any Piper voices
        # downloaded to /data). The catalog-style "installed" flag is
        # only on /api/voices/catalog, a different endpoint.
        if not voices:
            fail("no voices available on the server. "
                 "Pass --voice <id> explicitly, or install one via "
                 "Settings → Voice browser.")
        chosen = voices[0]
        voice_id = chosen.get("id") or chosen.get("voice_id")
        if speaker_id is None:
            n = chosen.get("num_speakers", 1) or 1
            # Prefer speaker 7 for LibriTTS-style multi-speaker voices
            # (matches the user's narrator pick), else fall back to 0.
            speaker_id = 7 if n > 7 else 0
        print(f"[verify] voice auto-detected: {voice_id} "
              f"({chosen.get('name', '?')}, {chosen.get('num_speakers', '?')} "
              f"speakers)")
    if speaker_id is None:
        speaker_id = 0
    print(f"[verify] voice: {voice_id} (speaker {speaker_id}, rate {args.rate})")

    # ── 1. Mint a throwaway clip id ──────────────────────────────────────
    clip_id = int(time.time() * 1000)
    line_ids = [f"c_{clip_id}-{i+1:04d}" for i in range(len(TEST_SENTENCES))]
    print(f"[verify] clip_id: {clip_id} ({len(TEST_SENTENCES)} lines)")

    # ── 2. Create the clip with lines_json populated ─────────────────────
    now = iso_now()
    lines = [
        {
            "id": lid,
            "text": text,
            "updatedAt": now,
        }
        for lid, text in zip(line_ids, TEST_SENTENCES)
    ]
    body = json.dumps({
        "id": clip_id,
        "title": f"Phase B verify {clip_id}",
        "text": " ".join(TEST_SENTENCES),
        "voiceId": voice_id,
        "speakerId": speaker_id,
        "rate": args.rate,
        "lines": lines,
        "nextLineSeq": len(TEST_SENTENCES) + 1,
        "updatedAt": now,
    }).encode("utf-8")
    status, _, b = http(
        "PUT", f"{host}/api/library/clips/{clip_id}",
        key=key, body=body, content_type="application/json",
    )
    if status not in (200, 201):
        fail(f"create clip: PUT /api/library/clips/{clip_id} → {status}  "
             f"{(b or b'')[:300].decode('utf-8', 'replace')}")
    print(f"[verify] clip created")

    # ── 3. Synthesize each sentence, upload WAV to the cache ─────────────
    for idx, (lid, text) in enumerate(zip(line_ids, TEST_SENTENCES), 1):
        print(f"[verify] [{idx}/{len(TEST_SENTENCES)}] synthesizing: {text!r}")
        synth_body = json.dumps({
            "text": text,
            "voice_id": voice_id,
            "speaker_id": speaker_id,
            "rate": args.rate,
        }).encode("utf-8")
        status, _, wav_bytes = http(
            "POST", f"{host}/api/synthesize",
            key=key, body=synth_body, content_type="application/json",
            accept="audio/wav", retries=1,
        )
        if status != 200:
            fail(f"synth sentence {idx}: {status}  "
                 f"{wav_bytes[:300].decode('utf-8', 'replace')}")
        print(f"[verify]   WAV {len(wav_bytes)} bytes")

        # Save the raw per-sentence WAV alongside the combined MP3 so
        # we can A/B against the restitched output. If a sentence WAV
        # plays cleanly in isolation but the combined MP3 has a click
        # at its boundary, the artifact is in the concat. If even the
        # raw WAV has a click at its start, the artifact is upstream
        # (synth-time padding, FLAC encode, or engine warmup).
        per_sentence_path = f"phase_b_verify_{clip_id}_sentence_{idx}.wav"
        with open(per_sentence_path, "wb") as f:
            f.write(wav_bytes)
        print(f"[verify]   saved {per_sentence_path}")

        # Upload to the new B.2 endpoint (body = raw WAV bytes).
        upload_url = (
            f"{host}/api/library/clips/{clip_id}/lines/{lid}/audio"
        )
        status, _, b = http(
            "POST", upload_url,
            key=key, body=wav_bytes, content_type="audio/wav",
        )
        if status != 200:
            fail(f"upload sentence {idx}: {status}  "
                 f"{b[:300].decode('utf-8', 'replace')}")
        resp = jp(b) or {}
        print(f"[verify]   cached sha={resp.get('sha256', '?')[:12]}... "
              f"dur={resp.get('duration_ms', '?')}ms "
              f"flac={resp.get('bytes_out', '?')}b "
              f"({resp.get('bytes_out', 0) / max(1, resp.get('bytes_in', 1)):.2f} ratio)")

    # ── 4. Restitch ──────────────────────────────────────────────────────
    print(f"[verify] calling restitch...")
    status, _, b = http(
        "POST", f"{host}/api/library/clips/{clip_id}/restitch",
        key=key, body=b"", content_type="application/json",
    )
    if status != 200:
        fail(f"restitch: {status}  {b[:500].decode('utf-8', 'replace')}")
    rs = jp(b) or {}
    sha = rs.get("audio_sha256", "")
    print(f"[verify]   combined sha={sha[:12]}... "
          f"dur={rs.get('duration_sec', '?'):.3f}s "
          f"offsets={rs.get('sentence_offsets_ms', [])} "
          f"mp3={rs.get('bytes_out', '?')}b")

    if not sha:
        fail(f"restitch returned no audio_sha256: {rs}")

    # ── 5. Download the combined MP3 ─────────────────────────────────────
    print(f"[verify] downloading combined MP3...")
    status, _, mp3_bytes = http(
        "GET", f"{host}/api/library/audio/{sha}.mp3",
        key=key, accept="audio/mpeg",
    )
    if status != 200:
        fail(f"download MP3: {status}  {mp3_bytes[:300].decode('utf-8', 'replace')}")

    out = f"phase_b_verify_{clip_id}.mp3"
    with open(out, "wb") as f:
        f.write(mp3_bytes)
    print(f"[verify] saved {out} ({len(mp3_bytes)} bytes)")

    # ── 6. Summary ───────────────────────────────────────────────────────
    print()
    print("─" * 60)
    print(f"  Phase B spike verification: COMPLETE")
    print(f"  Combined MP3: {out}")
    print(f"  Duration: {rs.get('duration_sec', '?'):.3f}s")
    print(f"  Sentence boundaries: {rs.get('sentence_offsets_ms', [])} ms")
    print(f"  Throwaway clip {clip_id} left on server — delete via UI.")
    print(f"  Play the MP3 to verify no audible seam between sentences.")
    print("─" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
