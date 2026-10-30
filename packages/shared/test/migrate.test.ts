import { describe, expect, it } from "vitest";
import {
  migrateTimeline,
  timelineSchema,
  TimelineMigrationError,
  type CaptionClip,
  type MediaClip,
  type Timeline,
} from "../src/index.js";
import { timelineSchemaV1 } from "../src/timeline-v1.js";
import v1Fixture from "../fixtures/sample-timeline-v1.json" with { type: "json" };
import v2Fixture from "../fixtures/sample-timeline.json" with { type: "json" };

describe("migrateV1TimelineToV2", () => {
  const v1 = timelineSchemaV1.parse(v1Fixture);
  const v2 = migrateTimeline(v1Fixture) as Timeline;

  it("emits a schemaVersion 2 timeline", () => {
    expect(v2.schemaVersion).toBe(2);
    expect(timelineSchema.safeParse(v2).success).toBe(true);
  });

  it("converts scene audio into generated audio assets and clips", () => {
    const narration = v2.assets.filter(
      (asset) => asset.id === "asset-audio-scene-1.mp3",
    );
    expect(narration).toHaveLength(1);
    expect(narration[0]).toMatchObject({
      kind: "audio",
      origin: "generated",
      duration: 3.5,
    });

    const audioTrack = v2.tracks.find((track) => track.id === "track-audio");
    const narrationClip = audioTrack?.clips.find(
      (clip) => clip.id === "clip-scene-1-narration",
    ) as MediaClip | undefined;
    expect(narrationClip).toMatchObject({
      assetId: "asset-audio-scene-1.mp3",
      sourceIn: 0,
      start: 0,
      duration: 3.5,
    });
  });

  it("lays scenes back to back per track, preserving trim and durations", () => {
    const videoTrack = v2.tracks.find((track) => track.id === "track-video");
    const first = videoTrack?.clips[0] as MediaClip | undefined;
    const second = videoTrack?.clips[1] as MediaClip | undefined;

    // scene-1 image trim 0 -> 3.5 becomes sourceIn 0 + duration 3.5 at 0.
    expect(first).toMatchObject({ sourceIn: 0, start: 0, duration: 3.5 });
    // scene-2 video trim 12 -> 14.5 moves to timeline start 3.5.
    expect(second).toMatchObject({
      assetId: "asset-media-sunset.mp4",
      sourceIn: 12,
      start: 3.5,
      duration: 2.5,
    });
  });

  it("offsets scene-relative caption words to timeline time", () => {
    const captions = v2.tracks.find((track) => track.id === "track-captions");
    const first = captions?.clips.find(
      (clip) => clip.id === "clip-scene-1-captions",
    ) as CaptionClip | undefined;
    if (!first) throw new Error("captions clip missing after migration");
    expect(first.words[0]).toEqual({ word: "Welcome", start: 0, end: 1.2 });

    // scene-2 has empty captions but a narration - text-only clip.
    const second = captions?.clips.find(
      (clip) => clip.id === "clip-scene-2-captions",
    ) as CaptionClip | undefined;
    expect(second).toMatchObject({
      start: 3.5,
      duration: 2.5,
      text: "Then the cliffs turned gold",
      words: [],
    });
  });

  it("folds legacy music into an audio track with its volume", () => {
    const musicTrack = v2.tracks.find((track) => track.id === "track-music");
    const clip = musicTrack?.clips[0] as MediaClip | undefined;
    expect(musicTrack?.kind).toBe("audio");
    expect(clip).toMatchObject({ start: 0, duration: 6, volume: 0.4 });
    expect(v2.assets.find((asset) => asset.id === "asset-music-ambient.mp3")).toMatchObject({
      kind: "audio",
      origin: "stock",
    });
  });

  it("keeps project metadata and style", () => {
    expect(v2.project).toMatchObject(v1Fixture.project);
    expect(v2.style).toEqual(v1Fixture.style);
  });

  it("migrated tracks cover video, narration audio, captions and music", () => {
    expect(v2.tracks.map((track) => track.kind)).toEqual([
      "video",
      "audio",
      "captions",
      "audio",
    ]);
    expect(v2.assets.length).toBeGreaterThanOrEqual(v1.scenes.length);
  });
});

describe("migrateTimeline", () => {
  it("passes v2 timelines through unchanged", () => {
    const v2 = migrateTimeline(v2Fixture) as Timeline;
    expect(timelineSchema.parse(v2).schemaVersion).toBe(2);
    expect(v2.tracks).toHaveLength(v2Fixture.tracks.length);
  });

  it("migrates v1 timelines to v2", () => {
    const v2 = migrateTimeline(v1Fixture) as Timeline;
    expect(v2.schemaVersion).toBe(2);
    expect(timelineSchema.safeParse(v2).success).toBe(true);
  });

  it("rejects garbage with a clear aggregate error", () => {
    try {
      migrateTimeline({ schemaVersion: 7, project: {} } as never);
      throw new Error("expected migration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TimelineMigrationError);
      const migration = error as TimelineMigrationError;
      expect(migration.issues.some((issue) => issue.includes("schemaVersion"))).toBe(true);
      expect(migration.message).toContain("schemaVersion 1 or 2");
    }
  });

  it("rejects a v1 timeline missing scenes", () => {
    expect(() =>
      migrateTimeline({ ...v1Fixture, scenes: undefined } as never),
    ).toThrow(TimelineMigrationError);
  });
});
