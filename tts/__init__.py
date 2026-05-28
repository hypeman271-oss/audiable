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
):
    """Generator dispatching to the right engine.

    Yields {"type":"progress","done":N,"total":M} for each sentence,
    then {"type":"result","wav_b64":str,"sentence_offsets_ms":list[int]}.
    """
    if voice_id and voice_id.startswith("piper:"):
        yield from piper_engine.synthesize_iter(text, voice_id, rate=rate, volume=volume)
    else:
        yield from sapi.synthesize_iter(text, voice_id, rate=rate, volume=volume)


def synthesize(
    text: str,
    voice_id: str | None = None,
    rate: int | None = None,
    volume: float | None = None,
) -> SynthesisResult:
    import base64

    for event in synthesize_iter(text, voice_id=voice_id, rate=rate, volume=volume):
        if event["type"] == "result":
            return SynthesisResult(
                wav=base64.b64decode(event["wav_b64"]),
                sentence_offsets_ms=event["sentence_offsets_ms"],
            )
    raise RuntimeError("synthesis produced no result")
