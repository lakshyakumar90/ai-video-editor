import { afterEach, describe, expect, it } from "vitest";
import { scenePlansSchema } from "@repo/shared";
import {
  DEFAULT_OPENCODE_MODEL,
  OpenCodeProvider,
  OpenCodeProviderError,
  SYSTEM_INSTRUCTIONS,
  parseJsonReply,
} from "../src/services/opencode-llm-provider.js";

const THREE_SCENE_JSON = JSON.stringify([
  { narration: "a", visualQuery: "b", mood: "c" },
  { narration: "d", visualQuery: "e", mood: "f" },
  { narration: "g", visualQuery: "h", mood: "i" },
]);

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

interface ScriptedSessions {
  /** Assistant reply text per created session, in creation order. */
  replies: string[];
  /** Statements like "session must be removed" are implicit: all sessions get removed. */
}

function makeMockFetch(script: ScriptedSessions) {
  const calls: RecordedCall[] = [];
  let sessionCount = 0;

  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const rawBody =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
    let body: unknown = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, path: url.pathname, body, auth });

    if (method === "POST" && url.pathname === "/api/session") {
      sessionCount++;
      return response(200, { data: { id: `ses_${sessionCount}` } });
    }
    if (method === "POST" && url.pathname.endsWith("/prompt")) {
      return response(200, { data: {} });
    }
    if (method === "POST" && url.pathname.endsWith("/wait")) {
      return response(204, null);
    }
    if (method === "GET" && url.pathname.endsWith("/message")) {
      const reply = script.replies[sessionCount - 1] ?? "";
      return response(200, {
        data: [
          { id: "msg_1", type: "user" },
          {
            id: "msg_2",
            type: "assistant",
            content: [{ type: "text", text: reply }],
          },
        ],
        cursor: {},
      });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/session/")) {
      return response(204, null);
    }
    return response(404, { message: `unrouted: ${method} ${url.pathname}` });
  };

  return { calls, fetchMock };
}

function response(status: number, json: unknown): Response {
  return new Response(json === null ? null : JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const providerOptions = {
  baseUrl: "http://test:4096",
  password: "dev-password",
  directory: "C:\\proj",
} as const;

describe("OpenCodeProvider", () => {
  it("runs one session, sends system instructions with the prompt, and validates the reply", async () => {
    const { calls, fetchMock } = makeMockFetch({
      replies: ["```json\n" + THREE_SCENE_JSON + "\n```"],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      fetch: fetchMock,
    });

    const script = await provider.generateJson(
      "write a 3-scene script",
      scenePlansSchema,
    );

    expect(script).toHaveLength(3);
    expect(script[0]).toEqual({ narration: "a", visualQuery: "b", mood: "c" });

    expect(calls[0]?.auth).toBe(
      "Basic " + Buffer.from(`opencode:dev-password`).toString("base64"),
    );
    // create used the default model
    expect(calls[0]?.body).toMatchObject({
      model: { providerID: DEFAULT_OPENCODE_MODEL.providerID, id: DEFAULT_OPENCODE_MODEL.modelID },
    });
    // prompt carries system instructions and the user prompt
    const promptBody = calls[1]?.body as { text: string };
    expect(promptBody.text).toContain("[Instructions]");
    expect(promptBody.text).toContain(SYSTEM_INSTRUCTIONS);
    expect(promptBody.text).toContain("write a 3-scene script");
    // cleanup: every session is removed
    const removed = calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path);
    expect(removed).toEqual(["/api/session/ses_1"]);
  });

  it("falls back to the next preferred model when one returns garbage", async () => {
    const { calls, fetchMock } = makeMockFetch({
      replies: ["that is not json at all", THREE_SCENE_JSON],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [
        { providerID: "opencode", modelID: "first-free" },
        { providerID: "opencode", modelID: "second-free" },
      ],
      fetch: fetchMock,
    });

    const script = await provider.generateJson("prompt", scenePlansSchema);
    expect(script).toHaveLength(3);
    expect(calls[0]?.body).toMatchObject({ model: { id: "first-free" } });
    expect(calls[5]?.body).toMatchObject({ model: { id: "second-free" } });
    const removed = calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path);
    expect(removed).toEqual([
      "/api/session/ses_1",
      "/api/session/ses_2",
    ]);
  });

  it("rejects with OpenCodeProviderError when every model fails", async () => {
    const { fetchMock } = makeMockFetch({ replies: ["nope", "also nope"] });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [
        { providerID: "opencode", modelID: "first-free" },
        { providerID: "opencode", modelID: "second-free" },
      ],
      fetch: fetchMock,
    });

    await expect(
      provider.generateJson("prompt", scenePlansSchema),
    ).rejects.toThrowError(OpenCodeProviderError);
  });

  it("rejects empty prompts without touching the server", async () => {
    const { calls, fetchMock } = makeMockFetch({ replies: [] });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      fetch: fetchMock,
    });

    await expect(
      provider.generateJson("   ", scenePlansSchema),
    ).rejects.toThrowError(/empty/);
    expect(calls).toHaveLength(0);
  });
});

describe("parseJsonReply", () => {
  it("parses bare, fenced, and prose-wrapped JSON", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(parseJsonReply("Sure! Here you go: {\"a\":3}")).toEqual({ a: 3 });
  });

  it("throws a descriptive error for non-JSON replies", () => {
    expect(() => parseJsonReply("I politely refuse.")).toThrowError(
      /not parseable JSON/,
    );
  });
});
