"""Narrative TTS dispatcher.

Public API:
    list_voices() -> list[Voice]
    synthesize(text, voice_id=None, rate=None, volume=None) -> SynthesisResult
    split_sentences(text) -> list[str]

Two backends are registered and merged into a single voice list:
    - piper:  neural TTS via piper-tts, voices loaded from `voices/*.onnx`
    - sapi:   OS voices via pyttsx3 (always available on Windows/macOS/Linux)

Voice IDs are namespaced by backend. Piper voice IDs are prefixed with
"piper:"; everything else is routed to SAPI (whose native IDs are already
unique — Windows registry paths, etc.).

Synthesis is sentence-by-sentence so the frontend can jump between
sentence boundaries when the user hits skip on the lock screen.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import piper_engine, sapi


@dataclass
class Voice:
    id: str
    name: str
    languages: list[str]
    gender: str | None
    engine: str  # "piper" or "sapi"
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


def split_sentences(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    parts = _SENTENCE_SPLIT.split(text)
    return [p for p in (p.strip() for p in parts) if p]


def list_voices() -> list[Voice]:
    return piper_engine.list_voices() + sapi.list_voices()


def synthesize_iter(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
    speaker_id: int | None = None,
):
    """Generator dispatching to the right engine.

    Yields per-sentence and final result events. `speaker_id` is honored
    by Piper voices with num_speakers > 1 and silently ignored by SAPI
    (which is single-voice per id).
    """
    if voice_id and voice_id.startswith("piper:"):
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
