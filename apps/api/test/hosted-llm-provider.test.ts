import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmProvider } from "../src/services/llm-provider.js";
import {
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
          choices: [{ message: { content: '{"title":"Dawn Run","year":2026}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return { calls, fetchMock };
  };

  const options: OpenAiCompatibleProviderOptions = {
    baseUrl: "https://hosted.example/v0/",
    apiKey: "hosted-api-key",
    model: "hosted-flash-free",
  };

  it("calls the hosted chat-completions endpoint and validates the reply", async () => {
    const { calls, fetchMock } = makeHostedFetch();
    const provider = new OpenAiCompatibleProvider({
      ...options,
      fetch: fetchMock,
    });

    const result = await provider.generateJson(
      "one scene about a morning run",
      oneSceneSchema,
    );

    expect(result).toEqual({ title: "Dawn Run", year: 2026 });
    expect(calls[0]?.url).toBe("https://hosted.example/v0/v1/chat/completions");
    expect(calls[0]?.auth).toBe("Bearer hosted-api-key");
    const body = calls[0]?.body as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string }>;
    };
    expect(body.model).toBe("hosted-flash-free");
    expect(body.response_format.type).toBe("json_object");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("rejects an empty prompt without calling the API", async () => {
    const { calls, fetchMock } = makeHostedFetch();
    const provider = new OpenAiCompatibleProvider({ ...options, fetch: fetchMock });

    await expect(
      provider.generateJson("   ", oneSceneSchema),
    ).rejects.toThrowError(/empty/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The swap proof: {@link scriptVia} is written purely against the
 * `LlmProvider` interface and runs unchanged over both concrete
 * providers, each behind its own mock transport.
 */
describe("LlmProvider swaps cleanly", () => {
  async function scriptVia(provider: LlmProvider): Promise<
    z.infer<typeof oneSceneSchema>
  > {
    const reply = await provider.generateJson(
      "one scene about a morning run",
      oneSceneSchema,
    );
    expect(reply).toEqual({ title: "Dawn Run", year: 2026 });
    return reply;
  }

  const hostedProvider: LlmProvider = new OpenAiCompatibleProvider({
    baseUrl: "https://hosted.example",
    apiKey: "hosted-api-key",
    model: "hosted-flash-free",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"title":"Dawn Run","year":2026}' } }],
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
    expect(await scriptVia(hostedProvider)).toEqual({
      title: "Dawn Run",
      year: 2026,
    });
    expect(await scriptVia(openCodeProvider)).toEqual({
      title: "Dawn Run",
      year: 2026,
    });
  });
});
