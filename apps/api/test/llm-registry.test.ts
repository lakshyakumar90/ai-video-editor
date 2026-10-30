import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLlmProvider, fakeSceneScript } from "../src/services/fake-llm-provider.js";
import { OpenCodeProvider } from "../src/services/opencode-llm-provider.js";
import { OpenAiCompatibleProvider } from "../src/services/hosted-llm-provider.js";
import {
  LLM_MODEL_FALLBACK,
  ProviderResolutionError,
  describeLlmProviders,
  getLlmProvider,
  llmProviders,
} from "../src/services/llm-registry.js";
import {
  generateScenePlansResponseSchema,
  scenePlansSchema,
  type ScenePlans,
} from "@repo/shared";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_HOSTED_BASE_URL",
  "LLM_HOSTED_API_KEY",
  "LLM_HOSTED_MODEL",
  "OPENCODE_MODEL_PREFERENCE",
  "DEPLOYMENT_MODE",
  "NODE_ENV",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OPENCODE_BASE_URL = "http://127.0.0.1:4096";
  process.env.OPENCODE_SERVER_PASSWORD = "test-password";
  process.env.LLM_HOSTED_BASE_URL = "";
  process.env.LLM_HOSTED_API_KEY = "";
  process.env.LLM_HOSTED_MODEL = "";
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("LLM_MODEL_FALLBACK (moved out of the OpenCode adapter)", () => {
  it("parses OPENCODE_MODEL_PREFERENCE into provider/model refs in order", () => {
    process.env.OPENCODE_MODEL_PREFERENCE = "opencode/a-free, opencode/b-free,";

    expect(LLM_MODEL_FALLBACK.openCode()).toEqual([
      { providerID: "opencode", modelID: "a-free" },
      { providerID: "opencode", modelID: "b-free" },
    ]);
    expect(llmProviders.get("opencode")?.models).toEqual([
      { providerID: "opencode", modelID: "a-free" },
      { providerID: "opencode", modelID: "b-free" },
    ]);
  });
});

describe("getLlmProvider", () => {
  it("defaults to the self-hosted CLI provider when nothing is set", () => {
    expect(getLlmProvider()).toBeInstanceOf(OpenCodeProvider);
  });

  it("resolves the fake double with one env var", () => {
    process.env.LLM_PROVIDER = "fake";
    const provider = getLlmProvider();
    expect(provider).toBeInstanceOf(FakeLlmProvider);

    // The swap is complete: the same interface consumer gets a valid plan.
    return expect(
      provider.generateJson("any prompt", scenePlansSchema),
    ).resolves.toEqual(fakeSceneScript satisfies ScenePlans);
  });

  it("accepts an explicit reference overriding the env var", () => {
    process.env.LLM_PROVIDER = "fake";
    process.env.OPENCODE_MODEL_PREFERENCE = "opencode/a-free";
    expect(getLlmProvider("opencode")).toBeInstanceOf(OpenCodeProvider);
  });

  it("names the available providers in the unknown-provider error", () => {
    expect(() => getLlmProvider("codex-not-registered")).toThrowError(
      /unknown LLM provider "codex-not-registered" - available providers: fake, opencode, hosted-openai/,
    );
  });

  it("refuses CLI-backed providers in hosted deployments", () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    expect(() => getLlmProvider("opencode")).toThrowError(ProviderResolutionError);
    expect(() => getLlmProvider("opencode")).toThrowError(/self-hosted only/);
  });

  it("never resolves the fake double in production", () => {
    process.env.NODE_ENV = "production";
    process.env.LLM_PROVIDER = "fake";
    expect(() => getLlmProvider()).toThrowError(/dev-only double/);
  });
});

describe("hosted-openai (BYOK placeholder in the registry)", () => {
  it("throws a helpful error before any env vars are supplied", () => {
    expect(() => getLlmProvider("hosted-openai")).toThrowError(
      /provider "hosted-openai" needs LLM_HOSTED_BASE_URL/,
    );
  });

  it("builds the provider when BYOK env vars exist", () => {
    process.env.LLM_HOSTED_BASE_URL = "https://api.example.com";
    process.env.LLM_HOSTED_API_KEY = "key";
    process.env.LLM_HOSTED_MODEL = "model";
    expect(getLlmProvider("hosted-openai")).toBeInstanceOf(OpenAiCompatibleProvider);
  });
});

describe("capabilities", () => {
  it("declares JSON-in-text with no native tool calling for every provider", async () => {
    for (const descriptor of describeLlmProviders()) {
      expect(descriptor.capabilities).toEqual({
        structuredOutput: "json-in-text",
        toolCalling: false,
      });
    }
  });

  it("delivers on the declared capability: schema-validated JSON from text", async () => {
    const provider = getLlmProvider("fake");
    const plan = await provider.generateJson("a tokyo night edit", scenePlansSchema);
    expect(plan).toEqual(fakeSceneScript);
  });

  it("returns the scene-plan response envelope used by the CLI and API", async () => {
    const provider = getLlmProvider("fake");
    const response = await provider.generateJson(
      "a tokyo night edit",
      generateScenePlansResponseSchema,
    );
    expect(response).toEqual({ scenes: fakeSceneScript });
  });
});
