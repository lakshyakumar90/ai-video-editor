import { describe, expect, it } from "vitest";
import { estimateLlmCost, recordLlmUsage } from "../src/services/llm-usage.js";

describe("LLM usage accounting", () => {
  it("records provider, model, owner, token counts, and a cost estimate", () => {
    const usage = {
      providerId: "ollama",
      model: "llama3.2",
      payer: "local" as const,
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
    };
    expect(estimateLlmCost(usage)).toBe(0);
    expect(recordLlmUsage("usage-test-user", usage)).toMatchObject({
      userId: "usage-test-user",
      ...usage,
      estimatedCostUsd: 0,
    });
  });

  it("leaves hosted estimates unknown until pricing is configured", () => {
    expect(
      estimateLlmCost({
        providerId: "openai",
        model: "unpriced-model",
        payer: "user",
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      }),
    ).toBeNull();
  });
});
