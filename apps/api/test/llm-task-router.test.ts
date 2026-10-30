import { afterEach, describe, expect, it } from "vitest";
import { type ZodType } from "zod";
import { scenePlansSchema } from "@repo/shared";
import { FakeLlmProvider } from "../src/services/fake-llm-provider.js";
import {
  LlmProviderBase,
  JSON_IN_TEXT_CAPABILITIES,
} from "../src/services/llm-provider.js";
import { LlmProviderError } from "../src/services/llm-provider-error.js";
import {
  generateJsonForTask,
  resolveTaskRoute,
} from "../src/services/llm-task-router.js";
import { llmProviders } from "../src/services/llm-registry.js";

const savedTaskRoute = process.env.LLM_TASK_SCRIPT_PLANNING;
const originalFake = llmProviders.get("fake")!;
const originalOpenCode = llmProviders.get("opencode")!;
afterEach(() => {
  if (savedTaskRoute === undefined) delete process.env.LLM_TASK_SCRIPT_PLANNING;
  else process.env.LLM_TASK_SCRIPT_PLANNING = savedTaskRoute;
  llmProviders.set("fake", originalFake);
  llmProviders.set("opencode", originalOpenCode);
});

class RateLimitedProvider extends LlmProviderBase {
  readonly capabilities = JSON_IN_TEXT_CAPABILITIES;
  async generateJson<T>(_prompt: string, _schema: ZodType<T>): Promise<T> {
    throw new LlmProviderError("fake", "rate_limit", "rate limited");
  }
}

describe("LLM task router", () => {
  it("parses provider and model assignments per task", () => {
    process.env.LLM_TASK_SCRIPT_PLANNING =
      "openai|gpt-test,anthropic|claude-test";
    expect(resolveTaskRoute("script-planning")).toEqual([
      { providerId: "openai", model: "gpt-test" },
      { providerId: "anthropic", model: "claude-test" },
    ]);
  });

  it("falls through on rate limits and returns the validated plan from the next registry provider", async () => {
    process.env.LLM_TASK_SCRIPT_PLANNING = "fake,opencode";
    llmProviders.set("fake", {
      ...originalFake,
      create: () => new RateLimitedProvider(),
    });
    llmProviders.set("opencode", {
      ...originalOpenCode,
      create: () => new FakeLlmProvider(),
    });
    await expect(
      generateJsonForTask({
        task: "script-planning",
        prompt: "Make a short Tokyo travel scene plan",
        schema: scenePlansSchema,
      }),
    ).resolves.toHaveLength(3);
  });

  it("uses the fake adapter without identity or credentials", async () => {
    process.env.LLM_TASK_SCRIPT_PLANNING = "fake";
    const result = await generateJsonForTask({
      task: "script-planning",
      prompt: "test",
      schema: scenePlansSchema,
    });
    expect(result).toHaveLength(3);
  });
});
