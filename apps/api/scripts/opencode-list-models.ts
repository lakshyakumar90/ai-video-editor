/**
 * Lists chat models available on the local OpenCode server and verifies the
 * preferred order from config actually exists on the server.
 *
 * Run: pnpm --filter api exec tsx scripts/opencode-list-models.ts
 */
import "dotenv/config";
import { OpenCode } from "@opencode/client";
import path from "node:path";
import { LLM_MODEL_FALLBACK } from "../src/services/llm-registry.js";

const auth =
  "Basic " +
  Buffer.from(
    `opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`,
  ).toString("base64");

const client = OpenCode.make({
  baseUrl: process.env.OPENCODE_BASE_URL!,
  headers: { authorization: auth },
});

const repoRoot = path.resolve(import.meta.dirname, "../..");
const { data: models } = await client.model.list({
  location: { directory: repoRoot },
  types: ["chat"],
});

const free = (model: (typeof models)[number]) =>
  (model.cost?.[0]?.output ?? 1) === 0;

console.log(`models on server: ${models.length}\n`);
for (const model of models) {
  console.log(
    `${model.providerID.padEnd(10)} ${model.id.padEnd(48)} ${String(free(model) ? "free" : "paid").padEnd(6)} ${model.status}`,
  );
}

console.log(`\npreferred order (from OPENCODE_MODEL_PREFERENCE, via llm-registry):`);
const available = new Set(
  models.map((model) => `${model.providerID}/${model.id}`),
);
let missing = 0;
LLM_MODEL_FALLBACK.openCode().forEach((model, index) => {
  const ref = `${model.providerID}/${model.modelID}`;
  const found = available.has(ref);
  if (!found) missing++;
  console.log(
    `${index + 1}. ${ref.padEnd(48)} ${found ? "ok" : "MISSING ON SERVER"}`,
  );
});

if (missing > 0) {
  console.error(`\n${missing} preferred model(s) not available on server`);
  process.exit(1);
}
console.log("\nall preferred models available");
