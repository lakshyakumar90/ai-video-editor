import Anthropic from "@anthropic-ai/sdk";
import { type ZodType } from "zod";
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
import { parseLlmJson } from "./llm-json.js";

const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json-in-text",
  toolCalling: true,
  vision: true,
  streaming: true,
  maxContext: null,
};

/** Official Anthropic Messages SDK adapter with request-scoped BYOK keys. */
export class AnthropicProvider extends LlmProviderBase {
  readonly capabilities = ANTHROPIC_CAPABILITIES;
  constructor(
    readonly model: string,
    private readonly clientFactory: (apiKey: string) => Anthropic = (apiKey) =>
      new Anthropic({ apiKey }),
  ) {
    super();
  }

  async healthProbe(options?: LlmCallOptions): Promise<void> {
    try {
      const response = await this.client(options).messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with ok." }],
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      if (!response.content.some((part) => part.type === "text"))
        throw new LlmProviderError(
          "anthropic",
          "invalid_response",
          "Anthropic health probe returned no output",
        );
    } catch (error) {
      throw mapProviderError("anthropic", error);
    }
  }

  async generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    try {
      const response = await this.client(options).messages.create({
        model: this.model,
        max_tokens: options?.maxOutputTokens ?? 4096,
        system: "Return exactly one JSON value. Do not wrap it in markdown.",
        messages: [
          {
            role: "user",
            content: `${prompt}\n\nJSON schema:\n${JSON.stringify(safeJsonSchema(schema))}`,
          },
        ],
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      const text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      return schema.parse(parseLlmJson(text, "anthropic"));
    } catch (error) {
      throw mapProviderError("anthropic", error);
    }
  }

  async generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]> {
    try {
      const response = await this.client(options).messages.create({
        model: this.model,
        max_tokens: options?.maxOutputTokens ?? 4096,
        messages: [{ role: "user", content: prompt }],
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: safeJsonSchema(
            tool.parameters,
          ) as Anthropic.Tool.InputSchema,
        })),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      return response.content
        .filter((part) => part.type === "tool_use")
        .map((part) => {
          const definition = tools.find((tool) => tool.name === part.name);
          if (!definition)
            throw new LlmProviderError(
              "anthropic",
              "invalid_response",
              `Anthropic called unknown tool "${part.name}"`,
            );
          return {
            id: part.id,
            name: part.name,
            arguments: definition.parameters.parse(part.input),
          };
        });
    } catch (error) {
      throw mapProviderError("anthropic", error);
    }
  }

  async *stream(
    prompt: string,
    options?: LlmCallOptions,
  ): AsyncIterable<string> {
    try {
      const stream = this.client(options).messages.stream({
        model: this.model,
        max_tokens: options?.maxOutputTokens ?? 4096,
        messages: [{ role: "user", content: prompt }],
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      for await (const event of stream)
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        )
          yield event.delta.text;
      const final = await stream.finalMessage();
      this.usage(options, final.usage);
    } catch (error) {
      throw mapProviderError("anthropic", error);
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
    if (data.startsWith("http"))
      throw new UnsupportedCapabilityError("remote image URL input");
    try {
      const response = await this.client(options).messages.create({
        model: this.model,
        max_tokens: options?.maxOutputTokens ?? 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data },
              },
            ],
          },
        ],
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      this.usage(options, response.usage);
      return response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    } catch (error) {
      throw mapProviderError("anthropic", error);
    }
  }

  private client(options?: LlmCallOptions): Anthropic {
    if (!options?.apiKey)
      throw new LlmProviderError(
        "anthropic",
        "missing_key",
        "no API key is configured for anthropic",
      );
    return this.clientFactory(options.apiKey);
  }
  private usage(
    options: LlmCallOptions | undefined,
    usage: { input_tokens: number; output_tokens: number },
  ): void {
    reportUsage(options, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });
  }
}
