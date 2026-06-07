"""Live verification harness for Phase B spike (#811).

Drives a real clip through v4.21 — production wiring (#811 B.2b).

The original spike used /api/synthesize per sentence, which produced a
fresh engine state per call and an audible startup transient at the
start of every cached WAV. v4.21 routes through /api/synth/jobs with
target_clip_id + target_line_ids set, so the worker caches each
sentence WAV during a single multi-sentence synthesize_iter() call.
Engine warmup is paid once (at sentence 0), then amortized across the
rest — same audio characteristics as the combined MP3 you'd hear via
the normal /api/synth/jobs flow.

Usage:
    $env:NARRATIVE_KEY = "your-bearer"   # PowerShell
    # or: export NARRATIVE_KEY=...        # bash
    python scripts/verify_phase_b_live.py
    python scripts/verify_phase_b_live.py --voice piper:libritts_r-medium --speaker 7
    python scripts/verify_phase_b_live.py --host https://narrative-alpha.fly.dev

What it does:
    1. Mint a unique throwaway clip_id (timestamp-based) on the server.
    2. PUT a clip with lines_json populated for 3 short sentences.
    3. POST /api/synth/jobs with text = sentences joined by " " AND
       target_clip_id + target_line_ids set. The worker synthesizes
       all 3 sentences in one engine pass + writes each to the cache.
    4. Poll GET /api/synth/jobs/{id} every 2s until status == done.
    5. POST /api/library/clips/{id}/restitch → server stitches the
       cached FLACs, encodes MP3, updates the clip row.
    6. GET /api/library/audio/{sha}.mp3 → save to
       ./phase_b_verify_<clip_id>.mp3 for you to play.

If the output plays start-to-finish with no audible stutter at any
sentence boundary, B.2b is validated. If a stutter persists at
sentence 1, it's an engine warmup transient that's now baked into
production audio too (in which case we'd need to pre-warm the engine
or trim the first N samples per synth job — a separate fix).

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
    timeout: int = 180,
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
            with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    p.add_argument("--poll-interval", type=float, default=2.0,
                   help="seconds between job status polls")
    p.add_argument("--poll-timeout", type=float, default=900.0,
                   help="seconds to wait for the job to finish before "
                        "giving up. Default 900s (15 min) because Fly's "
                        "CPU tier averages ~60-180s per Kokoro sentence "
                        "— 3 sentences + final MP3 encode can easily "
                        "exceed 5 minutes.")
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
    # NOTE: we join sentences with single space, which is what the
    # server's sentence splitter expects to re-split. If it splits to a
    # different count than len(line_ids), the synth_jobs worker will
    # fail the job with a clear message — better than corrupt cache.
    full_text = " ".join(TEST_SENTENCES)
    body = json.dumps({
        "id": clip_id,
        "title": f"Phase B verify {clip_id}",
        "text": full_text,
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

    # ── 3. Kick off a synth job that caches per-sentence WAVs ────────────
    print(f"[verify] starting synth job (text={len(full_text)} chars, "
          f"3 sentences expected)")
    job_body = json.dumps({
        "text": full_text,
        "voice_id": voice_id,
        "speaker_id": speaker_id,
        "rate": args.rate,
        "target_clip_id": clip_id,
        "target_line_ids": line_ids,
    }).encode("utf-8")
    status, _, b = http(
        "POST", f"{host}/api/synth/jobs",
        key=key, body=job_body, content_type="application/json",
    )
    if status not in (200, 201):
        fail(f"create job: POST /api/synth/jobs → {status}  "
             f"{(b or b'')[:300].decode('utf-8', 'replace')}")
    job = jp(b) or {}
    job_id = job.get("job_id")
    if not job_id:
        fail(f"create job: no job_id in response: {job}")
    print(f"[verify] job_id: {job_id}")

    # ── 4. Poll until done ───────────────────────────────────────────────
    print(f"[verify] polling every {args.poll_interval}s "
          f"(timeout {args.poll_timeout}s)")
    deadline = time.time() + args.poll_timeout
    last_done = -1
    while True:
        if time.time() > deadline:
            fail(f"job {job_id} did not finish within "
                 f"{args.poll_timeout}s — last seen "
                 f"sentences_done={last_done}")
        status, _, b = http(
            "GET", f"{host}/api/synth/jobs/{job_id}",
            key=key, timeout=30, retries=1,
        )
        if status != 200:
            fail(f"job status: GET /api/synth/jobs/{job_id} → {status}  "
                 f"{(b or b'')[:300].decode('utf-8', 'replace')}")
        snap = jp(b) or {}
        st = snap.get("status")
        done = snap.get("sentences_done", 0)
        total = snap.get("sentences_total", 0)
        if done != last_done:
            print(f"[verify]   {st}: {done}/{total} sentences")
            last_done = done
        if st == "done":
            print(f"[verify] job complete")
            break
        if st in ("failed", "cancelled"):
            err = snap.get("error", "(no error message)")
            fail(f"job {st}: {err}")
        time.sleep(args.poll_interval)

    # ── 5a. Download the JOB-NATIVE MP3 (production path baseline) ──────
    # The synth job stored its own combined MP3 via library_db.store_audio
    # using the in-memory _concat_wavs(wavs) → wav_to_mp3 path that the
    # production app uses. This is the A/B baseline: same input sentences,
    # different output processing chain.
    job_sha = snap.get("audio_sha256")
    if not job_sha:
        # Fetch one more snapshot in case the result event fired after our
        # last poll.
        status, _, b = http(
            "GET", f"{host}/api/synth/jobs/{job_id}",
            key=key, timeout=30,
        )
        if status == 200:
            snap2 = jp(b) or {}
            job_sha = snap2.get("audio_sha256")
    if job_sha:
        print(f"[verify] downloading job-native MP3 (production path)...")
        status, _, job_mp3 = http(
            "GET", f"{host}/api/library/audio/{job_sha}.mp3",
            key=key, accept="audio/mpeg",
        )
        if status != 200:
            print(f"[verify]   warn: job MP3 download failed ({status})")
            job_mp3 = b""
        else:
            job_out = f"phase_b_verify_{clip_id}_jobnative.mp3"
            with open(job_out, "wb") as f:
                f.write(job_mp3)
            print(f"[verify]   saved {job_out} ({len(job_mp3)} bytes)")
    else:
        print(f"[verify]   warn: job has no audio_sha256, skipping A/B baseline")
        job_mp3 = b""

    # ── 5b. Restitch (cache → FLAC decode → concat → MP3) ───────────────
    print(f"[verify] calling restitch (Phase B cache path)...")
    status, _, b = http(
        "POST", f"{host}/api/library/clips/{clip_id}/restitch",
        key=key, body=b"", content_type="application/json",
    )
    if status != 200:
        fail(f"restitch: {status}  {b[:500].decode('utf-8', 'replace')}")
    rs = jp(b) or {}
    sha = rs.get("audio_sha256", "")
    dur = rs.get("duration_sec", 0)
    print(f"[verify]   combined sha={sha[:12]}... "
          f"dur={dur:.3f}s "
          f"offsets={rs.get('sentence_offsets_ms', [])} "
          f"mp3={rs.get('bytes_out', '?')}b")

    if not sha:
        fail(f"restitch returned no audio_sha256: {rs}")

    # ── 6. Download the restitched MP3 ───────────────────────────────────
    print(f"[verify] downloading restitched MP3...")
    status, _, mp3_bytes = http(
        "GET", f"{host}/api/library/audio/{sha}.mp3",
        key=key, accept="audio/mpeg",
    )
    if status != 200:
        fail(f"download MP3: {status}  {mp3_bytes[:300].decode('utf-8', 'replace')}")

    out = f"phase_b_verify_{clip_id}_restitched.mp3"
    with open(out, "wb") as f:
        f.write(mp3_bytes)
    print(f"[verify] saved {out} ({len(mp3_bytes)} bytes)")

    # ── 7. Summary ───────────────────────────────────────────────────────
    print()
    print("-" * 60)
    print(f"  Phase B spike verification (B.2b): COMPLETE")
    print(f"  Throwaway clip {clip_id} left on server.")
    print(f"  ")
    print(f"  A/B FILES TO COMPARE (same synth input, different output chain):")
    if job_mp3:
        print(f"   1) phase_b_verify_{clip_id}_jobnative.mp3")
        print(f"      Engine -> in-memory PCM concat -> MP3 encode")
        print(f"      Same path the production Generate button uses.")
    print(f"   2) phase_b_verify_{clip_id}_restitched.mp3")
    print(f"      Engine -> per-sentence WAV -> FLAC encode -> store ->")
    print(f"      FLAC decode -> concat filter -> MP3 encode (Phase B cache).")
    print(f"  ")
    print(f"  Play both. Report which one stutters:")
    print(f"   - Only restitched stutters -> FLAC round-trip is the bug.")
    print(f"     Fix: store raw WAV bytes instead of FLAC.")
    print(f"   - Both stutter equally    -> bug is in engine output itself.")
    print(f"     Different fix entirely (engine boundary handling).")
    print(f"   - Both clean               -> spike done, B.2b validated.")
    print("-" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
