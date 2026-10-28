import type { ZodType } from "zod";

/**
 * A text-to-JSON large-language-model backend, used by the API to turn
 * prompts into structured, schema-validated data.
 *
 * Implementations own the model/provider details (transports, retries,
 * prompt wrapping, JSON parsing). Consumers only see the typed result.
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
