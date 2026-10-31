import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineSchema, type Asset } from "@repo/shared";

vi.mock("../src/services/timeline-renderer.js", () => ({
  renderTimeline: vi.fn(
    async (_timeline: unknown, options: { outputPath: string }) => ({
      outputPath: options.outputPath,
      duration: 4,
      width: 1080,
      height: 1920,
      hasAudio: true,
      cacheHits: 0,
      cacheMisses: 1,
    }),
  ),
}));

import {
  assembleTimeline,
  editFromFootage,
} from "../src/services/generate-video.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("synchronous video pipeline timeline outputs", () => {
  it("assembles prompt scenes into a validated shared timeline", () => {
    const timeline = assembleTimeline({
      title: "A small story",
      aspectRatio: "9:16",
      musicUrl: "C:/music.mp3",
      scenes: [
        {
          scene: {
            narration: "One two three",
            visualQuery: "forest",
            mood: "calm",
          },
          speech: { url: "C:/voice.mp3", duration: 3 },
          visual: {
            url: "C:/forest.mp4",
            candidate: {
              id: "v1",
              url: "stock",
              description: "Forest",
              duration: 4,
              width: 1080,
              height: 1920,
            },
          },
          words: [
            { word: "One", start: 0, end: 0.5 },
            { word: "two", start: 0.5, end: 1 },
            { word: "three", start: 1, end: 1.5 },
          ],
        },
      ],
    });
    expect(timelineSchema.parse(timeline).project.mode).toBe("prompt-to-video");
    expect(timeline.tracks.map((track) => track.kind)).toEqual([
      "video",
      "audio",
      "captions",
      "audio",
    ]);
    expect(timeline.tracks[2]?.clips[0]).toMatchObject({
      text: "One two three",
      duration: 1.5,
    });
  });

  it("plans a footage cut through the selected fake provider into the same schema", async () => {
    vi.stubEnv("LLM_PROVIDER", "fake");
    const asset: Asset = {
      id: "uploaded-video",
      kind: "video",
      origin: "uploaded",
      src: "C:/fixture.mp4",
      duration: 8,
      thumbnails: [],
      sceneChanges: [],
      frameDescriptions: [],
      silenceRanges: [],
    };
    const result = await editFromFootage({
      userId: "test-user",
      assets: [asset],
      instruction: "Make a short opening",
    });
    expect(timelineSchema.parse(result.timeline).project.mode).toBe(
      "footage-to-edit",
    );
    expect(result.timeline.tracks[0]?.clips[0]).toMatchObject({
      assetId: "uploaded-video",
      sourceIn: 0,
      duration: 4,
    });
    expect(result.render.width).toBe(1080);
  });
});
