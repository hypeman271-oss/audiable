"""Re-stitch a combined MP3 from per-sentence FLAC files (Phase B / #811).

Given an ordered list of per-sentence FLAC paths (Phase B's sentence
cache), produce a combined MP3 + a sentence-offset table the player
uses for seek math.

Why this exists. Phase B replaces the `tts/splice.py` PCM-domain
atrim+concat (which leaves a faint crossfade artifact at the cut
point) with a clean concat from cached per-sentence FLACs. No cut
seam because there's no cut — the boundaries are the original
boundaries from the synth pass that produced each FLAC.

Two passes:

  1. Measure each FLAC's duration_ms via `ffprobe`. Cheap header
     read; doesn't decode the audio. Used to build the offset table
     without decoding twice.

  2. ffmpeg's `concat` demuxer reads a text-file playlist and emits a
     single audio stream, which we encode to MP3 at the same 64 kbps
     the rest of the codebase uses (`splice.py`, `encode.py`). Same
     bitrate matters — a spliced clip and a fresh-re-narrate clip
     should not sound different.

We shell out to ffmpeg/ffprobe rather than pulling pydub/pyav into
deps — the binaries are already in the Docker image (faster-whisper +
splice.py both rely on them), and the filter graph is short enough
that a subprocess call is cheaper than libavcodec bindings.

Public API:

    restitch_clip(flac_paths, *, bitrate_kbps=64)
        -> (mp3_bytes, sentence_offsets_ms)

    durations_ms(flac_paths) -> list[int]
        (exposed for debugging + the endpoint's response payload)
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


class RestitchError(RuntimeError):
    """Raised when ffmpeg/ffprobe fails or inputs are inconsistent."""


def _ffprobe_duration_ms(path: Path) -> int:
    """Return duration in milliseconds via ffprobe header read.

    ffprobe reports duration as a float seconds string. We round to
    ms — the offset table is int-ms and the player's seek math
    assumes that precision. Fractional-ms rounding errors accumulate
    across long clips but the audible drift over even a novel-length
    clip is below the seek granularity, so we ignore it.
    """
    # Ask for both format-level and stream-level duration. FLACs
    # encoded from stdin sometimes have empty format.duration (the
    # container doesn't write it), but stream-level duration is set
    # by libavcodec's FLAC encoder regardless. Read whichever is
    # populated, prefer format because it's authoritative.
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration:stream=duration",
        "-of", "json",
        str(path),
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, timeout=10, check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise RestitchError(f"ffprobe timeout on {path}: {e}") from e
    if result.returncode != 0:
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        raise RestitchError(
            f"ffprobe failed on {path} ({result.returncode}): "
            f"{stderr.strip()[:300]}"
        )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RestitchError(
            f"ffprobe output unparseable for {path}: {e}"
        ) from e
    dur_raw = None
    fmt = data.get("format") or {}
    if fmt.get("duration") not in (None, "", "N/A"):
        dur_raw = fmt["duration"]
    else:
        for s in data.get("streams") or []:
            if s.get("duration") not in (None, "", "N/A"):
                dur_raw = s["duration"]
                break
    if dur_raw is None:
        raise RestitchError(
            f"ffprobe found no duration for {path}: {data!r}"
        )
    try:
        dur_s = float(dur_raw)
    except (TypeError, ValueError) as e:
        raise RestitchError(
            f"ffprobe duration not a number for {path}: {dur_raw!r}"
        ) from e
    if dur_s < 0:
        raise RestitchError(f"ffprobe reported negative duration for {path}")
    return int(round(dur_s * 1000))


def durations_ms(flac_paths: list[Path]) -> list[int]:
    """Probe each FLAC for its duration in ms. Order-preserving.

    Exposed so the endpoint can return the offset table without
    re-running concat just to inspect it.
    """
    return [_ffprobe_duration_ms(p) for p in flac_paths]


def restitch_clip(
    items: list[tuple[Path, int]],
    *,
    bitrate_kbps: int = 64,
) -> tuple[bytes, list[int]]:
    """Concat FLACs in order, encode to MP3, return (bytes, offsets_ms).

    Args:
        items: ordered list of (flac_path, duration_ms) tuples. Reading
            order matches output order. Caller is responsible for
            ordering by `lines_json` (line_id appearance order). The
            durations come from the sentence_audio row written when
            each sentence was uploaded — that is the source of truth
            because pipe-encoded FLAC doesn't always carry a
            container-level duration we can probe.
        bitrate_kbps: MP3 output bitrate. 64 matches the rest of the
            codebase; changing it would make spliced and re-narrated
            clips sound subtly different.

    Returns:
        (mp3_bytes, offsets_ms) where offsets_ms[i] is the start time
        of sentence i in the combined MP3. offsets_ms[0] is always 0.
        len(offsets_ms) == len(items).

    Raises:
        RestitchError on:
          - Empty input list
          - Any FLAC path missing on disk
          - ffmpeg concat failure
    """
    if not items:
        raise RestitchError("items is empty")
    flac_paths = [p for p, _ in items]
    for p in flac_paths:
        if not p.exists():
            raise RestitchError(f"FLAC not found: {p}")

    # Pass 1: build offset table from passed-in durations. We trust
    # the caller's durations because they were recorded at write time
    # from the source WAV header — no ffprobe round trip needed.
    durs = [int(d) for _, d in items]
    if any(d < 0 for d in durs):
        raise RestitchError(f"negative duration in items: {durs}")
    offsets = [0]
    running = 0
    for d in durs[:-1]:
        running += d
        offsets.append(running)

    # Pass 2: concat via ffmpeg.
    with tempfile.TemporaryDirectory(prefix="narrative-restitch-") as tmpdir:
        tmp = Path(tmpdir)
        # The concat demuxer needs a text file listing each input.
        # Format: lines of `file 'path'` (path single-quoted, with
        # internal single quotes escaped). We write absolute resolved
        # paths to avoid ambiguity if ffmpeg's CWD differs from ours.
        listing = tmp / "list.txt"
        with listing.open("w", encoding="utf-8") as f:
            for p in flac_paths:
                # Defensive escape of single quotes — unlikely in
                # sha256-derived filenames but cheap insurance.
                quoted = str(p.resolve()).replace("'", r"'\''")
                f.write(f"file '{quoted}'\n")

        out_mp3 = tmp / "out.mp3"
        # v4.19 (#811): do NOT force `-ar 22050` here. Kokoro emits at
        # 24kHz; Piper voices vary (LibriTTS at 22.05k, some at 16k).
        # When inputs aren't already at 22050, ffmpeg's resampler runs
        # over the concat pipeline and produces a startup transient at
        # each input-file boundary — audible as a brief click at the
        # start of each sentence. Splice.py doesn't have this problem
        # because it operates on the combined MP3 directly (single SR
        # already), not on per-sentence files. Let ffmpeg pick the
        # natural rate from the inputs; all sentences in a clip share
        # one voice today, so the FLACs are uniform.
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-f", "concat",
            "-safe", "0",       # allow absolute paths in the listing
            "-i", str(listing),
            "-c:a", "libmp3lame",
            "-b:a", f"{bitrate_kbps}k",
            "-ac", "1",
            str(out_mp3),
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, timeout=600, check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise RestitchError(f"ffmpeg concat timeout: {e}") from e
        if result.returncode != 0:
            stderr = (result.stderr or b"").decode("utf-8", errors="replace")
            raise RestitchError(
                f"ffmpeg concat failed ({result.returncode}): "
                f"{stderr.strip()[:500]}"
            )
        if not out_mp3.exists():
            raise RestitchError("ffmpeg produced no output")
        mp3_bytes = out_mp3.read_bytes()

    print(
        f"[restitch] {len(flac_paths)} sentences "
        f"-> {len(mp3_bytes)} bytes "
        f"(total dur {sum(durs)}ms)",
        file=sys.stderr, flush=True,
    )

    return mp3_bytes, offsets
