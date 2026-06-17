"""WAV → MP3 transcoder for the result event of /api/synthesize/stream.

Speech is incredibly compressible — a 1-hour Piper render at 22050 Hz mono
16-bit is ~159 MB raw, and lameenc trims it down to ~28 MB at 64 kbps with
no audible loss. The per-sentence streaming chunks stay as WAV so the
browser can play them with zero decoding latency; this module only kicks
in once for the final combined audio.

We hide the lameenc dependency behind a thin wrapper so the rest of the
codebase doesn't have to think about it, and so we get a clean error
message if the wheel ever fails to install (instead of an ImportError
buried mid-request).

Also: wav_to_flac for Phase B (#811). FLAC is lossless and ~50% the size
of raw PCM — the right format for the per-sentence cache that backs
partial re-narrate. We use ffmpeg (already in the image for splice +
faster-whisper) rather than pulling in a pure-Python FLAC encoder.
"""

from __future__ import annotations

import io
import subprocess
import wave


def wav_to_mp3(wav_bytes: bytes, bitrate_kbps: int = 64) -> bytes:
    """Encode a WAV blob (16-bit PCM) to MP3 bytes.

    Args:
        wav_bytes: a complete WAV file. Must be 16-bit PCM; sample rate and
            channel count are picked up from the header.
        bitrate_kbps: target MP3 bitrate. 64 kbps is more than enough for
            spoken word; 48 saves another ~25% with very slight sibilant
            artifacts.

    Returns:
        MP3 bytes, ready to drop straight into a Blob or save to disk.
    """
    # Imported lazily so the rest of the app keeps working even if the
    # wheel didn't install on a given platform (you'd just lose MP3 export).
    import lameenc

    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        sample_rate = r.getframerate()
        channels = r.getnchannels()
        sample_width = r.getsampwidth()
        pcm = r.readframes(r.getnframes())

    if sample_width != 2:
        raise ValueError(
            f"wav_to_mp3 only supports 16-bit PCM input (got {sample_width * 8}-bit)"
        )

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate_kbps)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(channels)
    # 0 = best quality (slowest), 9 = worst (fastest). 2 is the LAME-recommended
    # high-quality preset and stays well under realtime for typical clip lengths.
    encoder.set_quality(2)
    # Suppress LAME's stderr "info bitrate" output — we already know.
    encoder.silence()

    mp3 = encoder.encode(pcm)
    mp3 += encoder.flush()
    return bytes(mp3)


class FlacEncodeError(RuntimeError):
    """Raised when the ffmpeg FLAC encode fails."""


def wav_to_flac(wav_bytes: bytes, *, compression_level: int = 5) -> bytes:
    """Encode a WAV blob to FLAC bytes via ffmpeg.

    Lossless — the FLAC output decodes back to the same PCM samples as
    the input WAV. Typical size reduction for 22kHz mono 16-bit speech
    is 40-55%.

    Args:
        wav_bytes: a complete WAV file. Sample rate and channel count
            are preserved by ffmpeg's `-c:a flac` (no resampling).
        compression_level: 0-12. 5 is ffmpeg's default and a good
            speed/size balance for speech. 8 squeezes another ~5% out
            but doubles encode time. 12 (max) is rarely worth it.

    Returns:
        FLAC bytes, ready to write to disk or store in a content-
        addressed blob path.

    Raises:
        FlacEncodeError if ffmpeg fails or produces no output.
    """
    if not wav_bytes:
        raise FlacEncodeError("wav_bytes is empty")

    # ffmpeg can read WAV from stdin and write FLAC to stdout, no temp
    # files needed. The `-i pipe:0` + `-f flac pipe:1` pattern is
    # well-supported. -hide_banner / -loglevel error keep stderr quiet
    # so a non-zero exit is the only signal of failure.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "wav",
        "-i", "pipe:0",
        "-c:a", "flac",
        "-compression_level", str(int(compression_level)),
        "-f", "flac",
        "pipe:1",
    ]
    try:
        result = subprocess.run(
            cmd, input=wav_bytes, capture_output=True, timeout=60, check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise FlacEncodeError(f"ffmpeg timeout: {e}") from e
    if result.returncode != 0:
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        raise FlacEncodeError(
            f"ffmpeg failed ({result.returncode}): {stderr.strip()[:500]}"
        )
    if not result.stdout:
        raise FlacEncodeError("ffmpeg produced no output")
    return result.stdout


def flac_to_wav(flac_bytes: bytes) -> bytes:
    """Decode FLAC bytes back to a 16-bit PCM WAV via ffmpeg.

    The inverse of wav_to_flac — used by the resume path (v4.111) to turn
    cached per-sentence FLAC blobs back into the WAVs the stitcher
    concatenates. Lossless round-trip: FLAC → the same PCM samples.

    Raises FlacEncodeError on ffmpeg failure / empty output.
    """
    if not flac_bytes:
        raise FlacEncodeError("flac_bytes is empty")
    # ffmpeg writing WAV to a non-seekable pipe can't backfill the RIFF
    # data-chunk size / frame count in the header, leaving a bogus
    # getnframes() (huge duration, broken concat). A real (seekable) temp
    # output file lets ffmpeg finalize the header correctly. Input still
    # streams via stdin.
    import os
    import tempfile

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = tmp.name
    tmp.close()
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "flac",
        "-i", "pipe:0",
        "-c:a", "pcm_s16le",  # 16-bit PCM, matches the synth WAVs
        "-f", "wav",
        tmp_path,
    ]
    try:
        result = subprocess.run(
            cmd, input=flac_bytes, capture_output=True, timeout=60, check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or b"").decode("utf-8", errors="replace")
            raise FlacEncodeError(
                f"ffmpeg flac→wav failed ({result.returncode}): {stderr.strip()[:500]}"
            )
        wav_bytes = b""
        try:
            with open(tmp_path, "rb") as f:
                wav_bytes = f.read()
        except OSError as e:
            raise FlacEncodeError(f"could not read ffmpeg output: {e}") from e
        if not wav_bytes:
            raise FlacEncodeError("ffmpeg produced no output")
        return wav_bytes
    except subprocess.TimeoutExpired as e:
        raise FlacEncodeError(f"ffmpeg timeout: {e}") from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def concat_wavs(wav_blobs: list[bytes]) -> bytes:
    """Concatenate WAV byte blobs that share the same PCM format.

    Mirrors piper_engine._concat_wavs but lives here so the resume
    stitcher (synth_jobs) can build a combined WAV from cached + freshly
    synthesized per-sentence WAVs without importing engine internals.
    The per-sentence WAVs already carry their trailing-silence pad, so
    concatenating them reproduces exactly what a single synth pass emits
    as its combined result.
    """
    if not wav_blobs:
        return b""
    if len(wav_blobs) == 1:
        return wav_blobs[0]
    out_buf = io.BytesIO()
    with wave.open(io.BytesIO(wav_blobs[0]), "rb") as first:
        params = first.getparams()
        with wave.open(out_buf, "wb") as out:
            out.setparams(params)
            out.writeframes(first.readframes(first.getnframes()))
            for blob in wav_blobs[1:]:
                with wave.open(io.BytesIO(blob), "rb") as w:
                    out.writeframes(w.readframes(w.getnframes()))
    return out_buf.getvalue()


def wav_duration_ms(wav_bytes: bytes) -> int:
    """Return WAV duration in milliseconds. Cheap — header read only.

    Phase B uses this at synth time (we have the WAV in hand before
    encoding to FLAC) so the duration_ms column on sentence_audio can
    be populated without re-opening the FLAC after write.
    """
    if not wav_bytes:
        raise ValueError("wav_bytes is empty")
    with wave.open(io.BytesIO(wav_bytes), "rb") as r:
        frames = r.getnframes()
        rate = r.getframerate()
    if rate <= 0:
        raise ValueError(f"WAV has invalid sample rate: {rate}")
    return int(round(frames * 1000 / rate))
