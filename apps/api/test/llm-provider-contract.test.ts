import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiProvider } from "../src/services/openai-llm-provider.js";
import { AnthropicProvider } from "../src/services/anthropic-llm-provider.js";
import { GeminiProvider } from "../src/services/gemini-llm-provider.js";
import type { LlmProvider } from "../src/services/llm-provider.js";

const responseSchema = z.object({ ok: z.boolean() });
const toolSchema = z.object({ value: z.string() });
const tools = [
  { name: "save", description: "Save a value", parameters: toolSchema },
];

interface Fixture {
  name: string;
  provider: LlmProvider;
  respond(value: unknown): void;
}

function fixtures(): Fixture[] {
  const openAiQueue: unknown[] = [];
  const openAiClient = {
    responses: {
      parse: vi.fn(async () => next(openAiQueue)),
      create: vi.fn(async () => next(openAiQueue)),
    },
  };
  const anthropicQueue: unknown[] = [];
  const anthropicClient = {
    messages: {
      create: vi.fn(async () => next(anthropicQueue)),
    },
  };
  const geminiQueue: unknown[] = [];
  const geminiClient = {
    models: {
      generateContent: vi.fn(async () => next(geminiQueue)),
    },
  };
  return [
    {
      name: "openai",
      provider: new OpenAiProvider("test-model", () => openAiClient as never),
      respond: (value) => openAiQueue.push(value),
    },
    {
      name: "anthropic",
      provider: new AnthropicProvider(
        "test-model",
        () => anthropicClient as never,
      ),
      respond: (value) => anthropicQueue.push(value),
    },
    {
      name: "gemini",
      provider: new GeminiProvider("test-model", () => geminiClient as never),
      respond: (value) => geminiQueue.push(value),
    },
  ];
}

function next(queue: unknown[]): unknown {
  const value = queue.shift();
  if (
    value instanceof Error ||
    (typeof value === "object" && value !== null && "status" in value)
  )
    throw value;
  return value;
}

describe.each(fixtures())("$name adapter contract", ({ provider, respond }) => {
  it("returns schema-validated JSON and validated tool operations", async () => {
    const toolArgs = { value: "ok" };
    if (provider instanceof OpenAiProvider) {
      respond({
        output_parsed: { ok: true },
        usage: { input_tokens: 4, output_tokens: 2 },
      });
      respond({
        output: [
          {
            type: "function_call",
            name: "save",
            call_id: "call-1",
            arguments: JSON.stringify(toolArgs),
          },
        ],
      });
    } else if (provider instanceof AnthropicProvider) {
      respond({
        content: [{ type: "text", text: '{"ok":true}' }],
        usage: { input_tokens: 4, output_tokens: 2 },
      });
      respond({
        content: [
          { type: "tool_use", id: "tool-1", name: "save", input: toolArgs },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    } else {
      respond({
        text: '{"ok":true}',
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      });
      respond({
        functionCalls: [{ name: "save", args: toolArgs }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      });
    }
    await expect(
      provider.generateJson("return ok", responseSchema, {
        apiKey: "test-key",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      provider.generateWithTools("save ok", tools, { apiKey: "test-key" }),
    ).resolves.toMatchObject([{ name: "save", arguments: toolArgs }]);
  });

  it("maps unauthorized and timed-out SDK failures to stable error codes", async () => {
    respond({ status: 401, message: "bad credential" });
    await expect(
      provider.generateJson("return ok", responseSchema, { apiKey: "bad-key" }),
    ).rejects.toMatchObject({ code: "invalid_key" });
    respond(new DOMException("request timed out", "TimeoutError"));
    await expect(
      provider.generateJson("return ok", responseSchema, {
        apiKey: "test-key",
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("optional live adapter smoke tests", () => {
  const enabled = process.env.LLM_LIVE_SMOKE === "1";
  it.skipIf(!enabled || !process.env.OPENAI_API_KEY)(
    "OpenAI accepts a minimal health call",
    async () => {
      await new OpenAiProvider(process.env.OPENAI_MODEL ?? "gpt-4.1-mini")
        .healthProbe!({ apiKey: process.env.OPENAI_API_KEY });
    },
  );
  it.skipIf(!enabled || !process.env.ANTHROPIC_API_KEY)(
    "Anthropic accepts a minimal health call",
    async () => {
      await new AnthropicProvider(
        process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      ).healthProbe!({ apiKey: process.env.ANTHROPIC_API_KEY });
    },
  );
  it.skipIf(!enabled || !process.env.GEMINI_API_KEY)(
    "Gemini accepts a minimal health call",
    async () => {
      await new GeminiProvider(process.env.GEMINI_MODEL ?? "gemini-2.5-flash")
        .healthProbe!({ apiKey: process.env.GEMINI_API_KEY });
    },
  );
});
