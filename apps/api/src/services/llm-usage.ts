import { authDatabase } from "./auth.js";
import { env } from "../config/env.js";
import type { RoutedUsage } from "./llm-task-router.js";

authDatabase.exec(`
  CREATE TABLE IF NOT EXISTS llm_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    payer TEXT NOT NULL CHECK (payer IN ('user', 'platform', 'local')),
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    created_at TEXT NOT NULL
  )
`);

export interface LlmUsageRecord extends RoutedUsage {
  userId: string;
  estimatedCostUsd: number | null;
}

export function estimateLlmCost(usage: RoutedUsage): number | null {
  if (usage.payer === "local") return 0;
  let priceTable: Record<
    string,
    { inputPerMillionUsd: number; outputPerMillionUsd: number }
  >;
  try {
    priceTable = JSON.parse(env.LLM_MODEL_PRICING_JSON) as typeof priceTable;
  } catch {
    return null;
  }
  const price =
    priceTable[`${usage.providerId}:${usage.model}`] ?? priceTable[usage.model];
  if (
    !price ||
    !Number.isFinite(price.inputPerMillionUsd) ||
    !Number.isFinite(price.outputPerMillionUsd)
  )
    return null;
  return Number(
    (
      (usage.inputTokens * price.inputPerMillionUsd +
        usage.outputTokens * price.outputPerMillionUsd) /
      1_000_000
    ).toFixed(8),
  );
}

export function recordLlmUsage(
  userId: string,
  usage: RoutedUsage,
): LlmUsageRecord {
  const record: LlmUsageRecord = {
    ...usage,
    userId,
    estimatedCostUsd: estimateLlmCost(usage),
  };
  authDatabase
    .prepare(
      `INSERT INTO llm_usage_events
    (user_id, provider_id, model, payer, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      usage.providerId,
      usage.model,
      usage.payer,
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      record.estimatedCostUsd,
      new Date().toISOString(),
    );
  return record;
}
