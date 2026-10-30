import type { ZodType } from "zod";
import {
  JSON_IN_TEXT_CAPABILITIES,
  LlmProviderBase,
  type ProviderCapabilities,
} from "./llm-provider.js";

/**
 * Stub for a second provider: a hosted, OpenAI-compatible chat API.
 *
 * Exists to prove the {@link LlmProvider} interface swaps cleanly — it
 * ships a different transport (hosted REST + bearer auth, no sessions)
 * behind the exact same one-method contract. `response_format:
 * json_object` is a *hint*; the reply is still parsed as text, so this
 * adapter is JSON-in-text (see SUPPORTED_LLM_CAPABILITIES), no tool
 * calling. Created only through `llm-registry.ts`. When a real hosted
 * provider is chosen, this class is the template.
 */
export interface OpenAiCompatibleProviderOptions {
  /** e.g. https://api.openai.com (no trailing path needed). */
  baseUrl: string;
  /** Bearer API key for the hosted provider. */
  apiKey: string;
  /** Hosted model id, e.g. "gpt-5-nano". */
  model: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export class OpenAiCompatibleProvider extends LlmProviderBase {
  readonly capabilities: ProviderCapabilities = JSON_IN_TEXT_CAPABILITIES;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    if (prompt.trim().length === 0) {
      throw new Error("prompt must not be empty");
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Respond with exactly one JSON value and nothing else.",
            },
            { role: "user", content: prompt },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`hosted provider returned ${response.status}`, {
        cause: { status: response.status },
      });
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const value = this.parseJsonReply(text);
    return schema.parse(value);
  }

  /** Minimal parse mirroring {@doc OpenCodeProvider.parseJsonReply}. */
  private parseJsonReply(text: string): unknown {
    let raw = text.trim();
    const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
    if (fenced?.[1] && fenced[1].trim().length > 0) {
      raw = fenced[1].trim();
    }
    return JSON.parse(raw);
  }
}
