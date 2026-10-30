import { pino, type Logger, type LoggerOptions } from "pino";
import type { DestinationStream } from "pino";

/**
 * Field paths that must never appear in log output in plain text.
 *
 * These are redacted defensively, before any API-key handling exists:
 * users bring their own API keys (docs/decision-deployment.md) and a
 * request body or header that carries one must never reach disk-level
 * log aggregation. Extend this list - not ad-hoc code - whenever a new
 * secret-bearing field appears.
 */
export const REDACT_PATHS = [
  // Request headers
  'req.headers["authorization"]',
  'req.headers["x-api-key"]',
  // Payload fields, top level and one nesting level deep
  "authorization",
  "*.authorization",
  "apiKey",
  "*.apiKey",
  "x-api-key",
  "*.x-api-key",
] as const;

export const REDACT_CENSOR = "[REDACTED]";

const redaction: LoggerOptions["redact"] = {
  paths: [...REDACT_PATHS],
  censor: REDACT_CENSOR,
  remove: false,
};

/** Creates a pino logger with secret redaction always enabled. */
export function createLogger(
  options: {
    level?: LoggerOptions["level"];
    destination?: DestinationStream;
    base?: LoggerOptions["base"];
  } = {},
): Logger {
  return pino(
    {
      level: options.level ?? "info",
      redact: redaction,
      base: options.base,
    },
    options.destination,
  );
}

/** The shared application logger. */
export const logger: Logger = createLogger();
