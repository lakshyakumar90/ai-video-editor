import { describe, expect, it } from "vitest";
import {
  sourceOutOf,
  timelineSchema,
  type CaptionClip,
  type MediaClip,
  type Timeline,
} from "../src/index.js";
import fixture from "../fixtures/sample-timeline.json" with { type: "json" };

/** A valid v2 timeline built from the fixture, with surgical overrides. */
function baseTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return timelineSchema.parse({ ...fixture, ...overrides });
}

describe("timelineSchema v2", () => {
  it("accepts the sample fixture", () => {
    const result = timelineSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(2);
      expect(result.data.tracks).toHaveLength(4);
    }
  });

  it("rejects an unknown schemaVersion with a migration hint", () => {
    const invalid = { ...fixture, schemaVersion: 1 };
    const result = timelineSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("migrateTimeline");
    }
  });

  it("rejects a clip with a negative duration", () => {
    const invalid = baseTimeline();
    const videoTrack = invalid.tracks[0];
    if (videoTrack && videoTrack.clips[0]) {
      (videoTrack.clips[0] as MediaClip).duration = -2;
    }
    const result = timelineSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("duration");
    }
  });

  it("rejects clips on tracks without track kind clips (media clip on captions)", () => {
    const invalid = baseTimeline();
    const videoClip = invalid.tracks[0]?.clips[0] as MediaClip;
    const captions = invalid.tracks.find((track) => track.kind === "captions");
    if (captions) captions.clips.push(videoClip);
    const result = timelineSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes("captions")),
      ).toBe(true);
    }
  });

  describe("asset integrity", () => {
    it("rejects unknown asset references with a clear message", () => {
      const invalid = baseTimeline();
      const clip = invalid.tracks[0]?.clips[0] as MediaClip;
      clip.assetId = "asset-does-not-exist";
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'clip "clip-coast" references unknown asset "asset-does-not-exist"',
        );
      }
    });

    it("rejects video clips playing an audio-only asset visually", () => {
      const invalid = baseTimeline();
      const clip = invalid.tracks[0]?.clips[0] as MediaClip;
      clip.assetId = "asset-narration";
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("audio asset");
      }
    });

    it("rejects clips that read past the end of their asset", () => {
      const invalid = baseTimeline();
      const clip = invalid.tracks[0]?.clips[0] as MediaClip;
      // Give the (image) asset a known duration so the span check applies.
      const coast = invalid.assets.find((asset) => asset.id === clip.assetId);
      if (coast) coast.duration = 10;
      clip.sourceIn = 0;
      clip.duration = 60;
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes("exceeds asset")),
        ).toBe(true);
      }
    });
  });

  describe("stable ids", () => {
    it("rejects duplicate ids across assets, tracks and clips", () => {
      const invalid = baseTimeline();
      invalid.tracks[0]!.id = "asset-coast";
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes("duplicate id")),
        ).toBe(true);
      }
    });

    it("rejects blank-string clip ids", () => {
      const invalid = baseTimeline();
      const clip = invalid.tracks[0]?.clips[0] as MediaClip;
      clip.id = "   ";
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("track layout", () => {
    it("rejects overlapping clips on the same track", () => {
      const invalid = baseTimeline();
      const video = invalid.tracks[0];
      if (video && video.clips[0]) {
        const original = video.clips[0] as MediaClip;
        video.clips.push({ ...original, id: "clip-overlap", start: 1 });
      }
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes("before clip")),
        ).toBe(true);
      }
    });

    it("allows clips that merely touch edges", () => {
      const invalid = baseTimeline();
      const video = invalid.tracks[0];
      if (video && video.clips[0]) {
        const original = video.clips[0] as MediaClip;
        video.clips.push({ ...original, id: "clip-next", start: 3.5 });
      }
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(true);
    });

    it("rejects caption words outside their clip window", () => {
      const invalid = baseTimeline();
      const captions = invalid.tracks.find((track) => track.kind === "captions");
      const captionClip = captions?.clips[0] as CaptionClip | undefined;
      if (captions && captionClip) {
        captionClip.words.push({ word: "late", start: 99, end: 100 });
      }
      const result = timelineSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes("outside clip")),
        ).toBe(true);
      }
    });
  });

  describe("non-destructive clip fields", () => {
    it("defaults speed and volume to unity", () => {
      const parsed = timelineSchema.parse({ ...fixture });
      const clip = parsed.tracks[0]?.clips[0] as MediaClip;
      expect(clip.speed).toBe(1);
      expect(clip.volume).toBe(1);
    });

    it("rejects speeds outside 0.1..10 and volumes below 0", () => {
      const slow = baseTimeline();
      (slow.tracks[0]?.clips[0] as MediaClip).speed = 0.01;
      expect(timelineSchema.safeParse(slow).success).toBe(false);

      const loud = baseTimeline();
      (loud.tracks[0]?.clips[0] as MediaClip).volume = -1;
      expect(timelineSchema.safeParse(loud).success).toBe(false);
    });

    it("computes the source out point from sourceIn, duration and speed", () => {
      expect(sourceOutOf({ sourceIn: 2, duration: 4, speed: 1 })).toBe(6);
      expect(sourceOutOf({ sourceIn: 2, duration: 4, speed: 2 })).toBe(10);
    });
  });
});

describe("assets", () => {
  it("allows video, audio and image+color assets with the right shapes", () => {
    // image and color assets have no intrinsic duration - optional.
    expect(
      timelineSchema.safeParse({
        ...fixture,
        assets: [
          ...fixture.assets,
          {
            id: "asset-black",
            kind: "color",
            origin: "generated",
            src: "#000000",
            silenceRanges: [],
          },
        ],
      }).success,
    ).toBe(true);

    // video and audio assets must declare their duration.
    const mutable = JSON.parse(JSON.stringify(fixture)) as {
      assets: Array<Record<string, unknown>>;
    };
    const narration = mutable.assets.find((asset) => asset.id === "asset-narration");
    if (narration) delete narration.duration;

    const noAudioDuration = timelineSchema.safeParse(mutable);
    expect(noAudioDuration.success).toBe(false);
    if (!noAudioDuration.success) {
      expect(
        noAudioDuration.error.issues.some((issue) => issue.message.includes("duration")),
      ).toBe(true);
    }
  });

  it("rejects silence ranges on color assets", () => {
    const result = timelineSchema.safeParse({
      ...fixture,
      assets: [
        {
          id: "asset-black",
          kind: "color",
          origin: "generated",
          src: "#000000",
          silenceRanges: [{ start: 1, end: 2 }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("color assets");
    }
  });

  it("rejects a silence range whose end is not after its start", () => {
    const silence = fixture.assets.find((asset) => asset.kind === "audio");
    if (!silence) throw new Error("fixture must contain an audio asset");
    const result = timelineSchema.safeParse({
      ...fixture,
      assets: [
        ...fixture.assets.filter((asset) => asset.kind !== "audio"),
        { ...silence, silenceRanges: [{ start: 2, end: 2 }] },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("silence range");
    }
  });
});
