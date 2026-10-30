import { llmKeyVault } from "./llm-key-vault.js";

export type LlmKeyPayer = "user" | "platform";
export interface ResolvedLlmCredential {
  apiKey: string;
  payer: LlmKeyPayer;
}

/** Resolve credentials for one request. This function never caches key material. */
export function resolveLlmCredential(input: {
  userId: string;
  providerId: string;
  allowPlatformFallback?: boolean;
  planAllowsPlatformKey?: boolean;
  platformKey?: string;
}): ResolvedLlmCredential {
  if (!input.userId) throw new Error("verified user id is required");
  const userKey = llmKeyVault.get(input.userId, input.providerId);
  if (userKey) return { apiKey: userKey, payer: "user" };
  if (
    input.allowPlatformFallback &&
    input.planAllowsPlatformKey &&
    input.platformKey
  ) {
    return { apiKey: input.platformKey, payer: "platform" };
  }
  throw new Error(`no API key is configured for ${input.providerId}`);
}
