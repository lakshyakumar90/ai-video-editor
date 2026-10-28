/**
 * Spike: reach the local OpenCode server from code.
 *
 * Connects a client, creates a session pinned to a free model, sends one
 * prompt, waits for the agent loop to go idle, and prints the reply.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-opencode-prompt.ts
 */
import "dotenv/config";
import { OpenCode } from "@opencode/client";
import path from "node:path";

const baseUrl = process.env.OPENCODE_BASE_URL;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const modelProviderID = process.env.OPENCODE_MODEL_PROVIDER ?? "opencode";
const modelID = process.env.OPENCODE_MODEL_ID ?? "flint-40b-free";

if (!baseUrl || !password) {
  console.error(
    "Missing OPENCODE_BASE_URL or OPENCODE_SERVER_PASSWORD in apps/api/.env",
  );
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const client = OpenCode.make({
  baseUrl,
  headers: { authorization: auth },
});

const repoRoot = path.resolve(import.meta.dirname, "../..");
const promptText =
  "Reply with exactly one short sentence: what is a large language model?";

const session = await client.session.create({
  title: "spike: single prompt",
  model: { providerID: modelProviderID, id: modelID },
  location: { directory: repoRoot },
});
console.log(`session: ${session.id} (model ${modelProviderID}/${modelID})`);

try {
  await client.session.prompt({ sessionID: session.id, text: promptText });
  await client.session.wait(
    { sessionID: session.id },
    { signal: AbortSignal.timeout(120_000) },
  );

  const messages = await client.message.list({ sessionID: session.id });
  const assistant = [...messages.data]
    .reverse()
    .find((message) => message.type === "assistant");

  if (!assistant || assistant.type !== "assistant") {
    throw new Error("No assistant message found after wait");
  }

  const reply = assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  console.log("reply:", reply);
  console.log(
    `tokens: ${JSON.stringify(assistant.tokens ?? null)} finish: ${assistant.finish ?? "n/a"}`,
  );
} finally {
  await client.session.remove({ sessionID: session.id });
  console.log("session removed");
}
