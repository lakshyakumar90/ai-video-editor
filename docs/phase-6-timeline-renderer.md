# Phase 6: Multi-track timeline renderer

Implemented in `apps/api/src/services/timeline-renderer.ts`. Run the JSON-only
acceptance fixture from the repository root with:

```sh
npx tsx scripts/render-fixture.ts
```

The checked-in fixture uses the local sample media under `tmp/samples` and
writes `tmp/outputs/timeline-fixture.mp4`.

- [x] `renderTimeline` validates and renders a schema-v2 timeline.
- [x] `renderClip` creates normalized visual segments; video, audio, and
  caption tracks are composed into the final render.
- [x] `concatScenes` concatenates compatible segments with FFmpeg's concat
  demuxer.
- [x] Music beds are ducked against narration and clip audio, then limited.
- [x] Visual segments are cached by source bytes and render-relevant clip
  settings, so changing captions or audio does not re-encode unchanged visuals.
- [x] Every render uses a unique temporary directory and removes it in `finally`.
- [x] Final exports support 9:16 (1080x1920), 16:9 (1920x1080), 1:1
  (1080x1080), and 4:3 (1440x1080).
- [x] Integration coverage asserts the fixture duration within 0.2 seconds,
  portrait dimensions, mixed audio, and successful still/range exports.
- [x] Tracks and clips honor source in, timeline start, duration, speed, volume,
  mute, and video-clip audio.
- [x] Overlay and caption tracks are layered independently over the video.
- [x] Preview renders use proxy paths when present and 480p-class output with
  fast encoding; final renders use originals.
- [x] Still-frame and frame-accurate short-range exports are available through
  `exportStillOrRange`.
