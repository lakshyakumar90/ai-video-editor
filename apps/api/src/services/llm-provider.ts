import type { ZodType } from "zod";

/**
 * What an `LlmProvider` can honestly do today, declared at the
 * contract level so consumers never guess.
 *
 * - **JSON-in-text only**: adapters embed the JSON schema in the prompt
 *   and must parse + validate plain-text replies. No adapter uses a
 *   guaranteed server-side structured-output mode (the hosted stub
 *   *hints* `json_object`, but the reply is still parsed from text).
 * - **No native tool calling**: no adapter exposes tool/function
 *   calling loops; if such a feature is needed, extend this interface
 *   - do not bolt it onto `generateJson`.
 */
export interface LlmCapabilities {
  structuredOutput: "json-in-text";
  toolCalling: false;
}

export const SUPPORTED_LLM_CAPABILITIES: LlmCapabilities = {
  structuredOutput: "json-in-text",
  toolCalling: false,
};

/**
 * A text-to-JSON large-language-model backend, used by the API to turn
 * prompts into structured, schema-validated data.
 *
 * Implementations own the model/provider details (transports, retries,
 * prompt wrapping, JSON parsing). Consumers only see the typed result.
 * Adapters are created through `llm-registry.ts`, never imported
 * directly.
 */
export interface LlmProvider {
  /**
   * Generates JSON from `prompt` and validates it against `schema`.
   *
   * Resolves with the parsed value after validation succeeds. Rejects if
   * the provider is unreachable, the output is not parseable JSON, or the
   * output does not satisfy `schema`.
   */
  generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T>;
}
