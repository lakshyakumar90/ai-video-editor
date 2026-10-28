import { describe, expect, it } from "vitest";
import { scenePlansSchema } from "@repo/shared";
import { FakeLlmProvider, fakeSceneScript } from "../src/services/fake-llm-provider.js";

describe("FakeLlmProvider", () => {
  it("returns a validated 3-scene script", async () => {
    const provider = new FakeLlmProvider();
    const script = await provider.generateJson(
      "write a 3-scene video script",
      scenePlansSchema,
    );

    expect(script).toHaveLength(3);
    for (const scene of script) {
      expect(scene.narration).toBeTruthy();
      expect(scene.visualQuery).toBeTruthy();
      expect(scene.mood).toBeTruthy();
    }
    expect(script).toEqual(fakeSceneScript);
  });

  it("rejects when the schema does not match the script shape", async () => {
    const provider = new FakeLlmProvider();
    await expect(
      provider.generateJson("x", scenePlansSchema.element),
    ).rejects.toThrow();
  });

  it("rejects an empty prompt", async () => {
    const provider = new FakeLlmProvider();
    await expect(
      provider.generateJson("", scenePlansSchema),
    ).rejects.toThrow(/non-empty prompt/);
  });
});
