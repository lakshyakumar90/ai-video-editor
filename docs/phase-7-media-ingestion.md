# Phase 7: Media ingestion and understanding

## Implementation status

- [x] Authenticated chunked and streamed upload with size, MIME, and ffprobe validation.
- [x] Preserve originals; normalize rotation, CFR video, and audio sample rate.
- [x] Create 480p preview proxies.
- [x] Generate thumbnails and waveform images.
- [x] Extract audio and persist word-timed transcripts.
- [x] Persist silence ranges and scene-change times.
- [x] Sample frames and store vision descriptions.
- [x] Embed transcript and frame descriptions; search by ranked time ranges.
- [x] Produce a center-crop recommendation for portrait reframing.
- [x] Rank transcript ranges as proposed highlight clips.
- [x] Cache derived media and analysis by content hash; resume persisted jobs.
- [ ] Face or speaker tracking to adjust the crop over time.
- [ ] Verify the full ten-minute acceptance flow with configured Whisper, provider credentials, and PostgreSQL/pgvector.

Uploads require a Better Auth session. The raw endpoint streams a whole file;
the resumable endpoint uses `POST /api/uploads/chunks`, ordered
`PUT /api/uploads/chunks/:uploadId/:index` requests, and
`POST /api/uploads/chunks/:uploadId/complete`. Both enforce the configured
`UPLOAD_MAX_BYTES`, an audio/video MIME allowlist, and `ffprobe` stream checks.

An accepted file creates an asset and persisted ingestion job. Check progress at
`GET /api/media/jobs/:jobId`; retrieve the asset and derived media at
`GET /api/media/assets/:assetId`. Jobs normalize video to CFR 30 fps and audio
to 48 kHz, preserve the uploaded original, create a 480p proxy, thumbnails,
waveform, 16 kHz mono transcription audio, silence ranges, scene-change times,
sampled frame descriptions, word-timed transcript, center-crop recommendation,
and suggested highlights. Derived files and analysis cache under
`UPLOAD_DIR/derived/<sha256>`.

For speech recognition, install whisper.cpp and set `WHISPER_CPP_PATH` and
`WHISPER_MODEL_PATH`. Vision and semantic embeddings use the signed-in user's
OpenAI key; frame descriptions follow the configured vision task route. Set
`MEDIA_DATABASE_URL` to a PostgreSQL database with pgvector available to enable
the HNSW vector index. The service creates the index schema automatically; the
matching SQL is in `apps/api/migrations/001-media-vector-documents.sql`. Without
PostgreSQL configured, development uses the per-user SQLite document store and
cosine ranking. No provider credentials are stored in the job or asset rows.

Search with `POST /api/media/search` and `{ "query": "...", "limit": 10 }`.
Results contain the owning asset, start/end seconds, similarity score, source
snippet, and whether the match came from transcript or a described frame.
Suggested clips are available at `GET /api/media/assets/:assetId/highlights`.

The checked-in media-ingestion test runs the actual FFmpeg transforms on the
four-second sample while injecting deterministic transcription, vision,
embedding, and highlight providers. Live ten-minute ingestion requires the
local Whisper model, a user's OpenAI key, and (for pgvector storage) a configured
PostgreSQL instance.
