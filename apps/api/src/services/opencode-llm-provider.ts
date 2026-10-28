import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { z, type ZodType } from "zod";
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
  "no code fences, no commentary, no labels. 2) If a JSON Schema is provided " +
  "below, the JSON value MUST conform to that schema. 3) Do not wrap the " +
  "JSON in quotes, resources, or explanations.";

export const DEFAULT_OPENCODE_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "flint-40b-free",
};

/** Timeout budget for waiting on the agent loop, per model attempt. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Prompt sent to the model: system instructions, the JSON Schema, and the request. */
export function buildPromptText(prompt: string, schema: ZodType): string {
  let shape = "";
  try {
    shape = JSON.stringify(z.toJSONSchema(schema));
  } catch {
    // schemas with unrepresentable constructs (transforms, custom types)
    // simply don't contribute a machine-readable shape
  }

  return [
    "[Instructions]",
    SYSTEM_INSTRUCTIONS,
    "",
    `[JSON Schema]${shape ? ` ${shape}` : " (described in the request)"}`,
    "",
    "[Request]",
    prompt,
  ].join("\n");
}

/**
 * `LlmProvider` backed by a local OpenCode server.
 *
 * Each {@link generateJson} call runs in its own short-lived session: the
 * prompt is sent with system instructions inline, the agent loop is awaited,
 * the assistant reply is extracted as text, parsed as JSON, and validated
 * against the caller's schema. Sessions are always removed afterwards.
 */
/** Extra repair rounds allowed per model when validation fails. */
const VALIDATION_RETRIES = 1;

/** Formats a `ZodError` into a short issue list to append to a repair prompt. */
export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Appends the validation error from the previous attempt to the original
 * prompt, so the model sees exactly which rules its reply violated.
 */
export function buildRepairPrompt(prompt: string, schema: ZodType, error: z.ZodError): string {
  return [
    buildPromptText(prompt, schema),
    "",
    "[Validation Failure]",
    "Your previous reply did not satisfy the JSON Schema above.",
    "Produce one corrected JSON value conforming to the schema and nothing else.",
    "",
    `[Validation Error] ${formatValidationIssues(error)}`,
  ].join("\n");
}

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
      let text = buildPromptText(prompt, schema);

      // One validation-repair round: an invalid *shape* (ZodError) gets a
      // second attempt with the failure appended to the prompt. Unparseable
      // replies and transport errors go straight to the next model.
      for (let attempt = 0; attempt <= VALIDATION_RETRIES; attempt++) {
        try {
          const value = await this.runSession(text, model);
          return schema.parse(value);
        } catch (error) {
          if (
            error instanceof z.ZodError &&
            attempt < VALIDATION_RETRIES
          ) {
            text = buildRepairPrompt(prompt, schema, error);
            lastError = error;
            continue;
          }
          lastError = error;
          break;
        }
      }
    }

    throw new OpenCodeProviderError(
      `all ${this.models.length} model(s) failed to return valid JSON`,
      lastError,
    );
  }

  /** One create → prompt → wait → read cycle against a single model. */
  private async runSession(
    text: string,
    model: ModelRef,
  ): Promise<unknown> {
    const session = await this.client.session.create({
      title: "api: generateJson",
      model: { providerID: model.providerID, id: model.modelID },
      location: { directory: this.directory },
    });

    try {
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

/** Strips markdown fences (even embedded in prose) and stray prose, then parses. */
export function parseJsonReply(text: string): unknown {
  let raw = text.trim();

  // Strip the first fenced code block, wherever it sits in the reply.
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenced?.[1] && fenced[1].trim().length > 0) {
    raw = fenced[1].trim();
  }

  const attempts: string[] = [raw];
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    attempts.push(sliceToOuterBrackets(raw));
  }

  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  // Starts with a bracket but raw JSON.parse failed (e.g. trailing
  // commentary after the closing bracket) — retry with bracket slicing.
  try {
    return JSON.parse(sliceToOuterBrackets(raw));
  } catch (error) {
    throw new OpenCodeProviderError(
      `reply is not parseable JSON: ${text.slice(0, 200)}`,
      error ?? lastError,
    );
  }
}

/** Slices `raw` from the first `{`/`[` to the last `}`/`]`, if both exist. */
function sliceToOuterBrackets(raw: string): string {
  const start = Math.min(
    ...[raw.indexOf("{"), raw.indexOf("[")].filter((index) => index !== -1),
  );
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  return Number.isFinite(start) && end > start ? raw.slice(start, end + 1) : raw;
}
