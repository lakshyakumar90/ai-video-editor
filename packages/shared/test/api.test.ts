import { describe, expect, it } from "vitest";
import {
  generateTimelineRequestSchema,
  projectSchema,
} from "../src/index.js";

describe("generateTimelineRequestSchema", () => {
  it("accepts mode 1: prompt to generated video", () => {
    const result = generateTimelineRequestSchema.safeParse({
      mode: "prompt-to-video",
      prompt: "A 30-second recap of my road trip",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("prompt-to-video");
    }
  });

  it("accepts mode 2: uploaded footage to edited video", () => {
    const result = generateTimelineRequestSchema.safeParse({
      mode: "footage-to-edit",
      footage: [
        { uploadId: "up_1", filename: "beach.mp4" },
        { uploadId: "up_2" },
      ],
      instructions: "Cut to 15 seconds, keep the dialog",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("footage-to-edit");
    }
  });

  it("rejects an unknown mode", () => {
    const result = generateTimelineRequestSchema.safeParse({
      mode: "magic",
      prompt: "hello",
    });

    expect(result.success).toBe(false);
  });

  it("rejects footage-to-edit with an empty upload list", () => {
    const result = generateTimelineRequestSchema.safeParse({
      mode: "footage-to-edit",
      footage: [],
    });

    expect(result.success).toBe(false);
  });

  it("records the creating mode on the timeline project optionally", () => {
    const ok = projectSchema.safeParse({
      title: "Trip",
      aspectRatio: "9:16",
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      mode: "footage-to-edit",
    });

    expect(ok.success).toBe(true);
  });

  it("rejects an unknown project mode", () => {
    const bad = projectSchema.safeParse({
      title: "Trip",
      aspectRatio: "9:16",
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      mode: "legacy-vhs",
    });

    expect(bad.success).toBe(false);
  });
});
