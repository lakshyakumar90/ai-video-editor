import OpenAI from "openai";
import type { ZodType } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import {
  LlmProviderBase,
  UnsupportedCapabilityError,
  reportUsage,
  safeJsonSchema,
  type ImageInput,
  type LlmCallOptions,
  type LlmToolCall,
  type LlmToolDefinition,
  type ProviderCapabilities,
} from "./llm-provider.js";
import { LlmProviderError, mapProviderError } from "./llm-provider-error.js";

const OPENAI_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json-schema",
  toolCalling: true,
  vision: true,
  streaming: true,
  maxContext: null,
};

/** Official OpenAI Responses API adapter. The key is scoped to each request. */
export class OpenAiProvider extends LlmProviderBase {
  readonly capabilities = OPENAI_CAPABILITIES;
  constructor(readonly model: string) {
    super();
  }

  async healthProbe(options?: LlmCallOptions): Promise<void> {
    try {
      const response = await this.client(options).responses.create({
        model: this.model,
        input: "Reply with ok.",
        max_output_tokens: 1,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      if (!response.output_text)
        throw new LlmProviderError(
          "openai",
          "invalid_response",
          "OpenAI health probe returned no output",
        );
    } catch (error) {
      throw mapProviderError("openai", error);
    }
  }

  async generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    const client = this.client(options);
    try {
      const response = await client.responses.parse({
        model: this.model,
        input: prompt,
        text: { format: zodTextFormat(schema, "response") },
        ...(options?.maxOutputTokens
          ? { max_output_tokens: options.maxOutputTokens }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      if (response.output_parsed === null)
        throw new LlmProviderError(
          "openai",
          "invalid_response",
          "OpenAI returned no structured output",
        );
      return schema.parse(response.output_parsed);
    } catch (error) {
      throw mapProviderError("openai", error);
    }
  }

  async generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]> {
    const client = this.client(options);
    try {
      const response = await client.responses.create({
        model: this.model,
        input: prompt,
        tools: tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: safeJsonSchema(tool.parameters) as Record<
            string,
            unknown
          >,
          strict: true,
        })),
        ...(options?.maxOutputTokens
          ? { max_output_tokens: options.maxOutputTokens }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      return response.output
        .filter((item) => item.type === "function_call")
        .map((item) => {
          const definition = tools.find((tool) => tool.name === item.name);
          if (!definition)
            throw new LlmProviderError(
              "openai",
              "invalid_response",
              `OpenAI called unknown tool "${item.name}"`,
            );
          return {
            id: item.call_id,
            name: item.name,
            arguments: definition.parameters.parse(JSON.parse(item.arguments)),
          };
        });
    } catch (error) {
      throw mapProviderError("openai", error);
    }
  }

  async *stream(
    prompt: string,
    options?: LlmCallOptions,
  ): AsyncIterable<string> {
    const client = this.client(options);
    try {
      const stream = await client.responses.create({
        model: this.model,
        input: prompt,
        stream: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      for await (const event of stream)
        if (event.type === "response.output_text.delta") yield event.delta;
      // Streaming usage is provider/model dependent; the final event is not consistently populated in SDK types.
    } catch (error) {
      throw mapProviderError("openai", error);
    }
  }

  async describeImage(
    image: ImageInput,
    prompt = "Describe this image.",
    options?: LlmCallOptions,
  ): Promise<string> {
    const data =
      typeof image.data === "string"
        ? image.data
        : Buffer.from(image.data).toString("base64");
    const url = data.startsWith("http")
      ? data
      : `data:${image.mediaType};base64,${data}`;
    try {
      const response = await this.client(options).responses.create({
        model: this.model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: url, detail: "auto" },
            ],
          },
        ],
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      return response.output_text;
    } catch (error) {
      throw mapProviderError("openai", error);
    }
  }

  private client(options?: LlmCallOptions): OpenAI {
    if (!options?.apiKey)
      throw new LlmProviderError(
        "openai",
        "missing_key",
        "no API key is configured for openai",
      );
    return new OpenAI({ apiKey: options.apiKey });
  }
  private usage(
    options: LlmCallOptions | undefined,
    usage: { input_tokens: number; output_tokens: number } | null | undefined,
  ): void {
    reportUsage(
      options,
      usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
    );
  }
}
