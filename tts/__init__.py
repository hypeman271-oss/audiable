"""Narrative TTS dispatcher.

Public API:
    list_voices() -> list[Voice]
    synthesize(text, voice_id=None, rate=None, volume=None) -> SynthesisResult
    split_sentences(text) -> list[str]

Three backends are registered and merged into a single voice list:
    - kokoro: Apache 2.0 neural TTS via kokoro-onnx, all 54 voices bundled
              (we surface the en-US + en-GB subset for V1). Bundle lives at
              voices/kokoro/{kokoro-v1.0.int8.onnx, voices-v1.0.bin}.
    - piper:  neural TTS via piper-tts, voices loaded from `voices/*.onnx`
    - sapi:   OS voices via pyttsx3 (always available on Windows/macOS/Linux)

Voice IDs are namespaced by backend. Kokoro IDs are prefixed "kokoro:";
Piper IDs are prefixed "piper:"; everything else is routed to SAPI (whose
native IDs are already unique — Windows registry paths, etc.).

Synthesis is sentence-by-sentence so the frontend can jump between
sentence boundaries when the user hits skip on the lock screen.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import kokoro_engine, piper_engine, sapi


@dataclass
class Voice:
    id: str
    name: str
    languages: list[str]
    gender: str | None
    engine: str  # "kokoro", "piper", or "sapi"
    # Number of distinct speakers baked into the model. 1 for SAPI voices
    # and most Piper voices; LibriTTS/high is 904. The frontend shows a
    # speaker picker only when this is > 1.
    num_speakers: int = 1


@dataclass
class SynthesisResult:
    wav: bytes
    # Start time of each sentence within the audio, in milliseconds.
    # Always begins with 0; len(sentence_offsets_ms) == number of sentences.
    sentence_offsets_ms: list[int] = field(default_factory=list)


# Single sentence splitter used by both engines AND mirrored in the frontend
# (static/app.js makeSentences). Keep the regex in sync across both sides —
# the frontend pairs each offset with the matching sentence text by re-running
# this split on the original input.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# v225.tn34 (#510): max chars per "sentence" that we'll hand to Piper.
# Above ~500 chars the espeak phonemizer starts running out of memory or
# silently produces zero-frame WAVs (a real tester hit this with a Trump
# speech transcript that had 2 periods in 2,911 words — the splitter saw
# the whole 15k-char text as a single "sentence" and Piper bailed mid-way,
# leaving a 3-second clip marked OK by the bg-queue). We force-split any
# overlong run at the nearest comma boundary, then whitespace, then a
# hard char cap. The output is still a valid sentence list to the engines.
_MAX_SENTENCE_CHARS = 500
# Punctuation boundaries we'll happily split at, in priority order. Comma
# first because it gives the most natural breath; semicolon/colon are
# good fallback breaks; em/en dashes work for verbal pause beats.
_SECONDARY_SPLIT = re.compile(r"(?<=[,;:—–])\s+")


def _force_split_long(sentence: str, max_chars: int = _MAX_SENTENCE_CHARS) -> list[str]:
    """Break an overlong "sentence" into Piper-digestible chunks.

    Strategy: split at commas/semicolons/colons/dashes if any exist.
    If the resulting pieces are still too long, split at whitespace.
    If a single token is still over the cap (rare — long URLs, etc.)
    hard-cut at the char boundary. We never drop content; the joined
    output equals the input minus the consumed separators.
    """
    if len(sentence) <= max_chars:
        return [sentence]
    pieces: list[str] = []
    # First pass: split on secondary punctuation. This handles "list,
    # of, items, separated, by, commas" cleanly.
    for chunk in _SECONDARY_SPLIT.split(sentence):
        chunk = chunk.strip()
        if not chunk:
            continue
        if len(chunk) <= max_chars:
            pieces.append(chunk)
            continue
        # Still too long → split at whitespace, packing words greedily
        # into <=max_chars groups.
        words = chunk.split()
        cur = ""
        for w in words:
            sep = " " if cur else ""
            if len(cur) + len(sep) + len(w) > max_chars:
                if cur:
                    pieces.append(cur)
                cur = w
            else:
                cur += sep + w
        if cur:
            # A single token longer than the cap (very rare). Hard-cut
            # so we never hand the engine an oversize input — the
            # audio will have a tiny seam in the middle of the token
            # but at least it'll synthesize.
            if len(cur) > max_chars:
                for i in range(0, len(cur), max_chars):
                    pieces.append(cur[i:i + max_chars])
            else:
                pieces.append(cur)
    return pieces or [sentence[:max_chars]]


def split_sentences(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    parts = _SENTENCE_SPLIT.split(text)
    # v225.tn34: force-split any sentence over the per-sentence cap.
    # This bulletproofs transcript-style inputs that have few or no
    # sentence-ending marks. Order is preserved; only oversized
    # entries get expanded into multiple chunks.
    out: list[str] = []
    for raw in parts:
        s = raw.strip()
        if not s:
            continue
        if len(s) <= _MAX_SENTENCE_CHARS:
            out.append(s)
        else:
            out.extend(_force_split_long(s))
    return out


def list_voices() -> list[Voice]:
    # Kokoro first so its higher-quality voices float to the top of the
    # picker by default. Piper voices follow (legacy + LibriTTS). SAPI
    # last (OS fallback).
    return (
        kokoro_engine.list_voices()
        + piper_engine.list_voices()
        + sapi.list_voices()
    )


def synthesize_iter(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
):
    """Generator dispatching to the right engine.

    Yields per-sentence and final result events. `speaker_id` is honored
    by Piper voices with num_speakers > 1 and silently ignored by Kokoro
    (single-speaker per voice) and SAPI (single-voice per id).
    """
    if voice_id and voice_id.startswith("kokoro:"):
        yield from kokoro_engine.synthesize_iter(
            text, voice_id, rate=rate, volume=volume, speaker_id=speaker_id
        )
    elif voice_id and voice_id.startswith("piper:"):
        yield from piper_engine.synthesize_iter(
            text, voice_id, rate=rate, volume=volume, speaker_id=speaker_id
        )
    else:
        yield from sapi.synthesize_iter(text, voice_id, rate=rate, volume=volume)


def synthesize(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
) -> SynthesisResult:
    import base64

    for event in synthesize_iter(
        text, voice_id=voice_id, rate=rate, volume=volume, speaker_id=speaker_id
    ):
        if event["type"] == "result":
            return SynthesisResult(
                wav=base64.b64decode(event["wav_b64"]),
                sentence_offsets_ms=event["sentence_offsets_ms"],
            )
    raise RuntimeError("synthesis produced no result")


def synthesize_segments_iter(segments, rate=None, volume=None):
    """Generator: synthesize a sequence of text segments, each with its own
    voice/speaker, and yield a single combined stream of events.

    Used by character-voice mode: a writer pastes a chapter, the frontend
    splits it into [{voice_id, speaker_id, text}, ...] segments by attributed
    dialogue, and we render each segment with the assigned voice. To the
    frontend it looks like one normal synthesize stream (with the bonus
    "segment_idx" field so the UI can show which voice is currently speaking).

    Event shape:
      {"type": "sentence", "index": N, "total": M, "offset_ms": ms,
       "wav_b64": "...", "segment_idx": i, "voice_id": "...",
       "speaker_id": int|null}
      {"type": "result", "wav_b64": "...full combined WAV b64...",
       "sentence_offsets_ms": [list of global offsets across all segments]}
    """
    import base64
    import io
    import wave

    # Count total sentences across all non-empty segments so each sentence
    # event can report a correct total upfront (matches the single-voice
    # streaming UI's progress bar behavior).
    total_sentences = 0
    for seg in segments:
        total_sentences += len(split_sentences(seg.get("text") or ""))

    all_offsets_ms: list[int] = []
    segment_wavs: list[bytes] = []
    sentence_count = 0
    cumulative_ms = 0

    for seg_idx, segment in enumerate(segments):
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        voice_id = segment.get("voice_id")
        speaker_id = segment.get("speaker_id")

        for ev in synthesize_iter(
            text=text,
            voice_id=voice_id,
            rate=rate,
            volume=volume,
            speaker_id=speaker_id,
        ):
            if ev["type"] == "sentence":
                global_offset = cumulative_ms + int(ev.get("offset_ms") or 0)
                all_offsets_ms.append(global_offset)
                yield {
                    "type": "sentence",
                    "index": sentence_count,
                    "total": total_sentences,
                    "offset_ms": global_offset,
                    "wav_b64": ev["wav_b64"],
                    "segment_idx": seg_idx,
                    "voice_id": voice_id,
                    "speaker_id": speaker_id,
                }
                sentence_count += 1
            elif ev["type"] == "result":
                # End of this segment — capture its full WAV and advance
                # cumulative_ms by its true duration so the next segment's
                # offsets line up against the eventual combined audio.
                seg_wav = base64.b64decode(ev["wav_b64"])
                segment_wavs.append(seg_wav)
                with wave.open(io.BytesIO(seg_wav), "rb") as r:
                    seg_ms = int(r.getnframes() * 1000 / r.getframerate())
                cumulative_ms += seg_ms

    combined = _concat_wavs_bytes(segment_wavs)
    yield {
        "type": "result",
        "wav_b64": base64.b64encode(combined).decode(),
        "sentence_offsets_ms": all_offsets_ms,
    }


def _concat_wavs_bytes(wav_blobs):
    """Concatenate WAV bytes that share the same format. Works for the
    mixed-voice output as long as the underlying engines produce
    same-rate / same-bit-depth WAVs (Piper voices typically are, modulo
    different sample rates per model — if rates differ we'd need to
    resample. For v1 we assume same-rate; cross-rate mixing fails loudly
    via the wave module rather than silently producing broken audio)."""
    import io
    import wave

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
                    if w.getframerate() != params.framerate:
                        raise ValueError(
                            f"sample-rate mismatch: {w.getframerate()} vs "
                            f"{params.framerate} — mixed character voices "
                            "must use models with matching sample rates"
                        )
                    out.writeframes(w.readframes(w.getnframes()))
    return out_buf.getvalue()
