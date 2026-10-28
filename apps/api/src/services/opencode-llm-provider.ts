import { OpenCode, type OpenCodeClient } from "@opencode/client";
import type { ZodType } from "zod";
import type { LlmProvider } from "./llm-provider.js";

/** A model reference as used in session creation. */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeProviderOptions {
  /** OpenCode server base URL, e.g. http://127.0.0.1:4096. */
  baseUrl: string;
  /** OpenCode server password (HTTP Basic, username "opencode"). */
  password: string;
  /** Project directory the server sessions operate in. */
  directory: string;
  /** Preferred models, highest priority first. Failed attempts fall through to the next entry. */
  models?: ModelRef[];
  /** Budget for waiting on the agent loop per model attempt, in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export class OpenCodeProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OpenCodeProviderError";
  }
}

/** Prepended to every prompt: the model must emit a single bare JSON value. */
export const SYSTEM_INSTRUCTIONS =
  "You are a JSON generation service. Follow these rules exactly: " +
  "1) Respond with exactly one JSON value and nothing else - no markdown, " +
  "no code fences, no commentary, no labels. 2) The JSON value must satisfy " +
  "the shape requested by the user prompt. 3) Do not wrap strings in " +
  "resources or explanations.";

export const DEFAULT_OPENCODE_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "flint-40b-free",
};

/** Timeout budget for waiting on the agent loop, per model attempt. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * `LlmProvider` backed by a local OpenCode server.
 *
 * Each {@link generateJson} call runs in its own short-lived session: the
 * prompt is sent with system instructions inline, the agent loop is awaited,
 * the assistant reply is extracted as text, parsed as JSON, and validated
 * against the caller's schema. Sessions are always removed afterwards.
 */
export class OpenCodeProvider implements LlmProvider {
  private readonly client: OpenCodeClient;
  private readonly models: ModelRef[];
  private readonly directory: string;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeProviderOptions) {
    const auth =
      "Basic " + Buffer.from(`opencode:${options.password}`).toString("base64");
    this.client = OpenCode.make({
      baseUrl: options.baseUrl,
      headers: { authorization: auth },
      fetch: options.fetch,
    });
    this.models = options.models ?? [DEFAULT_OPENCODE_MODEL];
    this.directory = options.directory;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    if (prompt.trim().length === 0) {
      throw new OpenCodeProviderError("prompt must not be empty");
    }

    let lastError: unknown;
    for (const model of this.models) {
      try {
        const value = await this.runSession(prompt, model);
        return schema.parse(value);
      } catch (error) {
        lastError = error;
      }
    }

    throw new OpenCodeProviderError(
      `all ${this.models.length} model(s) failed to return valid JSON`,
      lastError,
    );
  }

  /** One create → prompt → wait → read cycle against a single model. */
  private async runSession(prompt: string, model: ModelRef): Promise<unknown> {
    const session = await this.client.session.create({
      title: "api: generateJson",
      model: { providerID: model.providerID, id: model.modelID },
      location: { directory: this.directory },
    });

    try {
      const text = [
        "[Instructions]",
        SYSTEM_INSTRUCTIONS,
        "",
        "[Request]",
        prompt,
      ].join("\n");

      await this.client.session.prompt({ sessionID: session.id, text });
      await this.client.session.wait(
        { sessionID: session.id },
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );

      const messages = await this.client.message.list({ sessionID: session.id });
      const assistant = [...messages.data]
        .reverse()
        .find((message) => message.type === "assistant");
      if (!assistant || assistant.type !== "assistant") {
        throw new OpenCodeProviderError("no assistant reply in session");
      }

      const reply = assistant.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      return parseJsonReply(reply);
    } finally {
      await this.client.session
        .remove({ sessionID: session.id })
        .catch(() => undefined);
    }
  }
}

/** Strips markdown fences and stray prose, then parses the JSON value. */
export function parseJsonReply(text: string): unknown {
  let raw = text.trim();

  const fenced = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenced?.[1]) {
    raw = fenced[1].trim();
  }

  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    const start = Math.min(
      ...[raw.indexOf("{"), raw.indexOf("[")].filter((index) => index !== -1),
    );
    const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    if (Number.isFinite(start) && end > start) {
      raw = raw.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new OpenCodeProviderError(
      `reply is not parseable JSON: ${text.slice(0, 200)}`,
      error,
    );
  }
}
