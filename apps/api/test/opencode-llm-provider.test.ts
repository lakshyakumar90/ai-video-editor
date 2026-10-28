import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scenePlansSchema } from "@repo/shared";
import {
  DEFAULT_OPENCODE_MODEL,
  OpenCodeProvider,
  OpenCodeProviderError,
  RateLimitError,
  SYSTEM_INSTRUCTIONS,
  buildPromptText,
  isRateLimitError,
  isTransientError,
  parseJsonReply,
  withRetry,
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
  /** HTTP status for the Nth session's create call; null → normal 200. */
  createStatuses?: Array<number | null>;
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
      // Missing entries repeat the last one, so a short list can throttle
      // every attempt of a call.
      const statuses = script.createStatuses;
      const failStatus =
        statuses === undefined
          ? null
          : (statuses[Math.min(sessionCount, statuses.length - 1)] ?? null);
      sessionCount++;
      if (failStatus !== null) {
        return response(failStatus, {
          message: "rate limit exceeded, retry later",
        });
      }
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
  // keeps simulated transient-failure backoffs instantaneous in tests
  retryBaseDelayMs: 1,
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
    expect(promptBody.text).toContain("[JSON Schema]");
    expect(promptBody.text).toContain('"visualQuery"');
    expect(promptBody.text).toContain('"properties"');
    expect(promptBody.text).toContain("write a 3-scene script");
    expect(promptBody.text.indexOf("[Request]")).toBeLessThan(
      promptBody.text.indexOf("write a 3-scene script"),
    );
    // cleanup: every session is removed
    const removed = calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path);
    expect(removed).toEqual(["/api/session/ses_1"]);
  });

  it("retries once with the validation error appended when the reply fails the schema", async () => {
    // Valid JSON, but `mood` violates min(1): a ZodError, not a parse error.
    const invalidShape = JSON.stringify([
      { narration: "a", visualQuery: "b", mood: "" },
    ]);
    const { calls, fetchMock } = makeMockFetch({
      replies: [invalidShape, THREE_SCENE_JSON],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [{ providerID: "opencode", modelID: "only-free" }],
      fetch: fetchMock,
    });

    const script = await provider.generateJson("prompt", scenePlansSchema);
    expect(script).toHaveLength(3);

    // second session's prompt carries the failure report
    const repairPrompt = (calls[6]?.body as { text: string }).text;
    expect(repairPrompt).toContain("[Validation Failure]");
    expect(repairPrompt).toContain("mood"); // issue path from the error
    expect(calls.filter((call) => call.method === "DELETE").map((c) => c.path))
      .toEqual(["/api/session/ses_1", "/api/session/ses_2"]);
  });

  it("gives up after the single repair round when the shape stays invalid", async () => {
    const invalidShape = (mood: string) =>
      JSON.stringify([{ narration: "a", visualQuery: "b", mood }]);
    const { calls, fetchMock } = makeMockFetch({
      replies: [invalidShape(""), invalidShape("")],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [{ providerID: "opencode", modelID: "only-free" }],
      fetch: fetchMock,
    });

    await expect(
      provider.generateJson("prompt", scenePlansSchema),
    ).rejects.toThrowError(OpenCodeProviderError);
    // exactly two attempts: original + one repair, no model fallback bounce
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/session"))
      .toHaveLength(2);
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
    // garbage is a parse error, not a validation error — no repair round
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/session"))
      .toHaveLength(2);
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

  it("recovers from a transient 500 on session.create without burning a model", async () => {
    const { calls, fetchMock } = makeMockFetch({
      // first create attempt fails with 500, second succeeds
      replies: ["", THREE_SCENE_JSON],
      createStatuses: [500, null],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      fetch: fetchMock,
    });

    const script = await provider.generateJson("prompt", scenePlansSchema);
    expect(script).toHaveLength(3);
    // two create attempts, one logical session (ses_2), removed once
    expect(calls[0]?.body).toMatchObject({ model: { id: DEFAULT_OPENCODE_MODEL.modelID } });
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path === "/api/session",
      ),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.method === "DELETE").map((c) => c.path))
      .toEqual(["/api/session/ses_2"]);
  });

  it("retries a throttled create with backoff before falling through to the next model", async () => {
    // 429 for model 1's three call-level attempts, then model 2 succeeds
    const { calls, fetchMock } = makeMockFetch({
      replies: ["", "", "", THREE_SCENE_JSON],
      createStatuses: [429, 429, 429, null],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [
        { providerID: "opencode", modelID: "throttled-free" },
        { providerID: "opencode", modelID: "backup-free" },
      ],
      fetch: fetchMock,
    });

    const script = await provider.generateJson("prompt", scenePlansSchema);
    expect(script).toHaveLength(3);
    expect(calls[0]?.body).toMatchObject({ model: { id: "throttled-free" } });
    expect(calls[3]?.body).toMatchObject({ model: { id: "backup-free" } });
    // 3 retry attempts on model 1 + 1 on model 2 = 4 create calls
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/session"))
      .toHaveLength(4);
    // only model 2's session ever existed, so only it is removed
    expect(calls.filter((call) => call.method === "DELETE").map((c) => c.path))
      .toEqual(["/api/session/ses_4"]);
  });

  it("throws a typed RateLimitError when every model is throttled", async () => {
    const { fetchMock } = makeMockFetch({
      replies: ["", ""],
      createStatuses: [429, 402],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [
        { providerID: "opencode", modelID: "throttled-free" },
        { providerID: "opencode", modelID: "over-quota-free" },
      ],
      fetch: fetchMock,
    });

    let caught: unknown;
    try {
      await provider.generateJson("prompt", scenePlansSchema);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitError);
    expect(caught).toBeInstanceOf(OpenCodeProviderError);
    const rateLimitError = caught as RateLimitError;
    expect(rateLimitError.name).toBe("RateLimitError");
    expect(rateLimitError.limitedModels).toEqual([
      "opencode/throttled-free",
      "opencode/over-quota-free",
    ]);
    expect(rateLimitError.message).toMatch(
      /rate-limited or over quota.*throttled-free.*over-quota-free/s,
    );
  });

  it("throws the generic error (not RateLimitError) on mixed failures", async () => {
    const { fetchMock } = makeMockFetch({
      // first model is throttled, second returns unparseable garbage
      replies: ["", "nope"],
      createStatuses: [429, null],
    });
    const provider = new OpenCodeProvider({
      ...providerOptions,
      models: [
        { providerID: "opencode", modelID: "throttled-free" },
        { providerID: "opencode", modelID: "broken-free" },
      ],
      fetch: fetchMock,
    });

    let caught: unknown;
    try {
      await provider.generateJson("prompt", scenePlansSchema);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeProviderError);
    expect(caught).not.toBeInstanceOf(RateLimitError);
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

describe("buildPromptText", () => {
  it("embeds the schema's JSON Schema between instructions and request", () => {
    const prompt = buildPromptText("write the scene", scenePlansSchema);
    const schemaLine = prompt
      .split("\n")
      .find((line) => line.startsWith("[JSON Schema]"));

    expect(schemaLine).toBeDefined();
    expect(schemaLine).toContain('"mood"');
    const values = JSON.parse(schemaLine!.slice("[JSON Schema] ".length));
    expect(values).toMatchObject({
      type: "array",
      items: { type: "object", properties: expect.anything() },
    });

    const sections = prompt.split("\n");
    expect(sections.indexOf("[Instructions]")).toBeLessThan(
      sections.findIndex((line) => line.startsWith("[JSON Schema]")),
    );
    expect(
      sections.findIndex((line) => line.startsWith("[JSON Schema]")),
    ).toBeLessThan(sections.indexOf("[Request]"));
  });

  it("falls back to a note when the schema cannot be converted", () => {
    const unrepresentable = z.string().transform((value) => value.length);
    const prompt = buildPromptText("count words", unrepresentable);
    expect(prompt).toContain("[JSON Schema] (described in the request)");
  });
});

describe("withRetry / withTimeout / isTransientError", () => {
  const transportError = () =>
    Object.assign(new Error("Transport: network unreachable"), {
      name: "ClientError",
    });
  const serverError = (status: number) =>
    Object.assign(new Error(`UnexpectedStatus: ${status}`), {
      cause: { status },
    });

  it("retries transient errors with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      (attempt) => {
        calls++;
        if (attempt < 2) return Promise.reject(transportError());
        return Promise.resolve(`ok-${attempt}`);
      },
      { attempts: 3, baseDelayMs: 10 },
    );

    expect(result).toBe("ok-2");
    expect(calls).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error("session invalid"));
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrowError(/session invalid/);
    expect(calls).toBe(1);
  });

  it("exhausts attempts on persistent transient errors", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withRetry(
        () => {
          calls++;
          return Promise.reject(serverError(502));
        },
        { attempts: 3, baseDelayMs: 1 },
      );
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(3);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("502");
  });

  it("passes the attempt number to the operation", async () => {
    const seen: number[] = [];
    await withRetry(
      (attempt) => {
        seen.push(attempt);
        if (attempt < 2) return Promise.reject(transportError());
        return Promise.resolve(null);
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it("times out a hanging attempt and retries", async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return calls === 1
          ? new Promise<string>(() => undefined) // hangs forever
          : Promise.resolve("recovered");
      },
      { attempts: 2, timeoutMs: 20, baseDelayMs: 1 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("surfaces the TimeoutError when every attempt times out", async () => {
    await expect(
      withRetry(() => new Promise<string>(() => undefined), {
        attempts: 1,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("classifies failures", () => {
    expect(isTransientError(transportError())).toBe(true);
    expect(isTransientError(serverError(503))).toBe(true);
    expect(isTransientError(serverError(408))).toBe(true);
    expect(
      isTransientError(
        Object.assign(new Error("rate limit exceeded"), {
          name: "ProviderRequestError",
        }),
      ),
    ).toBe(true);
    expect(isTransientError(new DOMException("t", "TimeoutError"))).toBe(true);

    expect(isTransientError(new Error("I politely refuse."))).toBe(false);
    expect(isTransientError(serverError(401))).toBe(false);
    expect(isTransientError(serverError(404))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe("isRateLimitError", () => {
  const unexpectedStatus = (status: number) =>
    Object.assign(new Error(`UnexpectedStatus: ${status}`), {
      cause: { status },
    });

  const declaredTag = (tag: string, message: string) =>
    Object.assign(new Error(message), { name: tag });

  it("recognizes 429/402 statuses from ClientError causes", () => {
    expect(isRateLimitError(unexpectedStatus(429))).toBe(true);
    expect(isRateLimitError(unexpectedStatus(402))).toBe(true);
  });

  it("reads status and message out of nested error causes", () => {
    const nested = new Error("wrapped", {
      cause: unexpectedStatus(429),
    });
    expect(isRateLimitError(nested)).toBe(true);
  });

  it("recognizes quota wording in tagged provider errors", () => {
    expect(
      isRateLimitError(
        declaredTag("ProviderRequestError", "You have exceeded your daily quota for this model"),
      ),
    ).toBe(true);
    expect(
      isRateLimitError(declaredTag("ProviderRequestError", "Too many requests")),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    const schemaError = scenePlansSchema.safeParse([{ mood: 1 }]).error;
    expect(isRateLimitError(schemaError)).toBe(false);
    expect(isRateLimitError(new Error("connection reset"))).toBe(false);
    expect(isRateLimitError(unexpectedStatus(500))).toBe(false);
    expect(isRateLimitError(unexpectedStatus(401))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe("parseJsonReply", () => {
  it("parses bare, fenced, and prose-wrapped JSON", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(parseJsonReply("Sure! Here you go: {\"a\":3}")).toEqual({ a: 3 });
  });

  it("handles fenced blocks surrounded by prose", () => {
    expect(
      parseJsonReply(
        "Here is the script:\n\n```json\n" + THREE_SCENE_JSON + "\n```\n\nEnjoy!",
      ),
    ).toEqual(JSON.parse(THREE_SCENE_JSON));
  });

  it("handles fences around multi-line arrays", () => {
    const fenced =
      "```json\n" +
      JSON.stringify(JSON.parse(THREE_SCENE_JSON), null, 2) +
      "\n```";
    expect(parseJsonReply(fenced)).toHaveLength(3);
  });

  it("parses pretty-printed JSON with trailing commentary", () => {
    const reply = JSON.stringify(JSON.parse(THREE_SCENE_JSON), null, 2) +
      "\n\nLet me know if you'd like changes!";
    expect(parseJsonReply(reply)).toEqual(JSON.parse(THREE_SCENE_JSON));
  });

  it("throws a descriptive error for non-JSON replies", () => {
    expect(() => parseJsonReply("I politely refuse.")).toThrowError(
      /not parseable JSON/,
    );
  });
});
