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
  /** Total tries per individual SDK call (create/prompt/wait/list). Default 3. */
  retries?: number;
  /** Exponential backoff base between SDK-call retries, in milliseconds. Default 500. */
  retryBaseDelayMs?: number;
  /** Per-attempt timeout for each SDK call except `wait`. Default 30000ms. */
  callTimeoutMs?: number;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export class OpenCodeProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OpenCodeProviderError";
  }
}

export interface RetryOptions {
  /** Total tries (not retries). 1 = run once, no retries. Default 3. */
  attempts?: number;
  /** Backoff after the 1st failure. Default 500ms, doubling per retry. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay. Default 8000ms. */
  maxDelayMs?: number;
  /** Per-attempt timeout in milliseconds. 0 disables. Default 0. */
  timeoutMs?: number;
  /** Which errors are worth retrying. Default: {@link isTransientError}. */
  shouldRetry?: (error: unknown) => boolean;
}

/** Rejects with `TimeoutError` if `promise` has not settled after `timeoutMs`. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  // The losing promise may reject after the race settles; silence it so it
  // cannot surface as an unhandled rejection.
  void promise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DOMException(`timed out after ${timeoutMs}ms`, "TimeoutError"),
        ),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs an async operation with a per-attempt timeout and exponential
 * backoff between retries. A non-retryable error (per `shouldRetry`)
 * or the exhaustion of `attempts` rejects with the last error.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    timeoutMs = 0,
  } = options;
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const work = operation(attempt);
      return await (timeoutMs > 0 ? withTimeout(work, timeoutMs) : work);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      await delay(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Transient SDK/server/transport failures worth retrying with backoff. */
export function isTransientError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;

  // SDK ClientError("Transport", …) — network-level failure
  if (error.name === "ClientError" && error.message.startsWith("Transport")) {
    return true;
  }

  const status = extractStatus(error);
  return status !== null && (status >= 500 || status === 408);
}

function extractStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as { status?: unknown }).status === "number"
  ) {
    return (cause as { status: number }).status;
  }
  const match =
    error instanceof Error
      ? /\bUnexpectedStatus:\s*(\d{3})\b/.exec(error.message)
      : null;
  return match ? Number(match[1]) : null;
}

/** Prepended to every prompt: the model must emit a single bare JSON value. */
export const SYSTEM_INSTRUCTIONS =
  "You are a JSON generation service. Follow these rules exactly: " +
  "1) Respond with exactly one JSON value and nothing else - no markdown, " +
  "no code fences, no commentary, no labels. 2) If a JSON Schema is provided " +
  "below, the JSON value MUST conform to that schema. 3) Do not wrap the " +
  "JSON in quotes, resources, or explanations. 4) Any narration text must " +
  "be paced for real-time playback: about 2.5 words per second of the " +
  "scene's stated runtime (e.g. about 20 words for an 8-second scene; aim " +
  "for 18-24 and never fewer than 16). If the request does not state a " +
  "runtime, write full, flowing sentences of about 25 words per scene " +
  "rather than short captions.";

export const DEFAULT_OPENCODE_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "flint-40b-free",
};

/** Timeout budget for waiting on the agent loop, per model attempt. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Default per-attempt timeout for a single SDK call. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Default total tries per SDK call. */
const DEFAULT_RETRIES = 3;
/** Default backoff base between SDK-call retries. */
const DEFAULT_RETRY_BASE_MS = 500;

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
 * Capabilities (honest): JSON-in-text only, no native tool calling -
 * see {@link SUPPORTED_LLM_CAPABILITIES}. Free CLI models return plain
 * assistant text, so every prompt embeds the JSON schema
 * ({@link SYSTEM_INSTRUCTIONS}) and replies are parsed defensively
 * ({@link parseJsonReply}); there is no tool-calling loop.
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

/** Short one-line rendering of any failure for the aggregate error message. */
function summarizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "unknown failure";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * Thrown when **every** preferred model was rejected with a rate-limit or
 * quota error. Extends {@link OpenCodeProviderError} so legacy
 * `instanceof` checks still match; the UI distinguishes it by this class
 * (or `error.name === "RateLimitError"`) to show a capacity message
 * instead of a generic failure, using {@link RateLimitError.limitedModels}.
 */
export class RateLimitError extends OpenCodeProviderError {
  /** Models that were throttled, as `provider/model` refs in preference order. */
  readonly limitedModels: string[];

  constructor(message: string, limitedModels: string[], cause?: unknown) {
    super(message, cause);
    this.name = "RateLimitError";
    this.limitedModels = limitedModels;
  }
}

/**
 * Appends the validation error from the previous attempt to the original
 * prompt, so the model sees exactly which rules its reply violated.
 */
export function buildRepairPrompt(
  prompt: string,
  schema: ZodType,
  error: z.ZodError,
): string {
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

/** HTTP statuses the SDK surfaces on `cause.status` for throttled/over-quota calls. */
const RATE_LIMIT_STATUSES = [429, 402];
/** Words the server / upstream providers use for throttling and quota exhaustion. */
const RATE_LIMIT_PATTERN =
  /\brate.?limit\b|too many requests|quota|resource.?exhausted|exceeded your|usage cap|insufficient (?:credits|balance)|\b429\b|\b402\b/i;

/**
 * Detects rate-limit and quota errors from the OpenCode server or its
 * upstream providers — either as a raw HTTP status (429/402 surfaced by
 * the client as `ClientError` with `cause: { status }`) or in the error
 * body / message text of tagged errors like `ProviderRequestError`.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const texts: Array<string | number> = [error.message, error.name];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    texts.push(cause.message, cause.name);
  } else if (typeof cause === "object" && cause !== null) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === "number") texts.push(status);
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string") texts.push(message);
  }

  return texts.some((text) =>
    typeof text === "number"
      ? RATE_LIMIT_STATUSES.includes(text)
      : RATE_LIMIT_PATTERN.test(text),
  );
}

export class OpenCodeProvider implements LlmProvider {
  private readonly client: OpenCodeClient;
  private readonly models: ModelRef[];
  private readonly directory: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly callTimeoutMs: number;

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
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Runs one SDK call with timeout + bounded exponential-backoff retries. */
  private call<T>(factory: () => Promise<T>): Promise<T> {
    return withRetry(factory, {
      attempts: this.retries,
      baseDelayMs: this.retryBaseDelayMs,
      timeoutMs: this.callTimeoutMs,
    });
  }

  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    if (prompt.trim().length === 0) {
      throw new OpenCodeProviderError("prompt must not be empty");
    }

    let lastError: unknown;
    const failures: Array<{
      model: ModelRef;
      rateLimited: boolean;
      summary: string;
    }> = [];
    for (const model of this.models) {
      let text = buildPromptText(prompt, schema);

      // One validation-repair round per model. A rate-limit/quota failure
      // is never repaired — that model's capacity is gone for now, so we
      // fall through to the next free model immediately.
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await this.runSession(text, model);
          return schema.parse(value);
        } catch (error) {
          lastError = error;

          if (error instanceof z.ZodError && attempt < VALIDATION_RETRIES) {
            text = buildRepairPrompt(prompt, schema, error);
            continue;
          }

          failures.push({
            model,
            rateLimited: isRateLimitError(error),
            summary: summarizeError(error),
          });
          break;
        }
      }
    }

    const failureText = failures
      .map(
        (f) =>
          `${f.model.providerID}/${f.model.modelID}: ${
            f.rateLimited ? "rate limit or quota exhausted" : f.summary
          }`,
      )
      .join(" | ");

    // Every model throttled ⇒ typed error the UI can explain to the user.
    if (failures.length > 0 && failures.every((f) => f.rateLimited)) {
      throw new RateLimitError(
        `all ${failures.length} model(s) are rate-limited or over quota - ${failureText}`,
        failures.map((f) => `${f.model.providerID}/${f.model.modelID}`),
        lastError,
      );
    }

    throw new OpenCodeProviderError(
      `all ${this.models.length} model(s) failed - ${failureText}`,
      lastError,
    );
  }

  /** One create → prompt → wait → read cycle against a single model. */
  private async runSession(text: string, model: ModelRef): Promise<unknown> {
    const session = await this.call(() =>
      this.client.session.create({
        title: "api: generateJson",
        model: { providerID: model.providerID, id: model.modelID },
        location: { directory: this.directory },
      }),
    );

    try {
      await this.call(() =>
        this.client.session.prompt({ sessionID: session.id, text }),
      );
      await withRetry(
        () =>
          this.client.session.wait(
            { sessionID: session.id },
            { signal: AbortSignal.timeout(this.timeoutMs) },
          ),
        {
          attempts: this.retries,
          baseDelayMs: this.retryBaseDelayMs,
          // the wait call is inherently long; its own budget applies per attempt
          timeoutMs: this.timeoutMs,
        },
      );

      const messages = await this.call(() =>
        this.client.message.list({ sessionID: session.id }),
      );
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
      // Best-effort cleanup; a failure here must never mask the result.
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
  return Number.isFinite(start) && end > start
    ? raw.slice(start, end + 1)
    : raw;
}
