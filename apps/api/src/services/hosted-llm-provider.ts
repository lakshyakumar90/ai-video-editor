import type { ZodType } from "zod";
import {
  LlmProviderBase,
  UnsupportedCapabilityError,
  reportUsage,
  safeJsonSchema,
  type ImageInput,
  type LlmCallOptions,
  type LlmToolDefinition,
  type LlmToolCall,
  type ProviderCapabilities,
} from "./llm-provider.js";
import { LlmProviderError, mapProviderError } from "./llm-provider-error.js";
import { parseLlmJson } from "./llm-json.js";

export type OpenAiCompatiblePresetId =
  | "openai-compatible"
  | "openrouter"
  | "groq"
  | "together"
  | "deepseek"
  | "ollama"
  | "lm-studio"
  | "vllm";

export interface OpenAiCompatibleProviderOptions {
  /** Base URL of a Chat Completions-compatible service. */
  baseUrl: string;
  model: string;
  providerId?: OpenAiCompatiblePresetId;
  /** Override capabilities for a known model or private deployment. */
  capabilities?: Partial<ProviderCapabilities>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface OpenAiCompatiblePreset {
  id: OpenAiCompatiblePresetId;
  baseUrl: string;
  requiresApiKey: boolean;
  capabilities: ProviderCapabilities;
}

const compatibleCapabilities: ProviderCapabilities = {
  structuredOutput: "json-in-text",
  toolCalling: true,
  vision: false,
  streaming: true,
  maxContext: null,
};

export const OPENAI_COMPATIBLE_PRESETS: Record<
  OpenAiCompatiblePresetId,
  OpenAiCompatiblePreset
> = {
  "openai-compatible": {
    id: "openai-compatible",
    baseUrl: "",
    requiresApiKey: true,
    capabilities: compatibleCapabilities,
  },
  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    capabilities: { ...compatibleCapabilities, vision: true },
  },
  groq: {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresApiKey: true,
    capabilities: compatibleCapabilities,
  },
  together: {
    id: "together",
    baseUrl: "https://api.together.xyz/v1",
    requiresApiKey: true,
    capabilities: { ...compatibleCapabilities, vision: true },
  },
  deepseek: {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    requiresApiKey: true,
    capabilities: { ...compatibleCapabilities, toolCalling: true },
  },
  ollama: {
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
    capabilities: { ...compatibleCapabilities, toolCalling: false },
  },
  "lm-studio": {
    id: "lm-studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    requiresApiKey: false,
    capabilities: { ...compatibleCapabilities, toolCalling: false },
  },
  vllm: {
    id: "vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    requiresApiKey: false,
    capabilities: compatibleCapabilities,
  },
};

/**
 * OpenAI Chat Completions-compatible adapter. It stores model and endpoint
 * configuration only; the caller supplies a user's credential for each call.
 */
export class OpenAiCompatibleProvider extends LlmProviderBase {
  readonly capabilities: ProviderCapabilities;
  readonly providerId: OpenAiCompatiblePresetId;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly requiresApiKey: boolean;

  constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.providerId = options.providerId ?? "openai-compatible";
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.requiresApiKey =
      OPENAI_COMPATIBLE_PRESETS[this.providerId].requiresApiKey;
    this.capabilities = {
      ...OPENAI_COMPATIBLE_PRESETS[this.providerId].capabilities,
      ...options.capabilities,
    };
  }

  async generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    if (prompt.trim().length === 0) throw new Error("prompt must not be empty");
    const response = await this.request(
      {
        model: this.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Respond with exactly one JSON value and nothing else.",
          },
          { role: "user", content: prompt },
        ],
        ...(options?.maxOutputTokens === undefined
          ? {}
          : { max_tokens: options.maxOutputTokens }),
      },
      options,
    );
    const body = (await response.json()) as ChatCompletionResponse;
    const text = body.choices?.[0]?.message?.content ?? "";
    reportUsage(options, {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    });
    return schema.parse(parseJsonReply(text));
  }

  async generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]> {
    if (!this.capabilities.toolCalling) {
      return super.generateWithTools(prompt, tools, options);
    }
    if (tools.length === 0) return [];
    const response = await this.request(
      {
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: safeJsonSchema(tool.parameters),
          },
        })),
        tool_choice: "auto",
        ...(options?.maxOutputTokens === undefined
          ? {}
          : { max_tokens: options.maxOutputTokens }),
      },
      options,
    );
    const body = (await response.json()) as ChatCompletionResponse;
    reportUsage(options, {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    return (body.choices?.[0]?.message?.tool_calls ?? []).map((call) => {
      const definition = byName.get(call.function.name);
      if (!definition) {
        throw new LlmProviderError(
          this.providerId,
          "invalid_response",
          `model called unknown tool "${call.function.name}"`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch (error) {
        throw new LlmProviderError(
          this.providerId,
          "invalid_response",
          `model returned invalid JSON for tool "${call.function.name}"`,
          { cause: error },
        );
      }
      return {
        id: call.id,
        name: call.function.name,
        arguments: definition.parameters.parse(parsed),
      };
    });
  }

  async *stream(
    prompt: string,
    options?: LlmCallOptions,
  ): AsyncIterable<string> {
    if (!this.capabilities.streaming) {
      yield* super.stream(prompt, options);
      return;
    }
    const response = await this.request(
      {
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: prompt }],
      },
      options,
    );
    if (!response.body) {
      throw new LlmProviderError(
        this.providerId,
        "invalid_response",
        "stream response had no body",
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          const event = JSON.parse(data) as ChatCompletionResponse;
          const usage = event.usage;
          reportUsage(options, {
            inputTokens: usage?.prompt_tokens,
            outputTokens: usage?.completion_tokens,
          });
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async describeImage(
    image: ImageInput,
    prompt = "Describe this image.",
    options?: LlmCallOptions,
  ): Promise<string> {
    if (!this.capabilities.vision) {
      throw new UnsupportedCapabilityError("vision");
    }
    const data =
      typeof image.data === "string"
        ? image.data
        : Buffer.from(image.data).toString("base64");
    const imageUrl = data.startsWith("http")
      ? data
      : `data:${image.mediaType};base64,${data}`;
    const response = await this.request(
      {
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      },
      options,
    );
    const body = (await response.json()) as ChatCompletionResponse;
    reportUsage(options, {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    });
    return body.choices?.[0]?.message?.content ?? "";
  }

  async healthProbe(options?: LlmCallOptions): Promise<void> {
    const response = await this.request(
      {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      },
      options,
    );
    const body = (await response.json()) as ChatCompletionResponse;
    if (!body.choices?.[0]?.message?.content) {
      throw new LlmProviderError(
        this.providerId,
        "invalid_response",
        `${this.providerId} health check returned no text`,
      );
    }
    reportUsage(options, {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    });
  }

  private async request(
    body: Record<string, unknown>,
    options?: LlmCallOptions,
  ): Promise<Response> {
    const apiKey = options?.apiKey;
    if (this.requiresApiKey && !apiKey) {
      throw new LlmProviderError(
        this.providerId,
        "missing_key",
        `no API key is configured for ${this.providerId}`,
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (error) {
      throw mapProviderError(this.providerId, error);
    }
    if (!response.ok) {
      throw mapProviderError(this.providerId, {
        status: response.status,
        message: await response.text(),
      });
    }
    return response;
  }
}

export function createCompatiblePresetOptions(
  presetId: OpenAiCompatiblePresetId,
  model: string,
  options: Omit<OpenAiCompatibleProviderOptions, "providerId" | "model"> = {
    baseUrl: OPENAI_COMPATIBLE_PRESETS[presetId].baseUrl,
  },
): OpenAiCompatibleProviderOptions {
  return {
    ...options,
    providerId: presetId,
    model,
    baseUrl: options.baseUrl || OPENAI_COMPATIBLE_PRESETS[presetId].baseUrl,
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    delta?: { content?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseJsonReply(text: string): unknown {
  return parseLlmJson(text, "openai-compatible");
}
