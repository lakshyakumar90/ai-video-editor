# MVP Redefinition: Two Modes, One Editable Timeline

**Status:** Accepted\
**Date:** 2026-10-30\
**Scope:** Product definition of the MVP — what we build first and why

---

## 1. Decision

The MVP is two user-facing **modes**. They differ in how a project
starts, but both **end in the same artifact**: an editable
[`Timeline`](../packages/shared/src/timeline.ts) document and a video
rendered from it with the same FFmpeg pipeline.

``` text
Mode 1: Prompt ──▶ generated video
          │ (LLM scene plan → local TTS → stock media → Timeline → render)

Mode 2: Uploaded footage ──▶ edited video
          │ (transcribe/analyze uploads → LLM edit plan → Timeline → render)

                       both ──▶ Timeline (editable) ──▶ render/FFmpeg
```

### Mode 1 — Prompt to generated video

User submits a text prompt. The backend:

1. Generates scene plans via the `LlmProvider` (`generateScenePlans`).
2. Narrates each scene with local TTS (Kokoro-82M).
3. Fills visuals from stock media (Pexels) or solid colors.
4. Assembles a word-timed `Timeline` (captions from narration timing).
5. Renders with the proven FFmpeg spike pipeline and returns the video +
   editable `Timeline`.

### Mode 2 — Uploaded footage to edited video

User uploads their own footage (clips and optionally voiceover audio).
The backend:

1. Transcribes speech with local STT (whisper.cpp) when present.
2. Analyzes the uploads (durations, audio) and generates an **edit plan**
   via the same `LlmProvider`: which clip sections to keep, order,
   trims, captions, music.
3. Assembles the **same** `Timeline` shape — uploaded sources referenced
   by server-side upload ids instead of stock assets.
4. Renders with the same FFmpeg pipeline and returns the video +
   editable `Timeline`.

## 2. Why one shared artifact

- The editor UI operates on a single schema (`Timeline`), regardless of
  whether the project began as a prompt or an upload. Users can switch
  freely between "generate for me" and "edit my own footage".
- Rendering, caption burning, music ducking, and export are written
  once. Mode C is not the third mode; it is the same mode.
- Provider work (`LlmProvider`, ducking, concat spikes) applies to both
  modes with no forks.

## 3. Contracts

- `mvpModeSchema` — `prompt-to-video` or `footage-to-edit`; recorded
  optionally on the timeline's `project.mode` so the editor knows how a
  project was started (default is unset = mode 1 legacy).
- `generateTimelineRequestSchema` — a discriminated union:
  - `{ mode: "prompt-to-video", prompt }`
  - `{ mode: "footage-to-edit", footage: [{ uploadId, filename? }],
    instructions? }`
- `uploadId` always refers to a server-generated upload record. The API
  never accepts raw client filesystem paths (see the local-AI decision's
  upload-safety rules).

## 4. Non-goals for the MVP

- No multi-track/advanced timeline editing beyond scene-level trims.
- No AI-generated footage; mode 2 edits what the user uploaded.
- No collaboration or accounts beyond what the deployment decision
  requires.
