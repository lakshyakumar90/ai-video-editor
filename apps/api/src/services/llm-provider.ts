import { z, type ZodType } from "zod";

export type StructuredOutputCapability =
  "none" | "json-in-text" | "json-schema";

/** What an adapter can actually deliver for its configured model. */
export interface ProviderCapabilities {
  structuredOutput: StructuredOutputCapability;
  toolCalling: boolean;
  vision: boolean;
  streaming: boolean;
  /** Null means the provider/model does not publish a known limit. */
  maxContext: number | null;
}

/** Compatibility name retained for existing registry consumers. */
export type LlmCapabilities = ProviderCapabilities;

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Request-scoped context. Do not retain these values after an invocation. */
export interface LlmCallOptions {
  apiKey?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  onUsage?: (usage: ProviderUsage) => void;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: ZodType;
}

/** A proposed operation. Callers validate and execute it in their own policy layer. */
export interface LlmToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface ImageInput {
  data: string | Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export interface VideoInput {
  data: string | Uint8Array;
  mediaType: string;
}

export class UnsupportedCapabilityError extends Error {
  constructor(capability: string) {
    super(`provider does not support ${capability}`);
    this.name = "UnsupportedCapabilityError";
  }
}

/**
 * A schema-validated, multi-modal LLM adapter. Credentials and usage callbacks
 * are supplied per call so a shared registry never owns a user's secret.
 */
export interface LlmProvider {
  readonly capabilities: ProviderCapabilities;

  healthProbe?(options?: LlmCallOptions): Promise<void>;

  generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T>;

  generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]>;

  stream(prompt: string, options?: LlmCallOptions): AsyncIterable<string>;

  describeImage(
    image: ImageInput,
    prompt?: string,
    options?: LlmCallOptions,
  ): Promise<string>;

  describeVideo(
    video: VideoInput,
    prompt?: string,
    options?: LlmCallOptions,
  ): Promise<string>;
}

/** Common JSON-in-text tool and streaming fallback for simpler adapters. */
export abstract class LlmProviderBase implements LlmProvider {
  abstract readonly capabilities: ProviderCapabilities;

  abstract generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T>;

  async generateWithTools(
    prompt: string,
    tools: readonly LlmToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmToolCall[]> {
    if (tools.length === 0) return [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (byName.size !== tools.length) {
      throw new Error("tool names must be unique");
    }
    const names = [...byName.keys()] as [string, ...string[]];
    const resultSchema = z.object({
      operations: z.array(
        z.object({
          name: z.enum(names),
          arguments: z.record(z.string(), z.unknown()),
        }),
      ),
    });
    const result = await this.generateJson(
      [
        "Return one JSON object with an operations array. Each operation must contain a tool name and arguments object.",
        "Use only the listed tools and provide arguments that match that tool's parameter schema.",
        `Tools: ${JSON.stringify(
          tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters: safeJsonSchema(parameters),
          })),
        )}`,
        `Request: ${prompt}`,
      ].join("\n\n"),
      resultSchema,
      options,
    );

    return result.operations.map(({ name, arguments: args }) => ({
      name,
      arguments: byName.get(name)!.parameters.parse(args),
    }));
  }

  async *stream(
    prompt: string,
    options?: LlmCallOptions,
  ): AsyncIterable<string> {
    const value = await this.generateJson(prompt, z.unknown(), options);
    yield JSON.stringify(value);
  }

  async describeImage(
    _image: ImageInput,
    _prompt = "Describe this image.",
    _options?: LlmCallOptions,
  ): Promise<string> {
    throw new UnsupportedCapabilityError("vision");
  }

  async describeVideo(
    _video: VideoInput,
    _prompt = "Describe this video.",
    _options?: LlmCallOptions,
  ): Promise<string> {
    throw new UnsupportedCapabilityError("video input");
  }
}

export function safeJsonSchema(schema: ZodType): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

export function reportUsage(
  options: LlmCallOptions | undefined,
  usage: Partial<ProviderUsage> | undefined,
): void {
  if (!usage || !options?.onUsage) return;
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens ?? 0));
  options.onUsage({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

export const JSON_IN_TEXT_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json-in-text",
  toolCalling: false,
  vision: false,
  streaming: false,
  maxContext: null,
};

export const SUPPORTED_LLM_CAPABILITIES = JSON_IN_TEXT_CAPABILITIES;
