# Phase B — per-sentence WAV cache + partial re-narrate (#811)

Design captured 2026-06-06 at start of work. Locks in the decisions
that shape the schema migration so we don't have to re-derive them
mid-spike.

Companion to #810 (Phase A — text-only per-sentence storage, shipped
in schema v5 as `clips.lines_json` + `clips.next_line_seq`).

## What this replaces

Today's partial-re-narrate path is `tts/splice.py` — ffmpeg `atrim`
+ concat on the combined MP3. Fast (~1-3s per edit) but produces a
faint crossfade artifact at the cut points. The header comment on
splice.py explicitly says: *"Option B (per-sentence WAV storage)
eliminates the seam entirely but requires a schema migration, so it
ships later (#586)."* This is that migration.

Phase B doesn't delete splice.py. It becomes the path for clips that
**haven't** opted into per-line storage. For opted-in clips, the new
path is: synthesize one sentence → swap cache entry → re-stitch the
whole MP3 from the cache. Clean concat, no seam.

## Locked decisions

- **Storage format:** FLAC. Lossless, ~50% smaller than raw PCM,
  ffmpeg already in the Docker image.
- **Cross-device sync:** server-only. Clients never see sentence
  WAVs. Partial re-narrate is a server-triggered operation. The
  client receives the new combined MP3 the same way it does today.
- **Cache key:** `(tenant_key, clip_id, line_id)` where `line_id`
  is the stable Phase A ID. Indexed by position would invalidate the
  cache on every insertion; line_id is birth-ordered and never reused.
- **File layout:** content-addressed by sha256. Mirrors the existing
  `/data/audio/<sha>.mp3` pattern. Identical sentences (same text +
  voice + speaker + rate) dedup across clips automatically.
- **Backfill:** lazy + on-demand for existing clips. The B.5 endpoint
  handles this in a later session; the spike just makes new
  synthesis populate the cache.
- **Scope of spike (option b):** B.1 + B.2 + B.3 only. Single test
  clip end-to-end. Verify the seam-free output sounds clean before
  investing in backfill (B.5) and UI (B.7).

## Schema v6

```sql
CREATE TABLE sentence_audio (
  tenant_key TEXT NOT NULL,
  clip_id INTEGER NOT NULL,
  line_id TEXT NOT NULL,             -- stable Phase A ID, "c_{clip_id}-{seq:04d}"
  audio_sha256 TEXT NOT NULL,        -- → /data/sentences/<sha>.flac
  voice_id TEXT,                     -- voice this sentence was synthed with
  speaker_id INTEGER,
  rate INTEGER,
  duration_ms INTEGER NOT NULL,      -- pre-computed so re-stitch doesn't reopen files
  created_at TEXT NOT NULL,          -- ISO8601 wall-clock
  PRIMARY KEY (tenant_key, clip_id, line_id)
);

CREATE INDEX idx_sentence_audio_sha ON sentence_audio(audio_sha256);
CREATE INDEX idx_sentence_audio_clip ON sentence_audio(tenant_key, clip_id);
```

Notes:

- Additive only — no ALTERs to `clips`. The `audio_sha256` column on
  `clips` keeps pointing at the combined MP3 just like today.
- No `deleted` flag — sentence cache entries are tied to a clip; when
  the clip is soft-deleted, GC sweeps these.
- The index by `audio_sha256` lets us answer "how many references
  does this file have?" before deletion. Same pattern as audio GC.

## File layout

```
/data/
├── audio/<sha>.mp3                    — combined clip MP3 (existing)
└── sentences/<sha>.flac               — per-sentence FLAC (new)
```

GC runs on both. Mirror `gc_orphan_audio` → `gc_orphan_sentence_audio`.

## Synth pipeline integration (B.2)

The per-sentence WAVs already flow through the server side — the SSE
stream sends each one to the client as a separate event. Phase B
catches them on the server and writes to cache when the clip has
opted into per-line storage.

Hook point: in `server.py`'s `/api/synth/jobs/{id}/stream` (or
wherever the engine yield is consumed). Check
`clip.lines_json is not None`. If yes, for each yielded `(line_id,
wav_bytes)`:

```python
sha, duration_ms = save_sentence_audio(wav_bytes)  # WAV → FLAC + file write
record_sentence_audio(
    tenant_key, clip_id, line_id, sha,
    voice_id, speaker_id, rate, duration_ms,
)
```

For non-opted-in clips: no change. The path stays untouched.

## Partial re-narrate endpoint (B.3)

```
POST /api/library/clips/{clip_id}/lines/{line_id}/renarrate
Body: {
  voice_id?: string,      // optional override; defaults to clip voice
  speaker_id?: int,
  rate?: int,
  persist_override?: bool  // if true, write voiceOverride into lines_json
}

Returns: {
  ok: true,
  audio_sha256: string,        // new combined MP3 sha
  duration_sec: float,
  sentence_offsets_ms: int[],
  line: { id, text, voiceOverride? }
}
```

Server flow:

1. Look up the line text from `clips.lines_json[line_id]`.
2. Synthesize that one sentence with the provided (or clip-default) voice.
3. Encode WAV → FLAC, compute sha, write `/data/sentences/<sha>.flac`.
4. UPSERT into `sentence_audio` for `(tenant, clip, line_id)`.
5. Re-stitch:
   a. Walk `lines_json` in order.
   b. For each line, read its FLAC path from `sentence_audio`.
      If any line is missing from the cache → return 409 with
      `reason: "backfill_required"` (this is what B.5 fixes later).
   c. Concat all FLACs (ffmpeg `concat` demuxer with a temp text file).
   d. Encode to MP3 via existing `tts.encode.wav_to_mp3`.
   e. Compute sha, write `/data/audio/<sha>.mp3`.
6. UPDATE `clips SET audio_sha256, duration_sec, sentence_offsets_json,
   updated_at, last_synced_at`.
7. If `persist_override`, UPDATE `lines_json` so the line carries
   its voiceOverride.
8. Return new clip audio metadata.

The 409-on-missing-cache behavior is intentional: the spike refuses
to re-stitch from a partial cache. Backfill (B.5) is the path that
fills the gap. For testing the spike, we use a fresh clip that was
synthed end-to-end with per-line storage on — that clip has full
cache coverage by construction.

## Re-stitch helper (`tts/restitch.py`)

Pure function, ffmpeg subprocess:

```python
def restitch_clip(
    flac_paths: list[Path],
    *,
    bitrate_kbps: int = 64,
) -> tuple[bytes, list[int]]:
    """Concat FLACs in order, return (mp3_bytes, sentence_offsets_ms).
    Offsets computed from durations measured at read time, not from
    stored values, so an out-of-band FLAC swap is caught.
    """
```

Two passes:

1. Measure each FLAC's duration_ms (cheap — header read).
2. Build offsets: `[0, dur[0], dur[0]+dur[1], ...]`.
3. ffmpeg concat → MP3 (same 64kbps as `splice.py` and `encode.py`).

Lives in `tts/` next to splice + encode so all three audio-shaping
helpers cluster.

## What this DOESN'T do (deferred sub-tickets)

- **B.4** — fold into B.3 above; restitch is the helper, not a
  separate ticket.
- **B.5** — backfill endpoint. Fills the cache for clips that were
  synthesized before opt-in. SSE-progress flow. Spike skips this.
- **B.6** — client wiring. Spike calls the endpoint by hand via curl
  for the verification step.
- **B.7** — UI surfaces (cache-status badge, backfill progress
  banner). Spike has no UI.
- **B.8** — manual + whats-new + regression sweep. Standard ritual,
  not in the spike.

## Spike verification plan

1. Migration runs cleanly on a fresh DB (no v5 → v6 errors).
2. Take a small text (~5 sentences), opt in to per-line storage via
   the existing Phase A toggle, synthesize.
3. Confirm `sentence_audio` has 5 rows, all referenced FLACs exist
   on disk, sha matches.
4. POST to the re-narrate endpoint targeting line 2 with a different
   voice. Confirm:
   - One new FLAC added to `/data/sentences/`.
   - `sentence_audio` row for line 2 updated to new sha.
   - `clips.audio_sha256` changed.
   - New combined MP3 plays start-to-finish.
   - Line 2 sounds like the new voice; transitions in/out of line 2
     are clean (no crossfade artifact).
5. Re-stitch with no edits should be a no-op at the file level (same
   sha) — confirms the helper is deterministic.

Once those pass, we stop the spike. Backfill (B.5) and UI (B.7) come
in a follow-up session after you've heard the output.

## Open questions to revisit when we resume

- **Voice consistency check.** If user re-narrates one sentence in
  the same voice but at a different rate, do we surface a "this
  sentence will sound different" warning? Probably yes — but in the
  UI layer (B.7), not the API.
- **Sentence padding.** `v225fz9` added trailing-silence padding so
  periods get a real pause. Phase B's re-stitch must preserve that
  padding. The per-sentence WAVs already contain the padding from
  synth time — just don't strip it during concat.
- **Garbage collection cadence.** `gc_orphan_sentence_audio` should
  run alongside `gc_orphan_audio` (same nightly hook when we add
  one). For now, manual gc via an admin endpoint.
- **What about chapter queues?** A multi-chapter clip is multiple
  separate clip rows today, each with its own audio. Phase B applies
  per-clip — no change to the chapter-queue path.
