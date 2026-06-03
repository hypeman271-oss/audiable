"""PCM-domain MP3 splice for inline single-sentence edit (v592).

Given an existing rendered MP3, a sentence-offset table, an index, and a
freshly-synthesized replacement sentence (WAV), produce a new MP3 with
the old sentence's PCM range swapped for the new sentence's PCM. The
offset table is shifted past the edit point so player seeks still map
to sentence boundaries.

Why this exists. Phase 1 of the inline-edit feature targets a fast,
"close enough" answer for typo fixes and one-word swaps. Re-narrating
the whole clip would burn 30-90s on the Fly CPU tier; splicing a single
sentence is bounded by (new-sentence synth time + one ffmpeg pass) —
~1-3 seconds for a typical sentence. The seam can introduce a faint
crossfade artifact at the cut points, which we accept for now; Option B
(per-sentence WAV storage) eliminates the seam entirely but requires a
schema migration, so it ships later (#586).

We shell out to ffmpeg rather than pulling pydub/pyav into the deps
list: the binary is already present in the Docker image (faster-whisper
needs it for webm/opus decode of voice-note audio), and the filter
graph below is short enough that a subprocess call is cheaper than
binding to libavcodec.

Public API:
    splice_sentence(mp3_bytes, sentence_offsets_ms, index,
                    new_sentence_wav_bytes, *, bitrate_kbps=64)
        -> (new_mp3_bytes, new_sentence_offsets_ms)
"""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


class SpliceError(RuntimeError):
    """Raised when ffmpeg fails or inputs are inconsistent."""


def _wav_duration_ms(wav_bytes: bytes) -> int:
    """Return WAV duration in milliseconds. Assumes 16-bit PCM."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        frames = r.getnframes()
        rate = r.getframerate()
    if rate <= 0:
        raise SpliceError("synthesized WAV has invalid sample rate")
    # Round to nearest ms — fractional offsets break the seek math.
    return int(round(frames * 1000 / rate))


def splice_sentence(
    mp3_bytes: bytes,
    sentence_offsets_ms: list[int],
    index: int,
    new_sentence_wav_bytes: bytes,
    *,
    bitrate_kbps: int = 64,
) -> tuple[bytes, list[int]]:
    """Replace sentence `index` in `mp3_bytes` with `new_sentence_wav_bytes`.

    Args:
        mp3_bytes: the existing combined-clip MP3.
        sentence_offsets_ms: start time of each sentence within mp3_bytes
            (always starts with 0; len == sentence count).
        index: which sentence to replace (0-based).
        new_sentence_wav_bytes: freshly-synthesized replacement sentence,
            16-bit PCM WAV. The voice / speaker_id / rate should match the
            original synth so the seam is as transparent as possible.
        bitrate_kbps: MP3 bitrate for the re-encode. 64 kbps matches
            tts.encode.wav_to_mp3 — keep them in lockstep so a spliced
            clip isn't audibly different from a fresh re-narrate.

    Returns:
        (new_mp3_bytes, new_sentence_offsets_ms)

    Raises:
        SpliceError on bad input or ffmpeg failure.
    """
    n = len(sentence_offsets_ms)
    if n == 0:
        raise SpliceError("sentence_offsets_ms is empty")
    if index < 0 or index >= n:
        raise SpliceError(f"index {index} out of range [0, {n})")
    if not mp3_bytes:
        raise SpliceError("mp3_bytes is empty")
    if not new_sentence_wav_bytes:
        raise SpliceError("new_sentence_wav_bytes is empty")

    start_ms = sentence_offsets_ms[index]
    end_ms = sentence_offsets_ms[index + 1] if index + 1 < n else None

    new_dur_ms = _wav_duration_ms(new_sentence_wav_bytes)
    old_dur_ms = (end_ms - start_ms) if end_ms is not None else None

    # Build the filter graph. ffmpeg's `atrim=start=S:end=E` uses seconds;
    # convert ms with fractional precision so we don't lose a frame at
    # short sentences.
    start_s = start_ms / 1000.0

    # Three cases:
    #   1. index == 0           — no head, just [new][tail] (or just [new] if also last)
    #   2. index == n - 1       — no tail, just [head][new]
    #   3. middle               — [head][new][tail]
    is_first = index == 0
    is_last = end_ms is None
    parts: list[str] = []
    inputs: list[str] = []

    head_label = ""
    tail_label = ""
    if not is_first:
        parts.append(f"[0:a]atrim=0:{start_s:.6f},asetpts=PTS-STARTPTS[head]")
        head_label = "[head]"
    if not is_last:
        end_s = end_ms / 1000.0  # type: ignore[operator]
        parts.append(f"[0:a]atrim={end_s:.6f},asetpts=PTS-STARTPTS[tail]")
        tail_label = "[tail]"

    # New sentence is always input #1.
    concat_inputs = f"{head_label}[1:a]{tail_label}"
    n_concat = (1 if head_label else 0) + 1 + (1 if tail_label else 0)
    parts.append(f"{concat_inputs}concat=n={n_concat}:v=0:a=1[out]")
    filtergraph = ";".join(parts)

    # Write inputs to disk. ffmpeg can't accept multiple piped inputs at once
    # (only one can be stdin), and the original MP3 may be large enough that
    # the round-trip-through-memory cost dwarfs disk I/O.
    with tempfile.TemporaryDirectory(prefix="narrative-splice-") as tmpdir:
        tmp = Path(tmpdir)
        in_mp3 = tmp / "in.mp3"
        in_wav = tmp / "new.wav"
        out_mp3 = tmp / "out.mp3"
        in_mp3.write_bytes(mp3_bytes)
        in_wav.write_bytes(new_sentence_wav_bytes)

        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-y",                       # overwrite
            "-i", str(in_mp3),          # input 0
            "-i", str(in_wav),          # input 1
            "-filter_complex", filtergraph,
            "-map", "[out]",
            "-c:a", "libmp3lame",
            "-b:a", f"{bitrate_kbps}k",
            "-ar", "22050",
            "-ac", "1",
            str(out_mp3),
        ]
        try:
            result = subprocess.run(
                cmd, capture_output=True, timeout=60, check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise SpliceError(f"ffmpeg timeout: {e}") from e
        if result.returncode != 0:
            stderr = (result.stderr or b"").decode("utf-8", errors="replace")
            raise SpliceError(f"ffmpeg failed ({result.returncode}): {stderr.strip()[:500]}")
        if not out_mp3.exists():
            raise SpliceError("ffmpeg produced no output")
        new_mp3_bytes = out_mp3.read_bytes()

    # Build new offset table. Sentences before `index` are unchanged;
    # sentence `index` itself stays at the same start; sentences after
    # `index` shift by (new_dur - old_dur). For the last-sentence case
    # there are no following offsets so the shift is moot.
    new_offsets = list(sentence_offsets_ms)
    if not is_last:
        delta = new_dur_ms - old_dur_ms  # type: ignore[operator]
        for i in range(index + 1, n):
            new_offsets[i] = max(0, new_offsets[i] + delta)

    print(
        f"[splice] index={index}/{n} "
        f"start_ms={start_ms} old_dur={old_dur_ms} new_dur={new_dur_ms} "
        f"mp3_in={len(mp3_bytes)} mp3_out={len(new_mp3_bytes)}",
        file=sys.stderr, flush=True,
    )

    return new_mp3_bytes, new_offsets
