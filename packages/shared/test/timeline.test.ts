import { describe, expect, it } from "vitest";
import { timelineSchema } from "../src/index.js";
import fixture from "../fixtures/sample-timeline.json";

describe("timelineSchema", () => {
  it("accepts the sample fixture", () => {
    const result = timelineSchema.safeParse(fixture);

    expect(result.success).toBe(true);
  });

  it("rejects a scene with missing audio", () => {
    const invalid = {
      ...fixture,
      scenes: [
        {
          id: "scene-1",
          narration: "Welcome to Big Sur",
          visual: {
            type: "image",
            source: "media/coast.jpg",
          },
          captions: [],
        },
      ],
    };

    const result = timelineSchema.safeParse(invalid);

    expect(result.success).toBe(false);
  });

  it("rejects a scene with negative audio duration", () => {
    const invalid = {
      ...fixture,
      scenes: [
        {
          ...fixture.scenes[0],
          audio: { path: "audio/scene-1.mp3", duration: -2 },
        },
      ],
    };

    const result = timelineSchema.safeParse(invalid);

    expect(result.success).toBe(false);
  });
});
