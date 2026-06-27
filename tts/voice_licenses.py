"""Per-voice commercial-licensing metadata for Piper voices.

This module is the authoritative record of which voices Narrative ships
+ recommends for commercial-use scenarios (selling generated audiobooks,
SaaS production). Built from the audit captured in task #215 — every
voice listed here was checked against its upstream MODEL_CARD and the
underlying dataset's actual license text.

Schema per record:

    license: str           # short license name, e.g. "CC BY 4.0"
    dataset: str           # dataset name, e.g. "LibriTTS"
    dataset_url: str       # canonical reference URL
    attribution: str       # exact text to credit when distributing output
    commercial: bool       # True iff the voice may be used commercially
    notes: str             # any nuance worth surfacing in the UI

The DEFAULT_RECORD applies to voices not explicitly listed — it's
intentionally conservative ("unknown — assume non-commercial").

When auditing a new voice:

1. Pull the MODEL_CARD from
   https://huggingface.co/rhasspy/piper-voices/raw/main/<lang>/<voice>/<quality>/MODEL_CARD
2. Note the dataset URL.
3. Verify the dataset's license at its canonical source.
4. Check for "Finetuned from lessac" — if present, the voice inherits
   the Blizzard 2013 license, which is research-only / non-commercial.
5. Add a record below.
"""

from __future__ import annotations

# v217: every record here is the result of a live audit against the
# upstream MODEL_CARD + the dataset's canonical license page. Sources:
#   - https://huggingface.co/rhasspy/piper-voices/raw/main/<path>/MODEL_CARD
#   - https://creativecommons.org/licenses/*
#   - https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
#   - https://github.com/dioco-group/jenny-tts-dataset
#   - https://github.com/MycroftAI/mimic3-voices/blob/master/voices/en_UK/apope_low/LICENSE
VOICE_LICENSES: dict[str, dict] = {
    # ---- Kokoro (Apache 2.0) — ALL voices commercial-OK ----
    # The 82M Kokoro model + bundled voices ship under Apache 2.0
    # (engine + weights). Permissive for commercial use, modification,
    # and redistribution. No per-voice attribution required by the
    # license; we credit "Kokoro by hexgrad" as goodwill.
    # The catalog auto-applies this record to every kokoro:* voice id
    # via a fallback in license_for() — listing every voice here would
    # be busy-work.

    # ---- APPROVED — commercial use allowed ----
    "en_US-libritts-high": {
        "license": "CC BY 4.0",
        "dataset": "LibriTTS",
        "dataset_url": "http://www.openslr.org/60/",
        "attribution": "LibriTTS (Heiga Zen et al.), CC BY 4.0",
        "commercial": True,
        "notes": "904 speakers — multi-speaker; quality varies per speaker, use the speaker wizard to audition.",
    },
    "en_US-libritts_r-medium": {
        "license": "CC BY 4.0",
        "dataset": "LibriTTS-R",
        "dataset_url": "http://www.openslr.org/141/",
        "attribution": "LibriTTS-R, CC BY 4.0",
        "commercial": True,
        "notes": "Refined LibriTTS — higher fidelity than the original.",
    },
    "en_GB-vctk-medium": {
        "license": "CC BY 4.0",
        "dataset": "VCTK (Voice Conversion Toolkit)",
        "dataset_url": "https://datashare.ed.ac.uk/handle/10283/3443",
        "attribution": "VCTK — University of Edinburgh CSTR, CC BY 4.0",
        "commercial": True,
        "notes": "109 British English speakers, both male and female.",
    },
    "en_GB-jenny_dioco-medium": {
        "license": "Custom permissive (Dioco)",
        "dataset": "Jenny TTS",
        "dataset_url": "https://github.com/dioco-group/jenny-tts-dataset",
        "attribution": "Jenny (Dioco)",
        "commercial": True,
        "notes": "Single British female voice; credit as 'Jenny' or 'Jenny (Dioco)'.",
    },
    # LJ Speech — public domain (CC0). Both the texts (published 1884–1964)
    # and the LibriVox recordings (2016–17) are explicitly placed in the
    # public domain by the dataset author (keithito.com/LJ-Speech-Dataset),
    # and the Piper MODEL_CARD states "License: public domain". No
    # attribution required. Three quality tiers, identical license.
    "en_US-ljspeech-high": {
        "license": "Public domain",
        "dataset": "LJ Speech",
        "dataset_url": "https://keithito.com/LJ-Speech-Dataset/",
        "attribution": "",
        "commercial": True,
        "notes": "Public-domain dataset (CC0) — texts + LibriVox recordings both released to the public domain; no attribution required. Single US female speaker; older + single-speaker, so lower fidelity than LibriTTS-R.",
    },
    "en_US-ljspeech-medium": {
        "license": "Public domain",
        "dataset": "LJ Speech",
        "dataset_url": "https://keithito.com/LJ-Speech-Dataset/",
        "attribution": "",
        "commercial": True,
        "notes": "Public-domain dataset (CC0); no attribution required. Single US female speaker.",
    },
    "en_US-ljspeech-low": {
        "license": "Public domain",
        "dataset": "LJ Speech",
        "dataset_url": "https://keithito.com/LJ-Speech-Dataset/",
        "attribution": "",
        "commercial": True,
        "notes": "Public-domain dataset (CC0); no attribution required. Single US female speaker; low quality (fastest).",
    },

    # ---- EXCLUDED — Mycroft 'All Rights Reserved' or unverifiable ----
    "en_US-amy-medium": {
        "license": "Unverifiable",
        "dataset": "MycroftAI/mimic3-voices (path missing)",
        "dataset_url": "https://github.com/MycroftAI/mimic3-voices",
        "attribution": "",
        "commercial": False,
        "notes": "MODEL_CARD points at MycroftAI/mimic3-voices but the 'amy' path does not exist there. Mycroft AI went bankrupt in 2023 — no path to a commercial license. Finetuned from Lessac (research only) on top.",
    },
    "en_GB-alan-medium": {
        "license": "Copyright Mycroft AI / All Rights Reserved",
        "dataset": "MycroftAI/mimic3-voices apope_low",
        "dataset_url": "https://github.com/MycroftAI/mimic3-voices/tree/master/voices/en_UK/apope_low",
        "attribution": "",
        "commercial": False,
        "notes": "Proprietary 'All Rights Reserved' notice; Mycroft AI bankrupt 2023, no licensor exists. Also finetuned from Lessac (research only).",
    },

    # ---- EXCLUDED — research/non-commercial dataset licenses ----
    "en_US-lessac-low": {
        "license": "Blizzard Challenge 2013 (research only)",
        "dataset": "Blizzard Challenge 2013 — Lessac",
        "dataset_url": "https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html",
        "attribution": "",
        "commercial": False,
        "notes": "License explicitly forbids commercial use, redistribution, and 'use as audio books'. Any voice finetuned from Lessac inherits these restrictions.",
    },
    "en_US-lessac-medium": {
        "license": "Blizzard Challenge 2013 (research only)",
        "dataset": "Blizzard Challenge 2013 — Lessac",
        "dataset_url": "https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html",
        "attribution": "",
        "commercial": False,
        "notes": "License explicitly forbids commercial use.",
    },
    "en_US-lessac-high": {
        "license": "Blizzard Challenge 2013 (research only)",
        "dataset": "Blizzard Challenge 2013 — Lessac",
        "dataset_url": "https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html",
        "attribution": "",
        "commercial": False,
        "notes": "License explicitly forbids commercial use.",
    },
    "en_US-arctic-medium": {
        "license": "Blizzard 2013 (inherited via Lessac finetune)",
        "dataset": "CMU Arctic",
        "dataset_url": "http://www.festvox.org/cmu_arctic/",
        "attribution": "",
        "commercial": False,
        "notes": "Finetuned from Lessac — inherits Blizzard 2013 research-only restriction regardless of CMU Arctic's permissive license.",
    },
    "en_US-l2arctic-medium": {
        "license": "CC BY-NC 4.0",
        "dataset": "L2-Arctic",
        "dataset_url": "https://www.isca-speech.org/archive/interspeech_2018/zhao18b_interspeech.html",
        "attribution": "",
        "commercial": False,
        "notes": "NonCommercial — explicit license clause.",
    },
    "en_US-hfc_female-medium": {
        "license": "CC BY-NC-SA 4.0",
        "dataset": "Hi-Fi Captain",
        "dataset_url": "https://ast-astrec.nict.go.jp/en/release/hi-fi-captain/",
        "attribution": "",
        "commercial": False,
        "notes": "NonCommercial + ShareAlike.",
    },
    "en_US-hfc_male-medium": {
        "license": "CC BY-NC-SA 4.0",
        "dataset": "Hi-Fi Captain",
        "dataset_url": "https://ast-astrec.nict.go.jp/en/release/hi-fi-captain/",
        "attribution": "",
        "commercial": False,
        "notes": "NonCommercial + ShareAlike.",
    },
    "en_GB-semaine-medium": {
        "license": "CC BY-NC-SA 4.0",
        "dataset": "SEMAINE (DFKI / MaryTTS)",
        "dataset_url": "https://github.com/marytts/dfki-semaine-data",
        "attribution": "",
        "commercial": False,
        "notes": "NonCommercial + ShareAlike.",
    },
}


# Voices not in VOICE_LICENSES default to this record. Intentionally
# conservative — "unknown" means "do not assume commercial use until
# audited."
DEFAULT_RECORD: dict = {
    "license": "Unaudited",
    "dataset": "Unknown",
    "dataset_url": "",
    "attribution": "",
    "commercial": False,
    "notes": "Not yet audited. Pull the voice's MODEL_CARD from huggingface.co/rhasspy/piper-voices and verify before commercial use.",
}


# Kokoro bundle ships under Apache 2.0 (engine + weights). Every
# voice in the bundle inherits this — the underlying training data was
# already audited by hexgrad and the release is unambiguously commercial.
# Applied via license_for() below when a voice_id starts with "kokoro:".
KOKORO_RECORD: dict = {
    "license": "Apache 2.0",
    "dataset": "Kokoro-82M (hexgrad)",
    "dataset_url": "https://huggingface.co/hexgrad/Kokoro-82M",
    "attribution": "Kokoro by hexgrad, Apache 2.0",
    "commercial": True,
    "notes": "82M-parameter Apache 2.0 model. #1 on TTS Arena (Jan 2026). "
             "Engine + all bundled voices are permissively licensed.",
}


# Adonis Voice Studio voices (voicestudio:* prefix) are served from the
# author's local GPU app and come in three flavours, all commercial-OK:
#   - Kokoro base (Apache 2.0 — same as KOKORO_RECORD)
#   - StyleTTS2 fine-tunes of the AUTHOR'S OWN recorded voice (MIT model +
#     the author owns the recordings)
#   - knn-vc zero-shot conversions (MIT) over the author's own audio
# Commercial use is fine on the premise that the author owns the source
# recordings — which holds for self-trained voices. Applied by PREFIX in
# license_for() because Voice Studio creates voice names dynamically (there's
# nothing to enumerate here). See docs/VOICE_STUDIO_INTEGRATION.md.
VOICESTUDIO_RECORD: dict = {
    "license": "Apache-2.0 / MIT (author-owned recordings)",
    "dataset": "Adonis Voice Studio (Kokoro base / StyleTTS2 fine-tune / knn-vc)",
    "dataset_url": "",
    "attribution": "",
    "commercial": True,
    "notes": "Local Voice Studio voice. Commercial-OK assuming the author owns "
             "the training/source recordings (true for self-trained voices). "
             "Not for cloning a third party's voice without their permission.",
}


def license_for(voice_id: str) -> dict:
    """Return the license record for a voice id.

    - kokoro:* voices auto-apply the Apache-2.0 KOKORO_RECORD (no need
      to enumerate every voice in VOICE_LICENSES).
    - voicestudio:* voices auto-apply VOICESTUDIO_RECORD (names are created
      dynamically in Voice Studio, so they can't be enumerated).
    - Piper voices look up by suffix in VOICE_LICENSES.
    - Anything unknown falls back to DEFAULT_RECORD (commercial=False) —
      the safer default so we never accidentally promise commercial-OK
      on an unverified voice.
    """
    if voice_id.startswith("kokoro:"):
        return dict(KOKORO_RECORD)
    if voice_id.startswith("voicestudio:"):
        return dict(VOICESTUDIO_RECORD)
    # Piper IDs are passed in here as "en_US-libritts-high" (no prefix);
    # also strip the "piper:" prefix defensively in case a caller passes
    # the fully-qualified id.
    key = voice_id[6:] if voice_id.startswith("piper:") else voice_id
    rec = VOICE_LICENSES.get(key)
    if rec is None:
        return dict(DEFAULT_RECORD)
    return dict(rec)
