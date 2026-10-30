import type { ZodType } from "zod";
import { scenePlansSchema, type ScenePlans } from "@repo/shared";
import {
  JSON_IN_TEXT_CAPABILITIES,
  LlmProviderBase,
  type ProviderCapabilities,
} from "./llm-provider.js";

/** Hardcoded 3-scene script returned by {@link FakeLlmProvider}. */
export const fakeSceneScript: ScenePlans = scenePlansSchema.parse([
  {
    narration:
      "Tokyo changes pace the moment the sun goes down. Lanterns flicker on, and the city fills with neon.",
    visualQuery: "tokyo night street neon signs",
    mood: "electric",
  },
  {
    narration:
      "Down the narrow alleys, ramen shops and quiet bars trace back centuries of city life.",
    visualQuery: "ramen shop counter night",
    mood: "cozy",
  },
  {
    narration:
      "By midnight the hum softens, and the skyline settles into calm as the last trains pull away.",
    visualQuery: "tokyo skyline night aerial",
    mood: "calm",
  },
]);

/**
 * `LlmProvider` test and development double: ignores the prompt and returns
 * {@link fakeSceneScript} validated against whatever schema is passed in.
 */
export class FakeLlmProvider extends LlmProviderBase {
  readonly capabilities: ProviderCapabilities = JSON_IN_TEXT_CAPABILITIES;

  async healthProbe(): Promise<void> {}

  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    if (prompt.length === 0) {
      throw new Error("FakeLlmProvider requires a non-empty prompt");
    }
    const plan = schema.safeParse(fakeSceneScript);
    if (plan.success) return plan.data;

    // The CLI and API use the response envelope, while lower-level scene
    // planning callers may validate the scene array directly.
    return schema.parse({ scenes: fakeSceneScript });
  }
}
