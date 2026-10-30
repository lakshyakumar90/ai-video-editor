import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmProvider } from "../src/services/llm-provider.js";
import {
  OPENAI_COMPATIBLE_PRESETS,
  OpenAiCompatibleProvider,
  type OpenAiCompatibleProviderOptions,
} from "../src/services/hosted-llm-provider.js";
import { OpenCodeProvider } from "../src/services/opencode-llm-provider.js";

const oneSceneSchema = z.object({
  title: z.string().min(1),
  year: z.number().int(),
});

describe("OpenAiCompatibleProvider (second-provider stub)", () => {
  const makeHostedFetch = () => {
    const calls: Array<{ url: string; auth: string; body: unknown }> = [];
    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization") ?? "",
        body: JSON.parse(init?.body as string),
      });
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"Dawn Run","year":2026}' } },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return { calls, fetchMock };
  };

  const options: OpenAiCompatibleProviderOptions = {
    baseUrl: "https://hosted.example/v0/",
    model: "hosted-flash-free",
  };

  it("calls the hosted chat-completions endpoint and validates the reply", async () => {
    const { calls, fetchMock } = makeHostedFetch();
    const usage: Array<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }> = [];
    const provider = new OpenAiCompatibleProvider({
      ...options,
      fetch: fetchMock,
    });

    const result = await provider.generateJson(
      "one scene about a morning run",
      oneSceneSchema,
      { apiKey: "hosted-api-key", onUsage: (value) => usage.push(value) },
    );

    expect(result).toEqual({ title: "Dawn Run", year: 2026 });
    expect(calls[0]?.url).toBe("https://hosted.example/v0/chat/completions");
    expect(calls[0]?.auth).toBe("Bearer hosted-api-key");
    const body = calls[0]?.body as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string }>;
    };
    expect(body.model).toBe("hosted-flash-free");
    expect(body.response_format.type).toBe("json_object");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(usage).toEqual([
      { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    ]);
  });

  it("rejects an empty prompt without calling the API", async () => {
    const { calls, fetchMock } = makeHostedFetch();
    const provider = new OpenAiCompatibleProvider({
      ...options,
      fetch: fetchMock,
    });

    await expect(
      provider.generateJson("   ", oneSceneSchema),
    ).rejects.toThrowError(/empty/);
    expect(calls).toHaveLength(0);
  });

  it("uses native tool calls and validates arguments against each tool schema", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://hosted.example/v1",
      model: "tool-model",
      fetch: async (_input, init) => {
        const body = JSON.parse(init?.body as string) as {
          tools: Array<{ function: { name: string } }>;
        };
        expect(body.tools[0]?.function.name).toBe("setSpeed");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-1",
                      function: {
                        name: "setSpeed",
                        arguments: '{"clipId":"clip-1","speed":2}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      },
    });
    const calls = await provider.generateWithTools(
      "double the clip speed",
      [
        {
          name: "setSpeed",
          description: "Set playback speed",
          parameters: z.object({
            clipId: z.string(),
            speed: z.number().min(0.1),
          }),
        },
      ],
      { apiKey: "byok-key" },
    );
    expect(calls).toEqual([
      {
        id: "call-1",
        name: "setSpeed",
        arguments: { clipId: "clip-1", speed: 2 },
      },
    ]);
  });

  it("sends image data to a vision-capable compatible model", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://hosted.example/v1",
      model: "vision-model",
      capabilities: { vision: true },
      fetch: async (_input, init) => {
        requestBody = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "A mountain at dawn." } }],
          }),
        );
      },
    });
    await expect(
      provider.describeImage(
        { data: "aGVsbG8=", mediaType: "image/png" },
        "Describe",
        { apiKey: "byok-key" },
      ),
    ).resolves.toBe("A mountain at dawn.");
    expect(JSON.stringify(requestBody)).toContain(
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("streams text chunks as server-sent events", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://hosted.example/v1",
      model: "stream-model",
      fetch: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("say hello", {
      apiKey: "byok-key",
    }))
      chunks.push(chunk);
    expect(chunks.join("")).toBe("hello world");
  });

  it("maps invalid keys to a readable error without echoing provider bodies", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://hosted.example/v1",
      model: "model",
      fetch: async () =>
        new Response("secret account payload", { status: 401 }),
    });
    await expect(
      provider.generateJson("prompt", oneSceneSchema, { apiKey: "bad-key" }),
    ).rejects.toThrowError("openai-compatible rejected the API key");
  });

  it("declares all requested compatible-provider presets", () => {
    expect(Object.keys(OPENAI_COMPATIBLE_PRESETS)).toEqual([
      "openai-compatible",
      "openrouter",
      "groq",
      "together",
      "deepseek",
      "ollama",
      "lm-studio",
      "vllm",
    ]);
    expect(OPENAI_COMPATIBLE_PRESETS.openrouter.baseUrl).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

/**
 * The swap proof: {@link scriptVia} is written purely against the
 * `LlmProvider` interface and runs unchanged over both concrete
 * providers, each behind its own mock transport.
 */
describe("LlmProvider swaps cleanly", () => {
  async function scriptVia(
    provider: LlmProvider,
    apiKey?: string,
  ): Promise<z.infer<typeof oneSceneSchema>> {
    const reply = await provider.generateJson(
      "one scene about a morning run",
      oneSceneSchema,
      apiKey ? { apiKey } : undefined,
    );
    expect(reply).toEqual({ title: "Dawn Run", year: 2026 });
    return reply;
  }

  const hostedProvider: LlmProvider = new OpenAiCompatibleProvider({
    baseUrl: "https://hosted.example",
    model: "hosted-flash-free",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"title":"Dawn Run","year":2026}' } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const openCodeProvider: LlmProvider = new OpenCodeProvider({
    baseUrl: "http://test:4096",
    password: "dev-password",
    directory: "C:\\proj",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET") as string;
      if (method === "POST" && url.pathname === "/api/session") {
        return new Response(JSON.stringify({ data: { id: "ses_1" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.pathname.endsWith("/prompt")) {
        return new Response(JSON.stringify({ data: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.pathname.endsWith("/wait")) {
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && url.pathname.endsWith("/message")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "m2",
                type: "assistant",
                content: [
                  { type: "text", text: '{"title":"Dawn Run","year":2026}' },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (method === "DELETE" && url.pathname.startsWith("/api/session/")) {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    },
  });

  it("both providers drive the same interface consumer", async () => {
    expect(await scriptVia(hostedProvider, "hosted-api-key")).toEqual({
      title: "Dawn Run",
      year: 2026,
    });
    expect(await scriptVia(openCodeProvider)).toEqual({
      title: "Dawn Run",
      year: 2026,
    });
  });
});
