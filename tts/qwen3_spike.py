"""Qwen3-TTS spike — verify the engine works on this hardware.

Run from the venv:
    cd E:/audiable
    source .venv/Scripts/activate
    set HF_HOME=E:/audiable/.huggingface
    python -m tts.qwen3_spike

What this does:
    1. Detects CUDA + reports VRAM
    2. Downloads Qwen/Qwen3-TTS-12Hz-1.7B-Base from Hugging Face Hub
       (first run is ~3.4 GB, cached afterwards)
    3. Synthesizes "Hello, this is a Qwen3 test." with a default voice
    4. Saves WAV to E:/audiable/.qwen3-spike.wav
    5. Times the full inference + reports realtime ratio

Decision criteria after this runs:
    - If audio sounds natural AND inference is <2x realtime → GREEN LIGHT
      for Path A (local Tauri integration). Move on to building
      tts/qwen3.py against the existing engine interface and the
      voice cloning UX flow.
    - If quality is good but inference is 2-5x realtime → still Path A,
      but show "synthesizing N% complete" UI more prominently.
    - If quality is poor OR inference >5x realtime → re-scope. Probably
      Path B (Fly GPU) makes more economic sense, or defer Qwen3 entirely
      and ship Piper-only V1.

This script is intentionally NOT integrated with the engine dispatcher.
It's a sanity-check before committing to the full integration.
"""

from __future__ import annotations

import os
import sys
import time
import wave
from pathlib import Path

# Pin HF cache to E: so the model download doesn't kill C: (which is at 98%).
os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent.parent / ".huggingface"))


def report_hardware() -> None:
    import torch

    print(f"PyTorch:    {torch.__version__}")
    print(f"CUDA build: {torch.version.cuda}")
    print(f"CUDA avail: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            name = torch.cuda.get_device_name(i)
            mem_gb = torch.cuda.get_device_properties(i).total_memory / 1e9
            print(f"  GPU {i}: {name}  ({mem_gb:.1f} GB VRAM)")
    else:
        print("  (no GPU — Qwen3 will run on CPU, expect 30-60s per sentence)")


def make_reference_clip() -> Path:
    """Generate a ~10s reference WAV using Piper so the CustomVoice
    model has something to clone. In real usage the user supplies
    their own reference (their character's reading), but for the spike
    we just need ANY audio in the right format.
    """
    ref_path = Path(__file__).resolve().parent.parent / ".qwen3-ref.wav"
    if ref_path.exists():
        print(f"  reusing existing reference: {ref_path}")
        return ref_path

    print(f"  generating Piper reference clip at {ref_path}...")
    # Use the first installed Piper voice as the reference source.
    from . import piper_engine

    voices = piper_engine.list_voices()
    if not voices:
        raise RuntimeError(
            "No Piper voices installed — drop a .onnx into voices/ "
            "before running this spike, or supply your own reference "
            "WAV at .qwen3-ref.wav"
        )
    ref_text = (
        "This is a reference voice sample for the Qwen3-TTS spike. "
        "About ten seconds of clean speech is what the model needs."
    )
    out_chunks = list(piper_engine.synthesize_iter(ref_text, voices[0].id))
    # Last chunk is the result event with the combined WAV
    import base64

    wav_b64 = out_chunks[-1]["wav_b64"]
    ref_path.write_bytes(base64.b64decode(wav_b64))
    print(f"  reference ready ({ref_path.stat().st_size // 1024} KB)")
    return ref_path


def load_model():
    """Load Qwen3-TTS-CustomVoice via transformers.

    Using CustomVoice (not Base) because the user-confirmed product
    direction is "import a reference WAV → get that voice." The Base
    model with 49 stock voices is interesting but not the differentiator.
    """
    print("\nLoading Qwen3-TTS-12Hz-1.7B-CustomVoice...")
    print(f"  HF_HOME: {os.environ['HF_HOME']}")
    t0 = time.time()

    model_id = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"

    # Path 1: standard AutoProcessor + AutoModelForTextToSpeech
    try:
        from transformers import AutoProcessor, AutoModelForTextToSpeech

        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = AutoModelForTextToSpeech.from_pretrained(
            model_id,
            trust_remote_code=True,
            torch_dtype="auto",
        )
        print(f"  loaded via AutoModelForTextToSpeech in {time.time() - t0:.1f}s")
        return processor, model, "auto_tts"
    except Exception as e:
        print(f"  AutoModelForTextToSpeech path failed: {e!r}")

    # Path 2: generic AutoModel + AutoProcessor (some Qwen models)
    try:
        from transformers import AutoProcessor, AutoModel

        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = AutoModel.from_pretrained(
            model_id,
            trust_remote_code=True,
            torch_dtype="auto",
        )
        print(f"  loaded via AutoModel in {time.time() - t0:.1f}s")
        return processor, model, "auto_model"
    except Exception as e:
        print(f"  AutoModel path failed: {e!r}")

    # Path 3: Qwen-specific pipeline (whatever Alibaba published)
    try:
        from transformers import pipeline

        pipe = pipeline("text-to-speech", model=model_id, trust_remote_code=True)
        print(f"  loaded via pipeline() in {time.time() - t0:.1f}s")
        return None, pipe, "pipeline"
    except Exception as e:
        print(f"  pipeline path failed: {e!r}")

    raise RuntimeError(
        "Could not load Qwen3-TTS via any standard transformers path. "
        "Check the HF model card at "
        "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base for the "
        "actual usage code, and update this spike script accordingly."
    )


def synthesize(processor, model, mode: str, text: str, ref_path: Path) -> tuple[bytes, int, float]:
    """Run inference and return (wav_bytes, sample_rate, elapsed_seconds)."""
    import torch
    import io

    print(f"\nSynthesizing: {text!r}")
    print(f"  reference voice: {ref_path}")
    t0 = time.time()

    device = "cuda" if torch.cuda.is_available() else "cpu"

    if mode == "pipeline":
        out = model(text, reference_audio=str(ref_path))
        audio = out["audio"]
        sr = out["sampling_rate"]
    else:
        # Most Qwen3-TTS-CustomVoice processors take both text and a
        # reference audio path/array. The exact kwarg may differ
        # (`audio`, `ref_audio`, `speaker_audio`, `prompt_speech`...);
        # we pass several candidates and rely on the processor to
        # silently drop the ones it doesn't recognise.
        inputs = processor(
            text=text,
            audio=str(ref_path),
            return_tensors="pt",
        ).to(device)
        if hasattr(model, "to"):
            model = model.to(device)
        with torch.no_grad():
            output = model.generate(**inputs)
        # The output shape varies — try the common attribute names
        if hasattr(output, "waveform"):
            audio = output.waveform.cpu().numpy()
        elif hasattr(output, "audio_values"):
            audio = output.audio_values.cpu().numpy()
        else:
            audio = output.cpu().numpy()
        sr = getattr(processor, "sampling_rate", 12000)

    elapsed = time.time() - t0

    # audio is typically float32 in [-1, 1]; convert to int16 PCM WAV.
    import numpy as np

    if audio.ndim > 1:
        audio = audio.squeeze()
    if audio.dtype != np.int16:
        audio = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(audio.tobytes())

    return buf.getvalue(), int(sr), elapsed


def main() -> int:
    report_hardware()
    try:
        ref_path = make_reference_clip()
    except Exception as e:
        print(f"\nFATAL building reference clip: {e}")
        return 1
    try:
        processor, model, mode = load_model()
    except Exception as e:
        print(f"\nFATAL loading Qwen3: {e}")
        return 1

    text = "Hello, this is a Qwen3 test of the new neural narrator engine."
    try:
        wav, sr, elapsed = synthesize(processor, model, mode, text, ref_path)
    except Exception as e:
        import traceback
        print(f"\nSYNTHESIS FAILED: {e!r}")
        traceback.print_exc()
        return 2

    out_path = Path(__file__).resolve().parent.parent / ".qwen3-spike.wav"
    out_path.write_bytes(wav)

    audio_seconds = len(wav) / (sr * 2)  # 16-bit mono
    realtime_ratio = elapsed / audio_seconds if audio_seconds else float("inf")

    print(f"\nResult:")
    print(f"  wav:           {out_path}")
    print(f"  sample rate:   {sr} Hz")
    print(f"  audio length:  {audio_seconds:.2f} s")
    print(f"  inference:     {elapsed:.2f} s")
    print(f"  realtime ratio: {realtime_ratio:.2f}x ({'faster' if realtime_ratio < 1 else 'slower'} than realtime)")
    print(f"\nPlay it: start {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
