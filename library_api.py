"""Server-side library REST endpoints (v221.sync-3).

Lives behind `/api/library/*`. Implements the API surface documented in
SYNC.md:

    GET    /api/library/sync/state         delta-sync support
    GET    /api/library/clips              summary list
    GET    /api/library/clips/{id}         full clip
    PUT    /api/library/clips/{id}         LWW upsert (+ optional audio_b64)
    DELETE /api/library/clips/{id}         soft delete
    GET    /api/library/audio/{sha256}.mp3 stream the bytes

    GET    /api/library/order              library order
    PUT    /api/library/order               (whole list, LWW)
    GET    /api/library/characters         roster
    PUT    /api/library/characters/{id}    single character upsert/LWW
    DELETE /api/library/characters/{id}
    GET    /api/library/presets
    PUT    /api/library/presets/{id}
    DELETE /api/library/presets/{id}
    GET    /api/library/settings           map of key → value
    PUT    /api/library/settings/{key}     LWW upsert

Authentication and tenant resolution happen in the parent app's
middleware (`require_api_key`). Every endpoint here pulls
`request.state.tenant_key` and scopes its queries by it; without a
tenant_key the middleware would have already 401'd. As of v221.tenants
the server is multi-tenant — two testers with different bearers see
two fully isolated libraries.

LWW (per-clip last-write-wins) rule from SYNC.md:

    - Each row carries a TEXT `updated_at` ISO8601 string.
    - PUT bodies MUST include `updated_at`.
    - If server.updated_at > client.updated_at  → 409 with server's row.
    - If equal → idempotent accept.
    - Otherwise → overwrite all fields.

Conflict status uses HTTP 409 with a body containing the server's
current state. The client is responsible for absorbing it and
surfacing a "Library updated on another device" status hint.
"""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import library_db


router = APIRouter(prefix="/api/library", tags=["library"])


# ──────────────────────────────────────────────────────────────────────
# Common helpers.
# ──────────────────────────────────────────────────────────────────────


def _require_enabled():
    """Convert the disabled-module state into a clean 503 so callers
    get a consistent error shape regardless of which endpoint hit it."""
    if not library_db.is_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "library sync disabled on this server: "
                f"{library_db.disabled_reason()}"
            ),
        )


def _tenant(request: Request) -> str:
    """The caller's tenant_key, stashed by `require_api_key` middleware.

    Belt-and-suspenders: the middleware always sets it before we get
    here (admin, tester, or local-dev fallthrough), so this should
    never raise. If it does, something is misconfigured — fail closed
    with 500 rather than silently scoping to ''.
    """
    tk = getattr(request.state, "tenant_key", None)
    if not tk:
        raise HTTPException(
            status_code=500,
            detail="tenant_key not resolved — auth middleware bug",
        )
    return tk


def _require_admin(request: Request) -> None:
    """Gate maintenance endpoints (and later, /api/admin/tenants) to the
    admin bearer. A tester key would let alpha users clear each other's
    maintenance banners, which is a small but real footgun."""
    if not getattr(request.state, "is_admin", False):
        raise HTTPException(
            status_code=403,
            detail="admin bearer required",
        )


# v224 (#495): defense-in-depth merge for the annotations column. If
# any client pushes a stale snapshot whose annotations array is missing
# entries the server already has, we DON'T accept that as a deletion —
# we keep the union of both. Annotations have stable client-generated
# ids; same-id entries take the newer side by `updatedAt`. Intent-
# explicit deletes use a `deletedAt` tombstone on the annotation
# itself, which survives the merge and is filtered from the GET
# response so the client never sees a "ghost" entry. This eliminates
# the entire LWW-wipe class of bug for annotations even if a future
# client code path forgets to preserve the array (the historical
# wipes from #488 / #493 / #494 would have been no-ops under this
# rule).
def _merge_annotations(
    incoming: list[dict] | None, stored_json: str | None
) -> list[dict]:
    stored = library_db.jsload(stored_json) or []
    by_id: dict[str, dict] = {}
    for a in stored:
        if isinstance(a, dict) and a.get("id") is not None:
            by_id[str(a["id"])] = a
    for inc in incoming or []:
        if not isinstance(inc, dict):
            continue
        aid = inc.get("id")
        if aid is None:
            # No id → can't merge safely; skip to avoid duplicating on
            # every push. Older client schemas without ids should be
            # migrated to id-bearing entries before sync.
            continue
        key = str(aid)
        existing = by_id.get(key)
        if existing is None:
            by_id[key] = inc
            continue
        inc_at = inc.get("updatedAt") or ""
        ex_at = existing.get("updatedAt") or ""
        # Ties + missing-on-either-side: incoming wins. Keeps behavior
        # compatible with older payloads that don't stamp updatedAt
        # per-annotation while still letting newer clients win edits.
        if inc_at >= ex_at:
            by_id[key] = inc
    return list(by_id.values())


# v225v4.0 (#810 / #586): merge for clip.lines on per-sentence-storage
# clips. Mirrors the annotations merge: per-line LWW by `updatedAt`,
# concurrent edits at different line IDs both land, deletes propagate
# only via explicit `deletedAt` tombstone on the line. ORDER preserved
# from the incoming payload because line order is itself meaningful
# (it's the reading order). If the client says nothing about lines
# (incoming is None), we keep the stored value unchanged — a sync
# from a downlevel client that doesn't know about lines must NOT wipe
# them on the server. This is the same defense-in-depth pattern that
# #495 added for annotations.
def _merge_lines(
    incoming: list[dict] | None, stored_json: str | None
) -> list[dict] | None:
    """Merge lines from an incoming payload with what's stored. Returns
    None when both sides are absent — the column stays NULL and the
    clip remains in the legacy blob model.

    Conflict policy: per-line LWW by `updatedAt`. Line identity is
    `id`. Lines without an id are dropped (can't merge safely).
    """
    stored = library_db.jsload(stored_json)
    if incoming is None and stored is None:
        return None
    # If only one side has lines, use that side's order verbatim.
    if incoming is None:
        return stored or []
    if stored is None:
        return [ln for ln in (incoming or []) if isinstance(ln, dict) and ln.get("id")]

    stored_by_id: dict[str, dict] = {}
    for ln in stored or []:
        if isinstance(ln, dict) and ln.get("id") is not None:
            stored_by_id[str(ln["id"])] = ln

    # Incoming order is authoritative for surviving lines (reading
    # order is part of the data). We walk the incoming list, merging
    # per-line; any stored lines NOT in the incoming payload are
    # appended at the end — they represent lines another device added
    # that this client didn't know about, and we want them to survive.
    seen: set[str] = set()
    merged: list[dict] = []
    for inc in incoming:
        if not isinstance(inc, dict):
            continue
        lid = inc.get("id")
        if lid is None:
            continue
        key = str(lid)
        seen.add(key)
        existing = stored_by_id.get(key)
        if existing is None:
            merged.append(inc)
            continue
        inc_at = inc.get("updatedAt") or ""
        ex_at = existing.get("updatedAt") or ""
        merged.append(inc if inc_at >= ex_at else existing)
    # Append lines that exist only on the server (other-device adds).
    for key, ln in stored_by_id.items():
        if key not in seen:
            merged.append(ln)
    return merged


def _row_to_clip_dict(row: sqlite3.Row) -> dict:
    """Convert a clips row into the JSON-friendly dict the frontend
    expects. JSON columns get parsed; deleted clips still include
    their tombstone so the sync layer can mirror the removal."""
    # v225v3.53 (#786): `kind` is schema v4. Guard for rows read before
    # the migration applied (shouldn't happen — _migrate runs at boot —
    # but cheap defensive check matches the annotations_json pattern).
    kind_val = row["kind"] if "kind" in row.keys() else None
    d = {
        "id": row["id"],
        "title": row["title"],
        "text": row["text"],
        "kind": kind_val,
        "voiceId": row["voice_id"],
        "voiceName": row["voice_name"],
        "rate": row["rate"],
        "volume": row["volume"],
        "speakerId": row["speaker_id"],
        "durationSec": row["duration_sec"],
        "progressSec": row["progress_sec"],
        "sentenceOffsetsSec": library_db.jsload(row["sentence_offsets_json"]) or [],
        "bookmarks": library_db.jsload(row["bookmarks_json"]) or [],
        "note": row["note"] or "",
        "notes": row["notes"] or "",
        "tags": library_db.jsload(row["tags_json"]) or [],
        "cover": library_db.jsload(row["cover_json"]),
        "gitRef": library_db.jsload(row["git_ref_json"]),
        "images": library_db.jsload(row["images_json"]) or [],
        # v223.annotate-1.5: annotations may be NULL on rows that
        # predate schema v3 — jsload(None) returns None, normalize to
        # an empty list so the client always sees an array.
        # v224 (#495): also filter out tombstoned annotations
        # (entries with a `deletedAt` field set). They live in storage
        # so the merge-on-PUT path can recognize them as authoritative
        # deletes, but the client should never see them — it's an
        # already-resolved deletion from its perspective.
        "annotations": [
            a for a in (library_db.jsload(
                row["annotations_json"] if "annotations_json" in row.keys() else None
            ) or [])
            if isinstance(a, dict) and not a.get("deletedAt")
        ],
        # v225v4.0 (#810): per-sentence storage. lines is omitted from
        # the response when the column is NULL — clients use the
        # presence of `lines` to detect "this clip is opted in." We
        # filter out tombstoned lines (deletedAt set) for the same
        # reason annotations do: storage keeps them so the merge can
        # recognize them as authoritative deletes, but the UI never
        # sees them.
        **(
            {
                "lines": [
                    ln for ln in (
                        library_db.jsload(
                            row["lines_json"] if "lines_json" in row.keys() else None
                        ) or []
                    )
                    if isinstance(ln, dict) and not ln.get("deletedAt")
                ],
                "nextLineSeq": row["next_line_seq"]
                if "next_line_seq" in row.keys() else None,
            }
            if "lines_json" in row.keys() and row["lines_json"] is not None
            else {}
        ),
        "synthOk": bool(row["synth_ok"]),
        "synthSilentSentenceCount": row["synth_silent_sentence_count"] or 0,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastSyncedAt": row["last_synced_at"],
        "audioSha256": row["audio_sha256"],
        "deleted": bool(row["deleted"]),
    }
    # Audio URL (clients fetch the bytes from this) — only emit when the
    # blob is actually present on disk so a stale row doesn't 404 the
    # client mid-listen. Path-traversal guarded by audio_path's regex.
    if row["audio_sha256"]:
        try:
            if library_db.audio_path(row["audio_sha256"]).exists():
                d["audioUrl"] = f"/api/library/audio/{row['audio_sha256']}.mp3"
        except ValueError:
            # Malformed sha somehow ended up in the row. Don't crash
            # the listing — just omit the URL.
            pass
    return d


# ──────────────────────────────────────────────────────────────────────
# Sync state — single endpoint covering all tables. Clients call this
# first on every library-render and use it to decide what to pull.
# ──────────────────────────────────────────────────────────────────────


# v223.tn10 (#475): server-side Whisper transcription. Browser
# SpeechRecognition can't reliably get the mic on Android Chrome
# while MediaRecorder is running (the mic-collision symptom: SR's
# audiostart fires but no audio samples arrive). The client falls
# back to this endpoint with the recorded blob; we run Whisper and
# return the transcript, which the client patches onto the
# annotation locally and pushes via /clips PUT in the usual sync
# flow.
class TranscribePayload(BaseModel):
    audioB64: str = ""
    mime: str = "audio/webm"


@router.post("/transcribe")
async def transcribe_voice_note(payload: TranscribePayload, request: Request):
    # Tenant-scoped so testers can't burn each other's quota on this
    # endpoint, even though there's no per-clip data being stored here
    # (the result rides back through /clips PUT from the client side).
    _tenant(request)
    if not payload.audioB64:
        return {"transcript": "", "lang": "", "durationSec": 0.0}
    try:
        audio_bytes = base64.b64decode(payload.audioB64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad base64: {e}")
    # 5MB cap protects against runaway uploads. 30s of opus at decent
    # bitrate is ~150KB; even a 5x safety margin lands well under 1MB.
    # If we ever raise the voice-note duration cap, revisit this.
    if len(audio_bytes) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="audio too large (max 5MB)")
    # faster-whisper is blocking + CPU-bound; run it in a thread so
    # we don't stall the event loop. Short memos finish in ~1-3s on
    # the shared Fly CPU, fine for fire-and-forget UX.
    import anyio
    import transcribe
    result = await anyio.to_thread.run_sync(
        transcribe.transcribe_bytes, audio_bytes
    )
    return result


@router.get("/sync/state")
def sync_state(request: Request):
    _require_enabled()
    tk = _tenant(request)
    c = library_db.conn()
    import datetime as _dt

    # Clip → updated_at map. Includes deleted=1 rows so the client can
    # mirror tombstones; client filters by deleted on its end.
    clip_map = {}
    for row in c.execute(
        "SELECT id, updated_at FROM clips WHERE tenant_key = ? ORDER BY updated_at",
        (tk,),
    ):
        clip_map[str(row["id"])] = row["updated_at"]

    def _max(table: str) -> str | None:
        r = c.execute(
            f"SELECT MAX(updated_at) AS m FROM {table} WHERE tenant_key = ?",
            (tk,),
        ).fetchone()
        return r["m"] if r and r["m"] else None

    return {
        "clips": clip_map,
        "library_order_updated_at": _max("library_order"),
        "characters_updated_at": _max("characters"),
        "presets_updated_at": _max("presets"),
        "settings_updated_at": _max("settings"),
        "server_now": _dt.datetime.utcnow().isoformat() + "Z",
    }


# ──────────────────────────────────────────────────────────────────────
# Clips CRUD.
# ──────────────────────────────────────────────────────────────────────


class ClipUpsert(BaseModel):
    """Client-side clip payload. Mirrors the IndexedDB shape.

    `audioB64` is optional — if set, the server stores the bytes under
    sha256(decoded) and records the sha on the row. If the client
    already knows the sha from a previous fetch (typical for a
    metadata-only update like a new bookmark), it can send
    `audioSha256` directly and omit the blob.
    """

    id: int
    title: str = ""
    text: str = ""
    # v225v3.53 (#786): `kind` distinguishes audio clips from ebook
    # clips (#690). NULL/missing = audio (legacy default); "ebook" =
    # text-only, no audio expected. Without this field ebook clips
    # sync but lose their kind tag and break book-view routing on
    # the receiving device.
    kind: str | None = None
    voiceId: str | None = None
    voiceName: str | None = None
    rate: int | None = None
    volume: float | None = None
    speakerId: int | None = None
    durationSec: float | None = None
    progressSec: float = 0
    sentenceOffsetsSec: list[float] = Field(default_factory=list)
    bookmarks: list[dict] = Field(default_factory=list)
    note: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    # v225v3.54 (#787): cover may be a dict ({src, alt} from custom
    # upload) OR a bare string URL (auto-detected ebook covers send
    # _pendingDetectedCover.src directly — see _openAsEbook). The
    # original `dict | None` declaration silently rejected every
    # ebook clip push with 422, which the client logged to console
    # and surfaced nowhere — looked like sync was working. Accept
    # both shapes; round-trip is handled via jsdump/jsload.
    cover: dict | str | None = None
    gitRef: dict | None = None
    images: list[dict] = Field(default_factory=list)
    # v223.annotate-1.5: phone-native revision annotations.
    # See STRATEGY.md "Phone-native annotation" section.
    annotations: list[dict] = Field(default_factory=list)
    # v225v4.0 (#810 / #586): Author-mode per-sentence storage. NULL on
    # legacy clips and on clips the user hasn't opted in; populated on
    # opt-in with [{id, text, hash, updatedAt, voiceOverride?}, ...].
    # When set, clip.text is a derived view (lines joined). When NULL,
    # blob model runs unchanged. See SENTENCE_IDS.md for the design.
    # Use None-vs-list distinction explicitly — an empty list means
    # "opted in but no lines" (shouldn't happen in practice, but it's
    # different from "not opted in"). Downlevel clients omit the field
    # entirely; the server preserves the stored value via _merge_lines.
    lines: list[dict] | None = None
    # Monotonic counter for minting new line IDs on this clip. Persists
    # across edits so deleted IDs are never reused. NULL when clip is
    # legacy; integer >=1 when lines is set.
    nextLineSeq: int | None = None
    synthOk: bool = True
    synthSilentSentenceCount: int = 0
    createdAt: str | None = None
    updatedAt: str = Field(..., min_length=1)
    lastSyncedAt: str | None = None
    audioSha256: str | None = None
    audioB64: str | None = None
    deleted: bool = False


@router.get("/clips")
def list_clips(request: Request, include_deleted: bool = False):
    _require_enabled()
    tk = _tenant(request)
    sql = "SELECT * FROM clips WHERE tenant_key = ?"
    if not include_deleted:
        sql += " AND deleted = 0"
    sql += " ORDER BY updated_at DESC"
    rows = library_db.conn().execute(sql, (tk,)).fetchall()
    return {"clips": [_row_to_clip_dict(r) for r in rows]}


@router.get("/clips/{clip_id}")
def get_clip(clip_id: int, request: Request):
    _require_enabled()
    tk = _tenant(request)
    row = library_db.conn().execute(
        "SELECT * FROM clips WHERE tenant_key = ? AND id = ?", (tk, clip_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="clip not found")
    return {"clip": _row_to_clip_dict(row)}


@router.put("/clips/{clip_id}")
def put_clip(clip_id: int, payload: ClipUpsert, request: Request):
    _require_enabled()
    tk = _tenant(request)
    if payload.id != clip_id:
        raise HTTPException(
            status_code=400, detail="payload.id must match URL path"
        )

    with library_db.write_lock():
        c = library_db.conn()
        existing = c.execute(
            "SELECT * FROM clips WHERE tenant_key = ? AND id = ?", (tk, clip_id)
        ).fetchone()

        if existing is not None:
            # LWW conflict check. We compare ISO strings lexically —
            # valid because the format is fixed-width-ish and sorts
            # correctly. If exactly equal → idempotent accept.
            if existing["updated_at"] > payload.updatedAt:
                return _conflict_response(existing)

        # v224 (#495): merge annotations with stored, never overwrite.
        # Even if the rest of the row goes through LWW replacement,
        # the annotations column merges by id. This protects against
        # stale-snapshot pushes silently wiping marks added on another
        # device. Deletes still propagate, but only when the client
        # sets an explicit `deletedAt` tombstone on the annotation.
        existing_annos_json = (
            existing["annotations_json"]
            if existing is not None and "annotations_json" in existing.keys()
            else None
        )
        merged_annotations = _merge_annotations(
            payload.annotations, existing_annos_json
        )

        # v225v4.0 (#810): same defense-in-depth merge for clip.lines.
        # If the incoming payload doesn't mention lines (downlevel
        # client), the stored value is preserved untouched — a v3.74
        # client mustn't wipe v4.0 sentence storage just by syncing.
        # The merge returns None when both sides are NULL (clip stays
        # in legacy blob model).
        existing_lines_json = (
            existing["lines_json"]
            if existing is not None and "lines_json" in existing.keys()
            else None
        )
        merged_lines = _merge_lines(payload.lines, existing_lines_json)
        # next_line_seq is monotonic: take max(incoming, existing). A
        # downlevel client sending nextLineSeq=None must not reset the
        # stored counter to NULL when the clip is opted in.
        existing_seq = (
            existing["next_line_seq"]
            if existing is not None and "next_line_seq" in existing.keys()
            else None
        )
        candidates = [v for v in (payload.nextLineSeq, existing_seq) if v is not None]
        merged_next_line_seq = max(candidates) if candidates else None

        # Decode + store audio if a blob came along, OR validate the
        # sha if the client only sent the reference.
        audio_sha = payload.audioSha256
        if payload.audioB64:
            try:
                blob = base64.b64decode(payload.audioB64, validate=True)
            except Exception as e:
                raise HTTPException(
                    status_code=400, detail=f"audioB64 not valid base64: {e}"
                )
            audio_sha = library_db.store_audio(blob)
        elif audio_sha is not None:
            # Sha-only update — the client claims the audio is already
            # on the server. Verify the blob actually exists so we
            # don't end up with a dangling reference.
            try:
                if not library_db.audio_path(audio_sha).exists():
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"audioSha256 {audio_sha[:8]}… not on server; "
                            "include audioB64 to upload the blob"
                        ),
                    )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        # UPSERT. SQLite's ON CONFLICT DO UPDATE keeps this atomic.
        # The PRIMARY KEY is (tenant_key, id) so the conflict target
        # has to name both columns — same row in same tenant updates,
        # same id under another tenant is a different row.
        # v225v4.0 (#810): lines_json is NULL for legacy clips; persisted
        # JSON when opted in. jsdump(None) returns None (not "null"),
        # so the column stays SQL NULL — matches the migration's default
        # and lets _row_to_clip_dict suppress the field in responses.
        lines_json_value = (
            library_db.jsdump(merged_lines) if merged_lines is not None else None
        )

        c.execute(
            """
            INSERT INTO clips (
              tenant_key,
              id, title, text, kind, voice_id, voice_name, rate, volume,
              speaker_id, duration_sec, progress_sec,
              sentence_offsets_json, bookmarks_json, note, notes,
              tags_json, cover_json, git_ref_json, audio_sha256,
              images_json, annotations_json,
              lines_json, next_line_seq,
              synth_ok, synth_silent_sentence_count,
              created_at, updated_at, last_synced_at, deleted
            ) VALUES (
              ?,
              ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?, ?, ?
            )
            ON CONFLICT(tenant_key, id) DO UPDATE SET
              title=excluded.title,
              text=excluded.text,
              kind=excluded.kind,
              voice_id=excluded.voice_id,
              voice_name=excluded.voice_name,
              rate=excluded.rate,
              volume=excluded.volume,
              speaker_id=excluded.speaker_id,
              duration_sec=excluded.duration_sec,
              progress_sec=excluded.progress_sec,
              sentence_offsets_json=excluded.sentence_offsets_json,
              bookmarks_json=excluded.bookmarks_json,
              note=excluded.note,
              notes=excluded.notes,
              tags_json=excluded.tags_json,
              cover_json=excluded.cover_json,
              git_ref_json=excluded.git_ref_json,
              audio_sha256=excluded.audio_sha256,
              images_json=excluded.images_json,
              annotations_json=excluded.annotations_json,
              lines_json=excluded.lines_json,
              next_line_seq=excluded.next_line_seq,
              synth_ok=excluded.synth_ok,
              synth_silent_sentence_count=excluded.synth_silent_sentence_count,
              created_at=excluded.created_at,
              updated_at=excluded.updated_at,
              last_synced_at=excluded.last_synced_at,
              deleted=excluded.deleted
            """,
            (
                tk,
                payload.id,
                payload.title,
                payload.text,
                payload.kind,
                payload.voiceId,
                payload.voiceName,
                payload.rate,
                payload.volume,
                payload.speakerId,
                payload.durationSec,
                payload.progressSec,
                library_db.jsdump(payload.sentenceOffsetsSec),
                library_db.jsdump(payload.bookmarks),
                payload.note,
                payload.notes,
                library_db.jsdump(payload.tags),
                library_db.jsdump(payload.cover),
                library_db.jsdump(payload.gitRef),
                audio_sha,
                library_db.jsdump(payload.images),
                library_db.jsdump(merged_annotations),
                lines_json_value,
                merged_next_line_seq,
                int(payload.synthOk),
                payload.synthSilentSentenceCount,
                payload.createdAt or payload.updatedAt,
                payload.updatedAt,
                payload.lastSyncedAt,
                int(payload.deleted),
            ),
        )

        row = c.execute(
            "SELECT * FROM clips WHERE tenant_key = ? AND id = ?", (tk, clip_id)
        ).fetchone()
        return {"clip": _row_to_clip_dict(row)}


@router.delete("/clips/{clip_id}")
def delete_clip(clip_id: int, updated_at: str, request: Request):
    """Soft-delete via setting deleted=1 + bumping updated_at. The
    `updated_at` query param is the client's wall-clock at delete
    time — same LWW rule as PUT."""
    _require_enabled()
    tk = _tenant(request)
    with library_db.write_lock():
        c = library_db.conn()
        existing = c.execute(
            "SELECT updated_at FROM clips WHERE tenant_key = ? AND id = ?",
            (tk, clip_id),
        ).fetchone()
        if existing is None:
            # Idempotent: deleting a non-existent clip is fine.
            return {"ok": True, "deleted": False}
        if existing["updated_at"] > updated_at:
            full = c.execute(
                "SELECT * FROM clips WHERE tenant_key = ? AND id = ?",
                (tk, clip_id),
            ).fetchone()
            return _conflict_response(full)
        c.execute(
            "UPDATE clips SET deleted = 1, updated_at = ? "
            "WHERE tenant_key = ? AND id = ?",
            (updated_at, tk, clip_id),
        )
        return {"ok": True, "deleted": True}


def _conflict_response(server_row: sqlite3.Row):
    """Build the 409 body the client absorbs."""
    raise HTTPException(
        status_code=409,
        detail={
            "reason": "stale_client_update",
            "server_clip": _row_to_clip_dict(server_row),
        },
    )


# ──────────────────────────────────────────────────────────────────────
# Audio streaming. Content-addressed by sha256 so URLs are immutable
# and infinitely cacheable.
#
# Multi-tenant note: this endpoint deliberately does NOT scope by
# tenant_key. The sha is a 256-bit random handle — a tester can only
# learn a sha that's in their own clip rows (they never see another
# tenant's row). Guessing an unknown sha is computationally infeasible
# (~2^128 work). Adding tenant filtering would require an extra SELECT
# `clips WHERE audio_sha256 = ? AND tenant_key = ?` on every audio
# fetch — a meaningful per-listen cost, for a defense layer that's
# equivalent to "guess SHA-256." We accept that and move on.
# ──────────────────────────────────────────────────────────────────────


@router.get("/audio/{sha256}.mp3")
def stream_audio(sha256: str):
    _require_enabled()
    try:
        p = library_db.audio_path(sha256)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not p.exists():
        raise HTTPException(status_code=404, detail="audio blob not found")
    return FileResponse(
        path=str(p),
        media_type="audio/mpeg",
        headers={
            # Content-addressed → can never change for this URL → cache
            # forever. Saves the client a HEAD on every play.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ──────────────────────────────────────────────────────────────────────
# Per-sentence WAV cache (Phase B / #811 / schema v6).
#
# Spike shape (B.2): the client uploads a per-sentence WAV after synth.
# The server encodes to FLAC, content-addresses it under
# /data/sentences/, and records a row in sentence_audio keyed by
# (tenant_key, clip_id, line_id). The clean partial-re-narrate path
# (B.3) reads these rows to re-stitch the combined MP3 with no seam
# artifact.
#
# This is the SPIKE path. The synth pipeline doesn't write to this
# cache transparently yet — synth_jobs.py has no notion of clip_id or
# line_id. That hook is a separate sub-ticket (B.2b) once the spike
# validates the audio quality. For now, the client uploads each
# sentence as it receives it over the SSE stream.
#
# Endpoint requires the clip to be opted into per-line storage
# (lines_json != null AND line_id present in lines). Refusing to
# cache for legacy clips is intentional — splice.py is the path for
# them. See docs/phase-b-design.md for the full design.
# ──────────────────────────────────────────────────────────────────────


@router.post("/clips/{clip_id}/lines/{line_id}/audio")
async def upload_sentence_audio(
    clip_id: int,
    line_id: str,
    request: Request,
    voice_id: str | None = None,
    speaker_id: int | None = None,
    rate: int | None = None,
):
    """Upload a per-sentence WAV. Body is raw WAV bytes (16-bit PCM).

    Optional query params let the caller override the voice/speaker/rate
    recorded with this cache entry — useful for partial re-narrate
    flows where the sentence was synthed with a different voice than
    the clip's default. Otherwise the clip's default voice settings
    are recorded.

    Returns: {ok: true, sha256, duration_ms, bytes_in, bytes_out}.
    """
    _require_enabled()
    tk = _tenant(request)

    # Validate the clip exists, isn't deleted, and is opted into per-
    # line storage. Pull clip defaults too so we can record them when
    # the caller doesn't override.
    row = library_db.conn().execute(
        """
        SELECT lines_json, voice_id, speaker_id, rate
        FROM clips
        WHERE tenant_key = ? AND id = ? AND deleted = 0
        """,
        (tk, clip_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="clip not found")
    lines = library_db.jsload(row["lines_json"]) or []
    if not lines:
        raise HTTPException(
            status_code=409,
            detail=(
                "clip not opted into per-line storage "
                "(lines_json is empty); use splice.py path instead"
            ),
        )
    if not any(isinstance(l, dict) and l.get("id") == line_id for l in lines):
        raise HTTPException(
            status_code=404,
            detail=f"line_id {line_id!r} not present in clip's lines",
        )

    # Read the WAV body. Cap at 10 MB to bound memory — a 30s sentence
    # at 22kHz 16-bit mono is ~1.3 MB, so anything over 10 MB is either
    # an attack or someone uploading a chapter instead of a sentence.
    MAX_WAV_BYTES = 10 * 1024 * 1024
    wav_bytes = await request.body()
    if not wav_bytes:
        raise HTTPException(status_code=400, detail="empty body")
    if len(wav_bytes) > MAX_WAV_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"WAV too large: {len(wav_bytes)} > {MAX_WAV_BYTES} bytes",
        )

    # Validate + encode. wav_duration_ms reads the header (cheap);
    # wav_to_flac shells out to ffmpeg. Both raise on malformed input.
    # tts.encode is imported lazily so the rest of library_api stays
    # ffmpeg-free at module load.
    try:
        from tts.encode import FlacEncodeError, wav_duration_ms, wav_to_flac
    except ImportError as e:
        raise HTTPException(
            status_code=500, detail=f"FLAC encoder unavailable: {e}"
        )

    try:
        dur_ms = wav_duration_ms(wav_bytes)
    except (ValueError, Exception) as e:
        raise HTTPException(
            status_code=400, detail=f"invalid WAV header: {e}"
        )

    try:
        flac_bytes = wav_to_flac(wav_bytes)
    except FlacEncodeError as e:
        raise HTTPException(
            status_code=500, detail=f"FLAC encode failed: {e}"
        )

    # Store the file + record the row. store_sentence_audio is
    # idempotent on content — if the same sentence/voice combo was
    # uploaded before, the existing file is reused. record is an
    # UPSERT keyed by (tenant, clip, line) so re-uploads overwrite.
    sha = library_db.store_sentence_audio(flac_bytes)
    library_db.record_sentence_audio(
        tk, clip_id, line_id,
        audio_sha256=sha,
        voice_id=voice_id if voice_id is not None else row["voice_id"],
        speaker_id=(
            speaker_id if speaker_id is not None else row["speaker_id"]
        ),
        rate=rate if rate is not None else row["rate"],
        duration_ms=dur_ms,
    )

    return {
        "ok": True,
        "sha256": sha,
        "duration_ms": dur_ms,
        "bytes_in": len(wav_bytes),
        "bytes_out": len(flac_bytes),
    }


@router.post("/clips/{clip_id}/restitch")
async def restitch_clip_audio(clip_id: int, request: Request):
    """Re-stitch the combined MP3 from cached per-sentence FLACs (B.3).

    Reads sentence_audio rows for this clip, orders them by the
    clip's lines_json, concats the FLACs via ffmpeg, encodes to MP3,
    writes the new combined audio to /data/audio/<sha>.mp3, and
    UPDATEs the clip row's audio_sha256 + duration_sec +
    sentence_offsets_json.

    Returns 409 with reason="backfill_required" if any line is
    missing from the cache. The spike refuses to re-stitch from
    partial coverage — backfill (B.5) is the path that fills the
    gap. For the spike, callers test against a clip where all lines
    have been uploaded via the upload endpoint first.

    Body: empty (POST with no payload).
    Returns: {ok, audio_sha256, duration_sec, sentence_offsets_ms,
              bytes_out, lines_count}.
    """
    _require_enabled()
    tk = _tenant(request)

    # Pull clip lines + current updated_at (for the LWW write below).
    row = library_db.conn().execute(
        """
        SELECT lines_json, updated_at
        FROM clips
        WHERE tenant_key = ? AND id = ? AND deleted = 0
        """,
        (tk, clip_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="clip not found")
    lines = library_db.jsload(row["lines_json"]) or []
    if not lines:
        raise HTTPException(
            status_code=409,
            detail=(
                "clip not opted into per-line storage; nothing to "
                "restitch"
            ),
        )

    # Walk lines_json in order to get the canonical line_id sequence.
    # Drop dict-shape outliers defensively (a malformed line shouldn't
    # crash restitch — surface the error explicitly).
    ordered_line_ids: list[str] = []
    for ln in lines:
        if not isinstance(ln, dict):
            continue
        lid = ln.get("id")
        if isinstance(lid, str) and lid:
            ordered_line_ids.append(lid)
    if not ordered_line_ids:
        raise HTTPException(
            status_code=409,
            detail="clip's lines_json contains no usable line ids",
        )

    # Look up cache rows for this clip → map line_id → sha.
    cache_rows = library_db.list_sentence_audio_for_clip(tk, clip_id)
    sha_by_line: dict[str, str] = {}
    for r in cache_rows:
        sha_by_line[r["line_id"]] = r["audio_sha256"]

    # Verify full coverage before doing any work. Partial coverage
    # means the user opted in mid-stream or migrated an existing
    # clip — both require backfill (B.5).
    missing = [lid for lid in ordered_line_ids if lid not in sha_by_line]
    if missing:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "backfill_required",
                "missing_line_ids": missing[:20],   # cap for response size
                "missing_count": len(missing),
                "total_lines": len(ordered_line_ids),
                "hint": (
                    "upload per-sentence WAVs via "
                    "POST /api/library/clips/{id}/lines/{line_id}/audio "
                    "for all missing lines before restitch"
                ),
            },
        )

    # Build a line_id → row map so we can pull durations alongside
    # sha resolution. The duration_ms column is authoritative — it was
    # written from the source WAV header at upload time, no ffprobe
    # round trip needed.
    row_by_line: dict[str, dict] = {r["line_id"]: r for r in cache_rows}

    # Resolve sha → on-disk FLAC paths + durations. sentence_audio_path
    # validates the sha format; if a row exists but the file was GC'd
    # or never written, .exists() catches it before ffmpeg sees a bad
    # path.
    items: list[tuple] = []
    total_dur_ms = 0
    for lid in ordered_line_ids:
        r = row_by_line[lid]
        sha = r["audio_sha256"]
        try:
            p = library_db.sentence_audio_path(sha)
        except ValueError as e:
            raise HTTPException(
                status_code=500,
                detail=f"cache row {lid} has invalid sha256: {e}",
            )
        if not p.exists():
            # Row points to a missing file → cache integrity bug.
            # Surface clearly rather than letting ffmpeg fail with a
            # less informative error.
            raise HTTPException(
                status_code=500,
                detail=(
                    f"cache integrity: row for line {lid!r} references "
                    f"sha {sha[:12]}... but file is missing"
                ),
            )
        dur_ms = int(r["duration_ms"])
        items.append((p, dur_ms))
        total_dur_ms += dur_ms

    # Lazy-import restitch so library_api stays ffmpeg-free at module
    # load. Same pattern as the FLAC encoder in upload_sentence_audio.
    try:
        from tts.restitch import RestitchError, restitch_clip
    except ImportError as e:
        raise HTTPException(
            status_code=500, detail=f"restitch helper unavailable: {e}"
        )

    try:
        mp3_bytes, offsets_ms = restitch_clip(items)
    except RestitchError as e:
        raise HTTPException(
            status_code=500, detail=f"restitch failed: {e}"
        )

    # Store the combined MP3 (content-addressed → dedup on identical
    # re-stitches comes for free) and update the clip row.
    new_sha = library_db.store_audio(mp3_bytes)
    duration_sec = total_dur_ms / 1000.0

    now = library_db._iso_now()
    with library_db.write_lock():
        library_db.conn().execute(
            """
            UPDATE clips
            SET audio_sha256 = ?,
                duration_sec = ?,
                sentence_offsets_json = ?,
                updated_at = ?
            WHERE tenant_key = ? AND id = ?
            """,
            (
                new_sha,
                duration_sec,
                library_db.jsdump(offsets_ms),
                now,
                tk, clip_id,
            ),
        )
        library_db.conn().commit()

    return {
        "ok": True,
        "audio_sha256": new_sha,
        "duration_sec": duration_sec,
        "sentence_offsets_ms": offsets_ms,
        "bytes_out": len(mp3_bytes),
        "lines_count": len(ordered_line_ids),
        "updated_at": now,
    }


# ──────────────────────────────────────────────────────────────────────
# Library order — stored as an ordered list, replaced wholesale on PUT.
# ──────────────────────────────────────────────────────────────────────


class LibraryOrder(BaseModel):
    order: list[int]
    updatedAt: str = Field(..., min_length=1)


@router.get("/order")
def get_order(request: Request):
    _require_enabled()
    tk = _tenant(request)
    rows = library_db.conn().execute(
        "SELECT clip_id FROM library_order WHERE tenant_key = ? "
        "ORDER BY position",
        (tk,),
    ).fetchall()
    return {"order": [r["clip_id"] for r in rows]}


@router.put("/order")
def put_order(payload: LibraryOrder, request: Request):
    _require_enabled()
    tk = _tenant(request)
    with library_db.write_lock():
        c = library_db.conn()
        # Whole-list replace, scoped to this tenant — other tenants'
        # orderings are untouched. Wrap in a transaction so a mid-
        # replace crash leaves the previous order intact rather than
        # half-applied.
        c.execute("BEGIN")
        try:
            c.execute(
                "DELETE FROM library_order WHERE tenant_key = ?", (tk,)
            )
            for pos, clip_id in enumerate(payload.order):
                c.execute(
                    "INSERT INTO library_order"
                    "(tenant_key, position, clip_id, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    (tk, pos, clip_id, payload.updatedAt),
                )
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    return {"ok": True, "count": len(payload.order)}


# ──────────────────────────────────────────────────────────────────────
# Characters + presets — per-row LWW, soft delete.
# ──────────────────────────────────────────────────────────────────────


class CharacterUpsert(BaseModel):
    id: str = Field(..., min_length=1)
    name: str
    voiceId: str | None = None
    speakerId: int | None = None
    gender: str | None = None
    color: str | None = None
    updatedAt: str = Field(..., min_length=1)
    deleted: bool = False


@router.get("/characters")
def list_characters(request: Request, include_deleted: bool = False):
    _require_enabled()
    tk = _tenant(request)
    sql = "SELECT * FROM characters WHERE tenant_key = ?"
    if not include_deleted:
        sql += " AND deleted = 0"
    sql += " ORDER BY name"
    rows = library_db.conn().execute(sql, (tk,)).fetchall()
    return {
        "characters": [
            {
                "id": r["id"],
                "name": r["name"],
                "voiceId": r["voice_id"],
                "speakerId": r["speaker_id"],
                "gender": r["gender"],
                "color": r["color"],
                "updatedAt": r["updated_at"],
                "deleted": bool(r["deleted"]),
            }
            for r in rows
        ]
    }


@router.put("/characters/{char_id}")
def put_character(char_id: str, payload: CharacterUpsert, request: Request):
    _require_enabled()
    tk = _tenant(request)
    if payload.id != char_id:
        raise HTTPException(
            status_code=400, detail="payload.id must match URL path"
        )
    with library_db.write_lock():
        c = library_db.conn()
        existing = c.execute(
            "SELECT updated_at FROM characters WHERE tenant_key = ? AND id = ?",
            (tk, char_id),
        ).fetchone()
        if existing and existing["updated_at"] > payload.updatedAt:
            full = c.execute(
                "SELECT * FROM characters WHERE tenant_key = ? AND id = ?",
                (tk, char_id),
            ).fetchone()
            raise HTTPException(
                status_code=409,
                detail={
                    "reason": "stale_client_update",
                    "server_character": {
                        "id": full["id"],
                        "name": full["name"],
                        "voiceId": full["voice_id"],
                        "speakerId": full["speaker_id"],
                        "gender": full["gender"],
                        "color": full["color"],
                        "updatedAt": full["updated_at"],
                        "deleted": bool(full["deleted"]),
                    },
                },
            )
        c.execute(
            """
            INSERT INTO characters
              (tenant_key, id, name, voice_id, speaker_id, gender, color,
               updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_key, id) DO UPDATE SET
              name=excluded.name,
              voice_id=excluded.voice_id,
              speaker_id=excluded.speaker_id,
              gender=excluded.gender,
              color=excluded.color,
              updated_at=excluded.updated_at,
              deleted=excluded.deleted
            """,
            (
                tk,
                payload.id, payload.name, payload.voiceId, payload.speakerId,
                payload.gender, payload.color, payload.updatedAt,
                int(payload.deleted),
            ),
        )
    return {"ok": True}


@router.delete("/characters/{char_id}")
def delete_character(char_id: str, updated_at: str, request: Request):
    _require_enabled()
    tk = _tenant(request)
    with library_db.write_lock():
        c = library_db.conn()
        c.execute(
            "UPDATE characters SET deleted = 1, updated_at = ? "
            "WHERE tenant_key = ? AND id = ?",
            (updated_at, tk, char_id),
        )
    return {"ok": True}


class PresetUpsert(BaseModel):
    id: str = Field(..., min_length=1)
    name: str | None = None
    voiceId: str | None = None
    rate: int | None = None
    volume: float | None = None
    speakerId: int | None = None
    updatedAt: str = Field(..., min_length=1)
    deleted: bool = False


@router.get("/presets")
def list_presets(request: Request, include_deleted: bool = False):
    _require_enabled()
    tk = _tenant(request)
    sql = "SELECT * FROM presets WHERE tenant_key = ?"
    if not include_deleted:
        sql += " AND deleted = 0"
    sql += " ORDER BY name"
    rows = library_db.conn().execute(sql, (tk,)).fetchall()
    return {
        "presets": [
            {
                "id": r["id"],
                "name": r["name"],
                "voiceId": r["voice_id"],
                "rate": r["rate"],
                "volume": r["volume"],
                "speakerId": r["speaker_id"],
                "updatedAt": r["updated_at"],
                "deleted": bool(r["deleted"]),
            }
            for r in rows
        ]
    }


@router.put("/presets/{preset_id}")
def put_preset(preset_id: str, payload: PresetUpsert, request: Request):
    _require_enabled()
    tk = _tenant(request)
    if payload.id != preset_id:
        raise HTTPException(
            status_code=400, detail="payload.id must match URL path"
        )
    with library_db.write_lock():
        c = library_db.conn()
        existing = c.execute(
            "SELECT updated_at FROM presets WHERE tenant_key = ? AND id = ?",
            (tk, preset_id),
        ).fetchone()
        if existing and existing["updated_at"] > payload.updatedAt:
            full = c.execute(
                "SELECT * FROM presets WHERE tenant_key = ? AND id = ?",
                (tk, preset_id),
            ).fetchone()
            raise HTTPException(
                status_code=409,
                detail={
                    "reason": "stale_client_update",
                    "server_preset": {
                        "id": full["id"],
                        "name": full["name"],
                        "voiceId": full["voice_id"],
                        "rate": full["rate"],
                        "volume": full["volume"],
                        "speakerId": full["speaker_id"],
                        "updatedAt": full["updated_at"],
                        "deleted": bool(full["deleted"]),
                    },
                },
            )
        c.execute(
            """
            INSERT INTO presets
              (tenant_key, id, name, voice_id, rate, volume, speaker_id,
               updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_key, id) DO UPDATE SET
              name=excluded.name,
              voice_id=excluded.voice_id,
              rate=excluded.rate,
              volume=excluded.volume,
              speaker_id=excluded.speaker_id,
              updated_at=excluded.updated_at,
              deleted=excluded.deleted
            """,
            (
                tk,
                payload.id, payload.name, payload.voiceId, payload.rate,
                payload.volume, payload.speakerId, payload.updatedAt,
                int(payload.deleted),
            ),
        )
    return {"ok": True}


@router.delete("/presets/{preset_id}")
def delete_preset(preset_id: str, updated_at: str, request: Request):
    _require_enabled()
    tk = _tenant(request)
    with library_db.write_lock():
        c = library_db.conn()
        c.execute(
            "UPDATE presets SET deleted = 1, updated_at = ? "
            "WHERE tenant_key = ? AND id = ?",
            (updated_at, tk, preset_id),
        )
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────
# Settings (portable preferences: theme, skip interval, book-view font).
# ──────────────────────────────────────────────────────────────────────


class SettingUpsert(BaseModel):
    value: Any
    updatedAt: str = Field(..., min_length=1)


@router.get("/settings")
def list_settings(request: Request):
    _require_enabled()
    tk = _tenant(request)
    rows = library_db.conn().execute(
        "SELECT key, value, updated_at FROM settings WHERE tenant_key = ?",
        (tk,),
    ).fetchall()
    return {
        "settings": {
            r["key"]: {
                "value": library_db.jsload(r["value"]),
                "updatedAt": r["updated_at"],
            }
            for r in rows
        }
    }


@router.put("/settings/{key}")
def put_setting(key: str, payload: SettingUpsert, request: Request):
    _require_enabled()
    tk = _tenant(request)
    with library_db.write_lock():
        c = library_db.conn()
        existing = c.execute(
            "SELECT updated_at FROM settings WHERE tenant_key = ? AND key = ?",
            (tk, key),
        ).fetchone()
        if existing and existing["updated_at"] > payload.updatedAt:
            full = c.execute(
                "SELECT key, value, updated_at FROM settings "
                "WHERE tenant_key = ? AND key = ?",
                (tk, key),
            ).fetchone()
            raise HTTPException(
                status_code=409,
                detail={
                    "reason": "stale_client_update",
                    "server_setting": {
                        "key": full["key"],
                        "value": library_db.jsload(full["value"]),
                        "updatedAt": full["updated_at"],
                    },
                },
            )
        c.execute(
            """
            INSERT INTO settings(tenant_key, key, value, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(tenant_key, key) DO UPDATE SET
              value=excluded.value,
              updated_at=excluded.updated_at
            """,
            (tk, key, library_db.jsdump(payload.value), payload.updatedAt),
        )
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────
# v221.maint: maintenance warning. A small JSON blob on the volume
# tells clients about a scheduled downtime window. Clients poll, show
# a sticky banner, vanish when endsAt passes.
#
# Storage is a single file rather than a SQLite row because:
#   - Only one window can be active at a time anyway
#   - It's editable via `fly ssh` with a one-line echo (no SQL knowledge)
#   - Schema changes here don't trigger DB migrations
#
# Multi-tenant note: maintenance is GLOBAL — when the admin schedules
# downtime, every tenant sees the banner. GET is open to all authed
# tenants (they need to see the warning). POST and DELETE are
# admin-only — testers shouldn't be able to schedule or clear
# maintenance on each other's behalf.
# ──────────────────────────────────────────────────────────────────────


def _maintenance_file() -> Path:
    return library_db.DATA_DIR / "maintenance.json"


class MaintenanceWindow(BaseModel):
    """Admin-set warning. All fields optional from the client side; we
    fill defaults on save. `message` is required to be non-empty."""

    message: str = Field(..., min_length=1, max_length=500)
    startsAt: str  # ISO 8601 with Z, e.g. "2026-05-31T18:30:00Z"
    endsAt: str    # same


@router.get("/maintenance")
def get_maintenance():
    """Read the current maintenance window, or an empty object if none.

    Auth is the same as every other /api/* endpoint — clients hold the
    key, no carve-out needed. If the volume isn't enabled we still
    return {} so the frontend can degrade silently rather than show a
    "sync broken" red banner.
    """
    if not library_db.is_enabled():
        return {}
    f = _maintenance_file()
    if not f.exists():
        return {}
    try:
        import json
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}


@router.post("/maintenance")
def set_maintenance(window: MaintenanceWindow, request: Request):
    """Schedule a maintenance window. Overwrites the previous one.
    Admin only — testers can't schedule downtime for the cohort."""
    _require_enabled()
    _require_admin(request)
    import json

    payload = {
        "message": window.message.strip(),
        "startsAt": window.startsAt,
        "endsAt": window.endsAt,
    }
    f = _maintenance_file()
    # Atomic write so a concurrent GET never reads a half-written file.
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(f)
    return {"ok": True, "window": payload}


@router.delete("/maintenance")
def clear_maintenance(request: Request):
    """Remove the active maintenance window so the banner disappears.
    Admin only."""
    _require_enabled()
    _require_admin(request)
    f = _maintenance_file()
    try:
        f.unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True}
