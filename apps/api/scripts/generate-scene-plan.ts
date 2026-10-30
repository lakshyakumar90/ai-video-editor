/**
 * One command: prompt -> valid scene plan.
 *
 * Resolves the LLM provider through the registry (LLM_PROVIDER env var,
 * default `opencode`), validates the reply against the shared
 * `scenePlansSchema`, and prints the plan. The OpenCode adapter falls
 * back across `OPENCODE_MODEL_PREFERENCE` models on rate limits and
 * failures; `LLM_PROVIDER=fake` returns the hardcoded script offline.
 *
 * Run: pnpm --filter api exec tsx scripts/generate-scene-plan.ts "your prompt"
 */
import "dotenv/config";
import {
  generateScenePlansResponseSchema,
  type GenerateScenePlansResponse,
} from "@repo/shared";
import { describeLlmProviders, getLlmProvider } from "../src/services/llm-registry.js";

const prompt = process.argv.slice(2).join(" ").trim();

if (prompt.length === 0) {
  console.error("usage: generate-scene-plan.ts \"<prompt>\"");
  console.error("env: LLM_PROVIDER (fake | opencode | hosted-openai), OPENCODE_MODEL_PREFERENCE");
  process.exit(1);
}

for (const descriptor of describeLlmProviders()) {
  const models = descriptor.models
    ?.map((model) => `${model.providerID}/${model.modelID}`)
    .join(", ");
  console.log(
    `${descriptor.name.padEnd(14)} ${descriptor.deployment.padEnd(12)} ${descriptor.capabilities.structuredOutput}${models ? ` | fallback: ${models}` : ""}`,
  );
}
console.log(`\nresolved provider: ${process.env.LLM_PROVIDER ?? "opencode"}\n`);

const provider = getLlmProvider();
const started = Date.now();
const plan: GenerateScenePlansResponse = await provider.generateJson(
  prompt,
  generateScenePlansResponseSchema,
);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`scene plan validated (${plan.scenes.length} scenes, ${seconds}s):\n`);
console.log(JSON.stringify(plan, null, 2));
