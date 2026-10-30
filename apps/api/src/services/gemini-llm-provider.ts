import { GoogleGenAI } from "@google/genai";
import { type ZodType } from "zod";
import {
  LlmProviderBase,
  reportUsage,
  safeJsonSchema,
  type ImageInput,
  type LlmCallOptions,
  type LlmToolCall,
  type LlmToolDefinition,
  type ProviderCapabilities,
  type VideoInput,
} from "./llm-provider.js";
import { LlmProviderError, mapProviderError } from "./llm-provider-error.js";
import { parseLlmJson } from "./llm-json.js";

const GEMINI_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json-schema",
  toolCalling: true,
  vision: true,
  streaming: true,
  maxContext: null,
};

/** Official Google GenAI SDK adapter; credentials are request-scoped. */
export class GeminiProvider extends LlmProviderBase {
  readonly capabilities = GEMINI_CAPABILITIES;
  constructor(
    readonly model: string,
    private readonly clientFactory: (apiKey: string) => GoogleGenAI = (
      apiKey,
    ) => new GoogleGenAI({ apiKey }),
  ) {
    super();
  }

  async healthProbe(options?: LlmCallOptions): Promise<void> {
    try {
      const response = await this.client(options).models.generateContent({
        model: this.model,
        contents: "Reply with ok.",
        config: {
          maxOutputTokens: 1,
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });
      this.usage(options, response.usageMetadata);
      if (!response.text)
        throw new LlmProviderError(
          "gemini",
          "invalid_response",
          "Gemini health probe returned no output",
        );
    } catch (error) {
      throw mapProviderError("gemini", error);
    }
  }

  async generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    try {
      const response = await this.client(options).models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: safeJsonSchema(schema),
          ...(options?.maxOutputTokens
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });
      this.usage(options, response.usageMetadata);
      return schema.parse(parseLlmJson(response.text ?? "", "gemini"));
    } catch (error) {
      throw mapProviderError("gemini", error);
    }
  }

  async generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]> {
    try {
      const response = await this.client(options).models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: safeJsonSchema(tool.parameters) as never,
              })),
            },
          ],
          ...(options?.maxOutputTokens
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });
      this.usage(options, response.usageMetadata);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      return (response.functionCalls ?? []).map((call) => {
        const definition = call.name ? byName.get(call.name) : undefined;
        if (!definition || !call.name)
          throw new LlmProviderError(
            "gemini",
            "invalid_response",
            `Gemini called unknown tool "${call.name ?? ""}"`,
          );
        return {
          name: call.name,
          arguments: definition.parameters.parse(call.args ?? {}),
        };
      });
    } catch (error) {
      throw mapProviderError("gemini", error);
    }
  }

  async *stream(
    prompt: string,
    options?: LlmCallOptions,
  ): AsyncIterable<string> {
    try {
      const stream = await this.client(options).models.generateContentStream({
        model: this.model,
        contents: prompt,
        config: options?.signal ? { abortSignal: options.signal } : undefined,
      });
      let finalUsage:
        | { promptTokenCount?: number; candidatesTokenCount?: number }
        | undefined;
      for await (const chunk of stream) {
        if (chunk.text) yield chunk.text;
        finalUsage = chunk.usageMetadata ?? finalUsage;
      }
      this.usage(options, finalUsage);
    } catch (error) {
      throw mapProviderError("gemini", error);
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
      throw new LlmProviderError(
        "gemini",
        "invalid_request",
        "Gemini image input requires inline image data",
      );
    try {
      const response = await this.client(options).models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: image.mediaType, data } },
            ],
          },
        ],
        config: options?.signal ? { abortSignal: options.signal } : undefined,
      });
      this.usage(options, response.usageMetadata);
      return response.text ?? "";
    } catch (error) {
      throw mapProviderError("gemini", error);
    }
  }

  async describeVideo(
    video: VideoInput,
    prompt = "Describe this video.",
    options?: LlmCallOptions,
  ): Promise<string> {
    const data =
      typeof video.data === "string"
        ? video.data
        : Buffer.from(video.data).toString("base64");
    if (data.startsWith("http")) {
      throw new LlmProviderError(
        "gemini",
        "invalid_request",
        "Gemini video input requires inline video data",
      );
    }
    try {
      const response = await this.client(options).models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: video.mediaType, data } },
            ],
          },
        ],
        config: options?.signal ? { abortSignal: options.signal } : undefined,
      });
      this.usage(options, response.usageMetadata);
      return response.text ?? "";
    } catch (error) {
      throw mapProviderError("gemini", error);
    }
  }

  private client(options?: LlmCallOptions): GoogleGenAI {
    if (!options?.apiKey)
      throw new LlmProviderError(
        "gemini",
        "missing_key",
        "no API key is configured for gemini",
      );
    return this.clientFactory(options.apiKey);
  }
  private usage(
    options: LlmCallOptions | undefined,
    usage:
      { promptTokenCount?: number; candidatesTokenCount?: number } | undefined,
  ): void {
    reportUsage(
      options,
      usage
        ? {
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
          }
        : undefined,
    );
  }
}
