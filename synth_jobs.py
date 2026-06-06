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
    """Synth parameters frozen at job creation."""

    text: str
    voice_id: str
    rate: float
    volume: float
    speaker_id: int | None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> JobParams:
        return cls(
            text=str(d.get("text", "")),
            voice_id=str(d.get("voice_id", "")),
            rate=float(d.get("rate", 180)),
            volume=float(d.get("volume", 1.0)),
            speaker_id=(
                int(d["speaker_id"]) if d.get("speaker_id") is not None else None
            ),
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
        """Status snapshot the client polls."""
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


async def _run_worker(job: SynthJob) -> None:
    """The background worker. Iterates tts.synthesize_iter via the
    thread pool (Piper is sync), appending each event to the job's
    buffer + waking any subscribers."""
    loop = asyncio.get_running_loop()
    _DONE = object()
    job.status = "running"
    async with job._condition:
        job._condition.notify_all()
    try:
        try:
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
