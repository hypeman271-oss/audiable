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
"""

from __future__ import annotations

import io
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
