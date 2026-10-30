import { afterEach, describe, expect, it } from "vitest";
import { llmKeyVault } from "../src/services/llm-key-vault.js";
import { resolveLlmCredential } from "../src/services/llm-credentials.js";

const userId = `vault-test-${crypto.randomUUID()}`;
afterEach(() => {
  for (const key of llmKeyVault.list(userId))
    llmKeyVault.delete(userId, key.providerId);
});

describe("LLM BYOK vault", () => {
  it("stores one encrypted key per user/provider and only displays the last four", () => {
    const summary = llmKeyVault.set(userId, "openai", "sk-test-secret-1234");
    expect(summary.lastFour).toBe("1234");
    expect(llmKeyVault.list(userId)).toEqual([
      expect.objectContaining({ providerId: "openai", lastFour: "1234" }),
    ]);
    expect(llmKeyVault.get(userId, "openai")).toBe("sk-test-secret-1234");
    expect(llmKeyVault.get(`${userId}-other`, "openai")).toBeUndefined();
  });

  it("prefers a user's key and requires both explicit consent and plan eligibility for platform fallback", () => {
    llmKeyVault.set(userId, "openai", "user-key-1234");
    expect(
      resolveLlmCredential({
        userId,
        providerId: "openai",
        allowPlatformFallback: true,
        planAllowsPlatformKey: true,
        platformKey: "platform-key",
      }),
    ).toEqual({ apiKey: "user-key-1234", payer: "user" });
    expect(() =>
      resolveLlmCredential({
        userId,
        providerId: "anthropic",
        planAllowsPlatformKey: true,
        platformKey: "platform-key",
      }),
    ).toThrow(/no API key/);
    expect(
      resolveLlmCredential({
        userId,
        providerId: "anthropic",
        allowPlatformFallback: true,
        planAllowsPlatformKey: true,
        platformKey: "platform-key",
      }),
    ).toEqual({ apiKey: "platform-key", payer: "platform" });
  });
});
