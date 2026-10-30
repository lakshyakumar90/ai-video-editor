export type LlmProviderErrorCode =
  | "missing_key"
  | "invalid_key"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "invalid_request"
  | "unknown";

export class LlmProviderError extends Error {
  constructor(
    readonly providerId: string,
    readonly code: LlmProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LlmProviderError";
  }

  get retryable(): boolean {
    return ["rate_limit", "quota", "timeout", "unavailable"].includes(
      this.code,
    );
  }
}

/** Normalize provider HTTP/transport failures without leaking response bodies. */
export function mapProviderError(
  providerId: string,
  error: unknown,
): LlmProviderError {
  if (error instanceof LlmProviderError) return error;
  const record =
    typeof error === "object" && error !== null
      ? (error as {
          status?: unknown;
          message?: unknown;
          name?: unknown;
          cause?: unknown;
        })
      : undefined;
  const cause =
    typeof record?.cause === "object" && record.cause !== null
      ? (record.cause as {
          status?: unknown;
          message?: unknown;
          name?: unknown;
        })
      : undefined;
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof cause?.status === "number"
        ? cause.status
        : undefined;
  const message =
    typeof record?.message === "string"
      ? record.message
      : typeof cause?.message === "string"
        ? cause.message
        : error instanceof Error
          ? error.message
          : String(error);
  const name = record?.name ?? cause?.name;

  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timed? ?out/i.test(message)
  ) {
    return new LlmProviderError(
      providerId,
      "timeout",
      `${providerId} request timed out`,
      { cause: error },
    );
  }
  if (status === 401 || status === 403) {
    return new LlmProviderError(
      providerId,
      "invalid_key",
      `${providerId} rejected the API key`,
      { cause: error },
    );
  }
  if (status === 429) {
    const code = /quota|insufficient[_ -]?credits|billing/i.test(message)
      ? "quota"
      : "rate_limit";
    return new LlmProviderError(
      providerId,
      code,
      code === "quota"
        ? `${providerId} quota or billing limit reached`
        : `${providerId} rate limit reached`,
      { cause: error },
    );
  }
  if (status === 408) {
    return new LlmProviderError(
      providerId,
      "timeout",
      `${providerId} request timed out`,
      { cause: error },
    );
  }
  if (status !== undefined && status >= 500) {
    return new LlmProviderError(
      providerId,
      "unavailable",
      `${providerId} is temporarily unavailable`,
      { cause: error },
    );
  }
  if (status !== undefined && status >= 400) {
    return new LlmProviderError(
      providerId,
      "invalid_request",
      `${providerId} rejected the request (${status})`,
      { cause: error },
    );
  }
  return new LlmProviderError(
    providerId,
    "unavailable",
    `${providerId} could not be reached`,
    { cause: error },
  );
}
