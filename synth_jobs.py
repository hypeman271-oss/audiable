"""Server-side resumable synthesis (v226 / #512).

The pre-v226 synth pipeline ran inside the request handler that owned
the SSE connection. A network blip, mobile backgrounding, Fly load
balancer hiccup, or browser tab navigation killed the connection AND
the synthesis, forcing the user to restart from sentence 0. Reported
several times — most painfully on a 28-minute chapter that died at
177/198 sentences (#577 log).

This module decouples the synth from the connection:

  * A `SynthJob` runs as a detached `asyncio.Task` (created via
    `asyncio.create_task`). The task survives the originating
    request being cancelled. As sentences complete, the job
    appends each WAV to an in-memory buffer and fires its
    `event_queue` so live subscribers see it.

  * `subscribe(job_id, from_sentence)` returns an async generator
    that yields sentence events from `from_sentence` onwards.
    Already-completed sentences replay immediately from the
    buffer; new sentences stream live as they arrive. Multiple
    subscribers per job are supported.

  * Client lifecycle: POST a job → store job_id locally → open
    SSE stream → if it drops, reopen with `?from=N` where N is
    the next unseen sentence index. Server doesn't care if the
    client comes back in 30 seconds or 30 minutes; the buffer
    waits.

  * Cleanup: jobs auto-evict 1 hour after completion (or failure)
    so the memory footprint stays bounded. A failed job's buffer
    sticks around so the client can still pull the partial work.

Memory: a typical 200-sentence chapter is ~20 MB of WAV in
memory while in flight. On a 2 GB Fly machine with ~3-5
concurrent jobs at peak, this is fine. Long-term we may persist
to disk; phase 1 keeps it simple.

Out of scope for phase 1:
  * Server restart recovery (in-flight jobs are lost; client
    POSTs a new job and starts over). Auto-resume on restart
    requires disk persistence which is phase 2.
  * Cross-device job visibility ("phone started a synth, desktop
    sees it in progress"). Phase 2.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import tts
from tts.encode import wav_to_mp3


# Memory cap per job's sentence buffer. A 200-sentence chapter at ~100KB
# per WAV is ~20 MB; we accept up to ~80 MB before refusing further
# appends as a safety net (very long books).
_MAX_BUFFER_BYTES = 80 * 1024 * 1024

# How long a completed/failed job lingers before its buffer is freed.
# 1 hour gives reconnects + retries time without leaking memory if
# a client never comes back.
_GC_SECONDS = 60 * 60


@dataclass
class JobParams:
    """Synth parameters frozen at job creation.

    `target_clip_id` + `target_line_ids` opt into Phase B per-sentence
    caching (#811 B.2b). When both are set, the worker writes each
    sentence's WAV to the sentence_audio cache as it's yielded by the
    engine. Audio quality matches the combined MP3 because all
    sentences share a single `synthesize_iter()` call — the engine's
    warmup is paid once, at sentence 0, then amortized across the rest.
    (The spike's per-sentence `/api/synthesize` calls failed exactly
    this assumption — every call paid its own warmup, producing an
    audible startup transient at the start of every cached WAV.)
    """

    text: str
    voice_id: str
    rate: float
    volume: float
    speaker_id: int | None
    target_clip_id: int | None = None
    target_line_ids: list[str] | None = None
    # Display label for the bg-queue pill. Carried so a client that
    # reattaches on boot (after a reload) can label + save the clip
    # without the original in-memory chapter.
    title: str | None = None
    # v4.111: the library clip this synth should SAVE ONTO (overwrite),
    # distinct from target_clip_id (which is the Phase B per-sentence
    # cache opt-in). Clip identity is otherwise client-side only, so
    # without this a reattach can't rebind to the original card and
    # spawns a duplicate. Always sent when re-narrating an existing clip.
    clip_id: int | None = None
    # v4.210: character-voice (multi-voice) background jobs. When set, the
    # worker renders these [{text, voice_id, speaker_id}, …] segments via
    # tts.synthesize_segments_iter instead of the single-voice path, so the
    # bg-queue / whole-book synth honors per-character voices. `text`/`voice_id`
    # above stay populated (the concatenated text + the fallback voice) for
    # labeling, the save path, and the content hash.
    segments: list[dict[str, Any]] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> JobParams:
        # Optional per-sentence cache targets. None on either side
        # disables caching for this job. We coerce to plain list[str]
        # so the dataclass round-trips cleanly into the worker.
        raw_line_ids = d.get("target_line_ids")
        target_line_ids: list[str] | None = None
        if raw_line_ids is not None:
            if not isinstance(raw_line_ids, list):
                raise ValueError("target_line_ids must be a list")
            target_line_ids = [str(x) for x in raw_line_ids]
            if not target_line_ids:
                target_line_ids = None
        raw_clip = d.get("target_clip_id")
        target_clip_id = int(raw_clip) if raw_clip is not None else None
        # Both-or-neither: a clip_id without line_ids has nothing to
        # write against; line_ids without a clip_id has nowhere to write.
        if (target_clip_id is None) != (target_line_ids is None):
            raise ValueError(
                "target_clip_id and target_line_ids must be set together"
            )
        # Use explicit `is not None` checks instead of dict.get's default
        # arg, because SynthesizeRequest models rate/volume as
        # Optional[float] — a caller that omits them sends `None`
        # through to here, and `get("k", default)` returns None (the
        # value), not the default. float(None) crashes. (Pre-existing
        # latent bug; surfaced when v4.21 added a server-side caller
        # that doesn't always set volume.)
        rate_raw = d.get("rate")
        volume_raw = d.get("volume")
        # v4.210: optional character-voice segments. Each must carry text; voice
        # /speaker are optional (a None voice falls back to the engine default).
        raw_segments = d.get("segments")
        segments: list[dict[str, Any]] | None = None
        if raw_segments is not None:
            if not isinstance(raw_segments, list):
                raise ValueError("segments must be a list")
            segments = []
            for s in raw_segments:
                if not isinstance(s, dict):
                    raise ValueError("each segment must be an object")
                seg_text = str(s.get("text", ""))
                if not seg_text.strip():
                    continue
                segments.append({
                    "text": seg_text,
                    "voice_id": (str(s["voice_id"]) if s.get("voice_id") else None),
                    "speaker_id": (
                        int(s["speaker_id"]) if s.get("speaker_id") is not None else None
                    ),
                })
            if not segments:
                segments = None
        return cls(
            text=str(d.get("text", "")),
            voice_id=str(d.get("voice_id", "")),
            rate=float(rate_raw) if rate_raw is not None else 180.0,
            volume=float(volume_raw) if volume_raw is not None else 1.0,
            speaker_id=(
                int(d["speaker_id"]) if d.get("speaker_id") is not None else None
            ),
            target_clip_id=target_clip_id,
            target_line_ids=target_line_ids,
            title=(str(d["title"])[:300] if d.get("title") is not None else None),
            clip_id=(int(d["clip_id"]) if d.get("clip_id") is not None else None),
            segments=segments,
        )


@dataclass
class SynthJob:
    """Live state for a single synthesis job. Lives in _JOBS until GC."""

    id: str
    tenant_key: str | None
    params: JobParams
    # status: pending → running → done | failed | cancelled
    status: str = "pending"
    sentences_total: int = 0
    sentences_done: int = 0
    # In-memory buffer of {index, offset_ms, wav_bytes} dicts.
    # Subscribers replay from here on reconnect.
    sentence_events: list[dict[str, Any]] = field(default_factory=list)
    # Final combined MP3 once status=done. Held in memory until GC so
    # the client can pull it via the combined endpoint.
    mp3_bytes: bytes | None = None
    audio_sha256: str | None = None
    sentence_offsets_ms: list[int] = field(default_factory=list)
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    # Notify subscribers when sentences_done or status changes.
    # asyncio.Condition so we can wait + check.
    _condition: asyncio.Condition | None = None
    # The asyncio.Task that's running the synth, for cancel.
    _task: asyncio.Task | None = None
    # Total bytes buffered, for the memory cap.
    _buffer_bytes: int = 0

    def snapshot(self) -> dict[str, Any]:
        """Status snapshot the client polls. Light — safe to list many.
        `title` is included so a reattaching client can label the pill
        without fetching the (potentially large) text."""
        return {
            "id": self.id,
            "status": self.status,
            "sentences_total": self.sentences_total,
            "sentences_done": self.sentences_done,
            "error": self.error,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
            "has_audio": self.mp3_bytes is not None,
            "audio_sha256": self.audio_sha256,
            "title": self.params.title,
        }

    def reattach_detail(self) -> dict[str, Any]:
        """snapshot() + the params a client needs to reconstruct + save
        the clip after reattaching to this job on boot (it lost the
        original in-memory chapter on reload). Heavier (carries the full
        text) — only the single-job status endpoint returns it, never the
        list."""
        return {
            **self.snapshot(),
            "text": self.params.text,
            "voice_id": self.params.voice_id,
            "rate": self.params.rate,
            "volume": self.params.volume,
            "speaker_id": self.params.speaker_id,
            "target_clip_id": self.params.target_clip_id,
            "target_line_ids": self.params.target_line_ids,
            "clip_id": self.params.clip_id,
        }


# Global in-memory job registry. Indexed by job id.
_JOBS: dict[str, SynthJob] = {}


def get_job(job_id: str) -> SynthJob | None:
    """Return a job by id, or None if unknown / already evicted."""
    return _JOBS.get(job_id)


def list_jobs_for_tenant(
    tenant_key: str | None, active_only: bool = False
) -> list[dict[str, Any]]:
    """Return snapshots of this tenant's jobs. Used by the client on
    app boot to reattach to in-flight work."""
    out = []
    for job in _JOBS.values():
        if job.tenant_key != tenant_key:
            continue
        if active_only and job.status not in ("pending", "running"):
            continue
        out.append(job.snapshot())
    return out


def list_active_jobs() -> list[dict[str, Any]]:
    """Return snapshots of every in-flight job across all tenants.
    Used by the pre-deploy guard (#795 / scripts/predeploy_check.ps1)
    to refuse deploys that would interrupt synthesis — a rolling
    restart mid-synth has produced duplicate clips in practice
    (see #574 and the v225v4.3 → v225v4.4 incident).

    "Active" means status pending or running. done/failed/cancelled
    jobs are not blockers — their buffers live in _JOBS until GC, but
    they're not consuming the synth pipeline. Includes tenant_key and
    elapsed time so the guard's diagnostic output is actionable
    ("which tester's job, how long left to wait").
    """
    now = time.time()
    out = []
    for job in _JOBS.values():
        if job.status not in ("pending", "running"):
            continue
        snap = job.snapshot()
        snap["tenant_key"] = job.tenant_key
        snap["elapsed_sec"] = round(now - job.created_at, 1)
        out.append(snap)
    return out


async def create_job(
    params: JobParams, tenant_key: str | None
) -> SynthJob:
    """Create a job, spawn its background worker, return it.

    The returned job's `_task` is running detached — the caller can
    return the job_id to the HTTP client immediately. The synth
    continues even if the request handler exits."""
    job_id = f"synth_{uuid.uuid4().hex[:12]}"
    job = SynthJob(
        id=job_id,
        tenant_key=tenant_key,
        params=params,
    )
    job._condition = asyncio.Condition()
    _JOBS[job_id] = job
    # Schedule the worker on the running event loop. asyncio.create_task
    # adds it to the loop's task set; it survives the request handler.
    job._task = asyncio.create_task(_run_worker(job))
    return job


def _write_sentence_to_cache(
    wav_b64: str,
    tenant_key: str,
    clip_id: int,
    line_id: str,
    voice_id: str | None,
    speaker_id: int | None,
    rate: int,
) -> None:
    """Encode the sentence WAV to FLAC and write the cache row.

    CPU-bound (FLAC encode shells out to ffmpeg); call via
    `loop.run_in_executor` so the worker's event loop isn't blocked.

    Raises on any failure — the worker catches and fails the job loudly
    so a partial cache doesn't lurk silently.
    """
    import library_db as _ldb
    from tts.encode import wav_to_flac, wav_duration_ms

    if not _ldb.is_enabled():
        # No-op when library_db is off — but the worker only enters
        # this path when both target fields are set, and the
        # /api/synth/jobs endpoint won't accept those fields unless
        # library_db is enabled. So this is a defense-in-depth check.
        raise RuntimeError("library_db not enabled — cannot cache sentences")

    wav_bytes = base64.b64decode(wav_b64)
    if not wav_bytes:
        raise ValueError("sentence event carried empty wav_b64")
    duration_ms = wav_duration_ms(wav_bytes)
    flac_bytes = wav_to_flac(wav_bytes)
    audio_sha256 = _ldb.store_sentence_audio(flac_bytes)
    _ldb.record_sentence_audio(
        tenant_key,
        clip_id,
        line_id,
        audio_sha256=audio_sha256,
        voice_id=voice_id,
        speaker_id=speaker_id,
        rate=rate,
        duration_ms=duration_ms,
    )


# ---- Resume-from-cache (v4.111 — restart-resumable synthesis) ------------

def _content_hash(params: "JobParams") -> str:
    """Stable key for the resume cache: identical (text, voice, speaker,
    rate) → same hash → same cached sentences. Volume is excluded (it's
    applied at synth but doesn't change sentence boundaries; keeping it
    out lets a volume tweak still reuse the cache — harmless since volume
    rarely differs across a retry)."""
    h = hashlib.sha256()
    h.update((params.text or "").encode("utf-8"))
    h.update(b"\x00")
    h.update((params.voice_id or "").encode("utf-8"))
    h.update(b"\x00")
    h.update(str(params.speaker_id).encode("utf-8"))
    h.update(b"\x00")
    h.update(str(int(params.rate)).encode("utf-8"))
    # v4.210: a multi-voice (segments) render of the same text differs from the
    # single-voice one — fold the per-segment voice/speaker into the key so the
    # resume cache never serves single-voice sentences to a segment job.
    if params.segments:
        for s in params.segments:
            h.update(b"\x00seg\x00")
            h.update((s.get("voice_id") or "").encode("utf-8"))
            h.update(b"\x00")
            h.update(str(s.get("speaker_id")).encode("utf-8"))
            h.update(b"\x00")
            h.update((s.get("text") or "").encode("utf-8"))
    return h.hexdigest()


def _persist_resume_sentence(
    wav_b64: str, tenant_key: str, content_hash: str, sentence_idx: int
) -> None:
    """Best-effort write of one sentence WAV to the resume cache. Runs in
    the executor (FLAC encode is CPU-bound). Never raises into the worker —
    resume is an optimization; a write failure must not kill the synth."""
    import library_db as _ldb
    from tts.encode import wav_to_flac, wav_duration_ms

    try:
        if not _ldb.is_enabled() or not tenant_key:
            return
        wav_bytes = base64.b64decode(wav_b64)
        if not wav_bytes:
            return
        duration_ms = wav_duration_ms(wav_bytes)
        flac_bytes = wav_to_flac(wav_bytes)
        sha = _ldb.store_sentence_audio(flac_bytes)
        _ldb.record_resume_sentence(
            tenant_key, content_hash, sentence_idx,
            audio_sha256=sha, duration_ms=duration_ms,
        )
    except Exception as exc:
        print(
            f"[synth_jobs] resume-cache write failed (idx {sentence_idx}): {exc}",
            file=sys.stderr, flush=True,
        )


def _load_resume_prefix(
    tenant_key: str, content_hash: str, sentences: list[str]
) -> list[dict] | None:
    """Return a list of {wav_bytes, duration_ms} for the contiguous cached
    prefix [0..k), or None if resume isn't safe. Pure read — emits nothing,
    so the caller can cleanly fall back to a full synth on None.

    Safety guards (any failure → None → full re-synth, never wrong audio):
      - 0 < k <= N.
      - The remaining text [k..N) must re-split into EXACTLY sentences[k:].
        The engine re-splits the text it's given; if a naive join doesn't
        round-trip (e.g. a force-split long sentence), we can't line the
        remainder up with the cached prefix, so we bail.
      - Every cached FLAC blob must decode. A missing/corrupt blob → bail.
    """
    import library_db as _ldb
    from tts.encode import flac_to_wav

    if not _ldb.is_enabled() or not tenant_key:
        return None
    n = len(sentences)
    prefix_rows = _ldb.get_resume_prefix(tenant_key, content_hash)
    k = len(prefix_rows)
    if k == 0 or k > n:
        return None
    # Remainder must round-trip through the same splitter the engine uses,
    # or the cached prefix won't align with what the engine produces.
    remainder = sentences[k:]
    if remainder and tts.split_sentences(" ".join(remainder)) != remainder:
        return None
    out = []
    for row in prefix_rows:
        flac_path = _ldb.SENTENCE_DIR / f"{row['audio_sha256']}.flac"
        try:
            flac_bytes = flac_path.read_bytes()
            wav_bytes = flac_to_wav(flac_bytes)
        except Exception:
            return None  # blob gone/corrupt — safer to re-synth from scratch
        out.append({"wav_bytes": wav_bytes, "duration_ms": int(row["duration_ms"])})
    return out


def _emit_sentence(job: SynthJob, index: int, total: int, offset_ms: int, wav_bytes: bytes) -> None:
    """Append a synthetic sentence event to the job buffer in the exact
    shape subscribe() replays (buffer position == index)."""
    job.sentence_events.append({
        "type": "sentence",
        "index": index,
        "total": total,
        "offset_ms": offset_ms,
        "wav_b64": base64.b64encode(wav_bytes).decode(),
    })
    job._buffer_bytes += len(wav_bytes)
    job.sentences_done = max(job.sentences_done, index + 1)
    job.sentences_total = max(job.sentences_total, total)


async def _synthesize_resume(
    job: SynthJob, content_hash: str, sentences: list[str], prefix: list[dict]
) -> None:
    """Resume branch: replay the cached prefix, synthesize only the
    remainder in one engine pass, and stitch the combined audio from all
    per-sentence WAVs. Because the engine pads each per-sentence WAV, a
    concat of (cached prefix + fresh remainder) is byte-identical to a
    full single-pass result. On any synth error this _fail()s the job
    (the client's retry-once then re-POSTs and resumes again)."""
    loop = asyncio.get_running_loop()
    from tts.encode import concat_wavs

    n = len(sentences)
    k = len(prefix)
    all_wavs: list[bytes] = []
    offsets: list[int] = []
    cumulative_ms = 0

    print(
        f"[synth_jobs] {job.id} resuming from cache: {k}/{n} sentences already done",
        file=sys.stderr, flush=True,
    )

    # 1) Replay the cached prefix.
    for i, row in enumerate(prefix):
        wav = row["wav_bytes"]
        _emit_sentence(job, i, n, cumulative_ms, wav)
        all_wavs.append(wav)
        offsets.append(cumulative_ms)
        cumulative_ms += row["duration_ms"]
    async with job._condition:
        job._condition.notify_all()

    # 2) Synthesize the remainder (one pass → one warmup at the boundary).
    if k < n:
        remainder_text = " ".join(sentences[k:])
        try:
            it = tts.synthesize_iter(
                text=remainder_text,
                voice_id=job.params.voice_id,
                rate=job.params.rate,
                volume=job.params.volume,
                speaker_id=job.params.speaker_id,
            )
        except ValueError as exc:
            await _fail(job, str(exc))
            return

        _DONE = object()

        def _next_event() -> Any:
            try:
                return next(it)
            except StopIteration:
                return _DONE

        from tts.encode import wav_duration_ms

        while True:
            try:
                event = await loop.run_in_executor(None, _next_event)
            except Exception as exc:
                await _fail(job, f"resume remainder synth failed: {exc}")
                return
            if event is _DONE:
                break
            if event.get("type") != "sentence":
                continue  # ignore the remainder's own "result"; we stitch
            j = int(event.get("index", 0))
            global_idx = k + j
            if global_idx >= n:
                # Engine produced more sentences than expected despite the
                # round-trip guard — abandon to avoid a corrupt clip.
                await _fail(job, "resume sentence overflow — re-synthesize")
                return
            wav = base64.b64decode(event.get("wav_b64", ""))
            if job._buffer_bytes + len(wav) > _MAX_BUFFER_BYTES:
                await _fail(job, "synth exceeded memory cap — split the chapter and retry")
                return
            _emit_sentence(job, global_idx, n, cumulative_ms, wav)
            all_wavs.append(wav)
            offsets.append(cumulative_ms)
            cumulative_ms += wav_duration_ms(wav)
            async with job._condition:
                job._condition.notify_all()
            await loop.run_in_executor(
                None, _persist_resume_sentence,
                event.get("wav_b64", ""), job.tenant_key, content_hash, global_idx,
            )

    if len(all_wavs) != n:
        await _fail(job, f"resume produced {len(all_wavs)} of {n} sentences — re-synthesize")
        return

    # 3) Stitch + encode the full combined audio.
    try:
        combined = concat_wavs(all_wavs)
        mp3_bytes = await loop.run_in_executor(None, wav_to_mp3, combined, 64)
    except Exception as exc:
        await _fail(job, f"resume stitch/encode failed: {exc}")
        return
    job.mp3_bytes = mp3_bytes
    job.sentence_offsets_ms = offsets
    try:
        import library_db
        if library_db.is_enabled():
            job.audio_sha256 = library_db.store_audio(mp3_bytes)
    except Exception as e:
        print(f"[synth_jobs] {job.id} audio persist failed: {e}", file=sys.stderr, flush=True)


async def _run_worker(job: SynthJob) -> None:
    """The background worker. Iterates tts.synthesize_iter via the
    thread pool (Piper is sync), appending each event to the job's
    buffer + waking any subscribers.

    v4.111: before a full synth, tries to resume from the per-sentence
    resume cache (synth_resume_cache) so a restart doesn't redo finished
    sentences. Resume is fully guarded — any doubt falls back to a clean
    full synth — and the full path persists each sentence so the next
    attempt can resume."""
    loop = asyncio.get_running_loop()
    _DONE = object()
    job.status = "running"
    async with job._condition:
        job._condition.notify_all()
    content_hash = _content_hash(job.params)
    try:
        # v4.111: try to resume from the per-sentence cache (best-effort).
        # _load_resume_prefix emits nothing + guards hard, so None here
        # cleanly means "do a normal full synth."
        # v4.210: skip resume for multi-voice (segments) jobs — the resume
        # path re-synthesizes the remainder single-voice, which would mangle
        # character voices. Correctness over the restart optimization.
        if not job.params.segments:
            try:
                _sentences = tts.split_sentences(job.params.text)
                prefix = await loop.run_in_executor(
                    None, _load_resume_prefix, job.tenant_key, content_hash, _sentences
                ) if (job.tenant_key and _sentences) else None
            except Exception as exc:
                print(f"[synth_jobs] {job.id} resume probe failed (ignored): {exc}",
                      file=sys.stderr, flush=True)
                prefix = None
            if prefix:
                await _synthesize_resume(job, content_hash, _sentences, prefix)
                if job.status not in ("failed", "cancelled"):
                    job.status = "done"
                    job.completed_at = time.time()
                    async with job._condition:
                        job._condition.notify_all()
                return

        try:
            if job.params.segments:
                # v4.210: character-voice render. Same per-sentence event shape
                # as synthesize_iter, so the loop below is unchanged.
                it = tts.synthesize_segments_iter(
                    segments=job.params.segments,
                    rate=job.params.rate,
                    volume=job.params.volume,
                )
            else:
                it = tts.synthesize_iter(
                    text=job.params.text,
                    voice_id=job.params.voice_id,
                    rate=job.params.rate,
                    volume=job.params.volume,
                    speaker_id=job.params.speaker_id,
                )
        except ValueError as exc:
            await _fail(job, str(exc))
            return

        def _next_event() -> Any:
            try:
                return next(it)
            except StopIteration:
                return _DONE

        while True:
            try:
                event = await loop.run_in_executor(None, _next_event)
            except Exception as exc:
                import traceback as _tb
                print(f"[synth_jobs] {job.id} iter raised:", file=sys.stderr, flush=True)
                _tb.print_exc()
                await _fail(job, str(exc))
                return
            if event is _DONE:
                break
            etype = event.get("type") if isinstance(event, dict) else None
            if etype == "sentence":
                # Memory-cap guard: if a runaway book busts our limit,
                # fail loudly rather than silently leak.
                approx_size = len(event.get("wav_b64", "")) // 4 * 3
                if job._buffer_bytes + approx_size > _MAX_BUFFER_BYTES:
                    await _fail(
                        job,
                        "synth exceeded memory cap — split the chapter and retry",
                    )
                    return
                job._buffer_bytes += approx_size
                job.sentence_events.append(event)
                job.sentences_done = max(job.sentences_done, event.get("index", 0) + 1)
                if "total" in event:
                    job.sentences_total = max(job.sentences_total, int(event["total"]))
                async with job._condition:
                    job._condition.notify_all()

                # Phase B / #811 B.2b: write this sentence's WAV to the
                # sentence_audio cache so a future restitch can rebuild
                # the combined MP3 without re-synthesizing. Gate on both
                # target_clip_id + target_line_ids set (the caller
                # opted in) and on tenant_key being present (cache is
                # tenant-scoped). Engine state is shared across all
                # yields in this loop, so the cached WAVs sound
                # identical to the combined result the worker produces
                # below — that's the whole point of B.2b.
                if (
                    job.params.target_clip_id is not None
                    and job.params.target_line_ids is not None
                    and job.tenant_key
                ):
                    sentence_index = int(event.get("index", -1))
                    expected = job.params.target_line_ids
                    if "total" in event:
                        total = int(event["total"])
                        if total != len(expected):
                            await _fail(
                                job,
                                f"engine produced {total} sentences but "
                                f"target_line_ids has {len(expected)} — "
                                "client and server split the text differently; "
                                "cache write skipped to avoid corruption",
                            )
                            return
                    if not (0 <= sentence_index < len(expected)):
                        await _fail(
                            job,
                            f"engine yielded sentence index {sentence_index} "
                            f"outside target_line_ids range "
                            f"[0, {len(expected)})",
                        )
                        return
                    line_id = expected[sentence_index]
                    wav_b64 = event.get("wav_b64", "")
                    try:
                        await loop.run_in_executor(
                            None,
                            _write_sentence_to_cache,
                            wav_b64,
                            job.tenant_key,
                            job.params.target_clip_id,
                            line_id,
                            job.params.voice_id,
                            job.params.speaker_id,
                            int(job.params.rate),
                        )
                    except Exception as exc:
                        # Failing the whole job on a cache write error
                        # is the right call: a partial cache means
                        # restitch will return 409 backfill_required
                        # later and the user re-synthesizes from
                        # scratch anyway. Better to surface it now.
                        import traceback as _tb
                        print(
                            f"[synth_jobs] {job.id} sentence cache write failed:",
                            file=sys.stderr, flush=True,
                        )
                        _tb.print_exc()
                        await _fail(job, f"sentence cache write failed: {exc}")
                        return

                # v4.111: also persist to the content-keyed resume cache so
                # a restart can resume THIS job mid-flight. Best-effort +
                # off-thread; never fails the job (resume is just an
                # optimization, unlike Phase B which gates restitch).
                # v4.210: skipped for segment jobs — their resume path is
                # disabled (above), so the writes would just be dead weight.
                if job.tenant_key and not job.params.segments:
                    await loop.run_in_executor(
                        None, _persist_resume_sentence,
                        event.get("wav_b64", ""),
                        job.tenant_key, content_hash,
                        int(event.get("index", 0)),
                    )
            elif etype == "result":
                # MP3-encode in the executor (CPU bound). Same hand-off
                # the old /api/synthesize/stream did.
                try:
                    wav_bytes = base64.b64decode(event["wav_b64"])
                    mp3_bytes = await loop.run_in_executor(
                        None, wav_to_mp3, wav_bytes, 64
                    )
                except Exception as exc:
                    import traceback as _tb
                    print(f"[synth_jobs] {job.id} mp3 encode failed:", file=sys.stderr, flush=True)
                    _tb.print_exc()
                    await _fail(job, f"mp3 encode failed: {exc}")
                    return
                job.mp3_bytes = mp3_bytes
                job.sentence_offsets_ms = event.get("sentence_offsets_ms", [])
                # Hand off to library_db so cross-device sync can
                # reference the audio by sha.
                try:
                    import library_db
                    if library_db.is_enabled():
                        job.audio_sha256 = library_db.store_audio(mp3_bytes)
                except Exception as e:
                    print(
                        f"[synth_jobs] {job.id} audio persist failed: {e}",
                        file=sys.stderr, flush=True,
                    )
                # No further per-sentence work after result.
                break
            # Other event types (warnings etc.) currently ignored.

        job.status = "done"
        job.completed_at = time.time()
        async with job._condition:
            job._condition.notify_all()
    except asyncio.CancelledError:
        # External cancel via DELETE.
        job.status = "cancelled"
        job.completed_at = time.time()
        async with job._condition:
            job._condition.notify_all()
        raise
    finally:
        # Schedule eviction after _GC_SECONDS. The task runs
        # detached; if the process restarts before it fires, we just
        # lose the job (which is fine — it's already done).
        asyncio.create_task(_evict_after_delay(job.id, _GC_SECONDS))


async def _fail(job: SynthJob, msg: str) -> None:
    job.status = "failed"
    job.error = msg
    job.completed_at = time.time()
    async with job._condition:
        job._condition.notify_all()


async def _evict_after_delay(job_id: str, seconds: float) -> None:
    await asyncio.sleep(seconds)
    _JOBS.pop(job_id, None)


async def cancel_job(job_id: str) -> bool:
    job = _JOBS.get(job_id)
    if not job:
        return False
    if job._task and not job._task.done():
        job._task.cancel()
    else:
        # Already finished; nothing to cancel, but flag so the snapshot
        # reads "cancelled" instead of "done."
        job.status = "cancelled"
        job.completed_at = job.completed_at or time.time()
        async with job._condition:
            job._condition.notify_all()
    return True


async def subscribe(
    job_id: str, from_sentence: int = 0
) -> AsyncIterator[dict[str, Any]]:
    """Yield SSE-shaped events for a job, starting from sentence index
    `from_sentence`. Replays anything already in the buffer with that
    index or higher, then waits on the job's condition for new events
    until status transitions to done/failed/cancelled.

    Multiple subscribers are supported — each gets the full event
    stream from their requested start point. The job's buffer is the
    single source of truth; we never lose events even across many
    reconnects."""
    job = _JOBS.get(job_id)
    if not job:
        yield {"type": "error", "message": f"unknown job {job_id}"}
        return

    cursor = from_sentence

    while True:
        # Replay anything in the buffer at-or-after the cursor.
        # Buffer is append-only and ordered by job's worker, so we can
        # scan linearly; for replays in the thousands this is still
        # fast (microseconds).
        while cursor < len(job.sentence_events):
            ev = job.sentence_events[cursor]
            # The worker only appends events with type=sentence to the
            # event buffer (result is handled separately below), so
            # cursor == event.index by construction.
            yield ev
            cursor += 1

        # If the job is done/failed/cancelled and we've drained the
        # buffer, emit the terminal event and stop.
        if job.status in ("done", "failed", "cancelled"):
            if job.status == "done" and job.mp3_bytes is not None:
                yield {
                    "type": "result",
                    "mp3_b64": base64.b64encode(job.mp3_bytes).decode(),
                    "sentence_offsets_ms": job.sentence_offsets_ms,
                    "audio_sha256": job.audio_sha256,
                }
            elif job.status == "failed":
                yield {
                    "type": "error",
                    "message": job.error or "synthesis failed",
                }
            elif job.status == "cancelled":
                yield {"type": "error", "message": "cancelled"}
            return

        # Otherwise wait for the worker to notify us of progress.
        async with job._condition:
            # Re-check inside the lock to avoid the lost-wakeup race.
            if (
                cursor < len(job.sentence_events)
                or job.status in ("done", "failed", "cancelled")
            ):
                continue
            await job._condition.wait()
