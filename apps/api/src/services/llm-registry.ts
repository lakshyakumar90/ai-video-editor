import path from "node:path";
import type { ZodType } from "zod";
import { z } from "zod";
import {
  SUPPORTED_LLM_CAPABILITIES,
  type LlmCapabilities,
  type LlmProvider,
} from "./llm-provider.js";
import { FakeLlmProvider } from "./fake-llm-provider.js";
import { OpenCodeProvider } from "./opencode-llm-provider.js";
import { OpenAiProvider } from "./openai-llm-provider.js";
import { AnthropicProvider } from "./anthropic-llm-provider.js";
import { GeminiProvider } from "./gemini-llm-provider.js";
import { CodexCliProvider } from "./codex-cli-llm-provider.js";
import {
  OPENAI_COMPATIBLE_PRESETS,
  OpenAiCompatibleProvider,
} from "./hosted-llm-provider.js";

/**
 * LLM provider registry (Phase 5).
 *
 * Adapters (`opencode-llm-provider`, `hosted-llm-provider`,
 * `fake-llm-provider`) are implementation details: this registry is the
 * ONLY module allowed to import them, and every consumer - routes,
 * services, scripts - resolves providers here. Ownership:
 *
 * - provider descriptors: names, deployment restrictions, and the
 *   honest capability declarations from `llm-provider.ts`,
 * - the OpenCode model fallback list, moved out of the adapter and read
 *   from `OPENCODE_MODEL_PREFERENCE` highest-priority first,
 * - selection via the `LLM_PROVIDER` env var, e.g. `LLM_PROVIDER=fake`
 *   swaps the live provider for the dev double.
 */

export { SUPPORTED_LLM_CAPABILITIES };
export type { LlmCapabilities, LlmProvider };

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Deployment modes where resolving the provider is allowed. */
export type ProviderDeployment = "self-hosted" | "hosted" | "any";

export interface LlmProviderDescriptor {
  readonly id?: LlmProviderName;
  readonly kind?: "hosted-key" | "local-cli" | "test";
  readonly defaultModel?: string | null;
  readonly healthProbe?: (
    options?: import("./llm-provider.js").LlmCallOptions,
  ) => Promise<void>;
  /** Stable name used by `LLM_PROVIDER`. */
  readonly name: LlmProviderName;
  readonly description: string;
  readonly deployment: ProviderDeployment;
  /** Dev-only doubles must never serve production traffic. */
  readonly devOnly?: boolean;
  readonly capabilities: LlmCapabilities;
  /** Fallback models, highest priority first (not meaningful for fakes). */
  readonly models?: ModelRef[];
  create(modelOverride?: string): LlmProvider;
}

export type LlmProviderName =
  | "fake"
  | "opencode"
  | "codex"
  | "hosted-openai"
  | "openai-compatible"
  | "openrouter"
  | "groq"
  | "together"
  | "deepseek"
  | "ollama"
  | "lm-studio"
  | "vllm"
  | "openai"
  | "anthropic"
  | "gemini";

export class ProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderResolutionError";
  }
}

export const LLM_MODEL_FALLBACK = {
  /** OpenCode fallback chain, re-read from `OPENCODE_MODEL_PREFERENCE` per call. */
  openCode: (): ModelRef[] =>
    parseProviderModelEntries(process.env.OPENCODE_MODEL_PREFERENCE ?? ""),
} as const;

function parseProviderModelEntries(value: string): ModelRef[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerID, ...rest] = entry.split("/");
      return { providerID: providerID ?? "", modelID: rest.join("/") };
    })
    .filter((model) => model.modelID.length > 0);
}

/** Workspace directory OpenCode sessions operate in (the repo root). */
const projectDirectory = path.resolve(import.meta.dirname, "../../..");

const compatibleDefaults: Record<string, string> = {
  openrouter: "openai/gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  deepseek: "deepseek-chat",
  ollama: "llama3.2",
  "lm-studio": "local-model",
  vllm: "default",
};

function createCompatiblePresetDescriptors(): Array<
  [LlmProviderName, LlmProviderDescriptor]
> {
  const presets = Object.keys(OPENAI_COMPATIBLE_PRESETS) as Array<
    keyof typeof OPENAI_COMPATIBLE_PRESETS
  >;
  return presets.map((id) => {
    const envPrefix = id.replaceAll("-", "_").toUpperCase();
    const model =
      process.env[`${envPrefix}_MODEL`] ??
      (id === "openai-compatible" ? process.env.LLM_HOSTED_MODEL : undefined) ??
      compatibleDefaults[id] ??
      "";
    const baseUrl =
      process.env[`${envPrefix}_BASE_URL`] ??
      (id === "openai-compatible"
        ? process.env.LLM_HOSTED_BASE_URL
        : undefined) ??
      OPENAI_COMPATIBLE_PRESETS[id].baseUrl;
    const name = id as LlmProviderName;
    return [
      name,
      {
        name,
        id: name,
        kind: ["ollama", "lm-studio", "vllm"].includes(id)
          ? "local-cli"
          : "hosted-key",
        defaultModel: model || null,
        description: `${id} OpenAI-compatible preset`,
        deployment: ["ollama", "lm-studio", "vllm"].includes(id)
          ? "self-hosted"
          : "hosted",
        capabilities: OPENAI_COMPATIBLE_PRESETS[id].capabilities,
        healthProbe: async (options) => {
          const provider = new OpenAiCompatibleProvider({
            baseUrl,
            model: model || "",
            providerId: id,
          });
          await provider.healthProbe(options);
        },
        create: (modelOverride) => {
          const selectedModel = modelOverride ?? model;
          if (!selectedModel)
            throw new ProviderResolutionError(
              `provider "${id}" needs ${envPrefix}_MODEL`,
            );
          if (!baseUrl)
            throw new ProviderResolutionError(
              `provider "${id}" needs ${envPrefix}_BASE_URL`,
            );
          return new OpenAiCompatibleProvider({
            baseUrl,
            model: selectedModel,
            providerId: id,
          });
        },
      },
    ];
  });
}

export const llmProviders: Map<LlmProviderName, LlmProviderDescriptor> =
  new Map([
    [
      "fake",
      {
        name: "fake",
        id: "fake",
        kind: "test",
        description: "Hardcoded dev double (FakeLlmProvider) - no network",
        deployment: "any",
        devOnly: true,
        capabilities: SUPPORTED_LLM_CAPABILITIES,
        create: () => new FakeLlmProvider(),
      },
    ],
    [
      "opencode",
      {
        name: "opencode",
        description: "Local OpenCode server sessions over free CLI models",
        deployment: "self-hosted",
        capabilities: SUPPORTED_LLM_CAPABILITIES,
        get models() {
          // Re-read per access so env changes apply without a module reload.
          const models = LLM_MODEL_FALLBACK.openCode();
          return models.length > 0 ? models : undefined;
        },
        create: (modelOverride) => {
          const models = modelOverride
            ? parseProviderModelEntries(modelOverride)
            : LLM_MODEL_FALLBACK.openCode();
          return new OpenCodeProvider({
            baseUrl: process.env.OPENCODE_BASE_URL ?? "",
            password: process.env.OPENCODE_SERVER_PASSWORD ?? "",
            directory: projectDirectory,
            ...(models.length > 0 ? { models: [...models] } : {}),
          });
        },
      },
    ],
    [
      "hosted-openai",
      {
        name: "hosted-openai",
        description:
          "Hosted OpenAI-compatible chat completions (bring-your-own-key; needs LLM_HOSTED_BASE_URL and LLM_HOSTED_MODEL)",
        deployment: "hosted",
        capabilities:
          OPENAI_COMPATIBLE_PRESETS["openai-compatible"].capabilities,
        create: (modelOverride) => {
          const baseUrl = process.env.LLM_HOSTED_BASE_URL ?? "";
          const model = modelOverride ?? process.env.LLM_HOSTED_MODEL ?? "";
          if (baseUrl === "" || model === "") {
            throw new ProviderResolutionError(
              'provider "hosted-openai" needs LLM_HOSTED_BASE_URL and LLM_HOSTED_MODEL',
            );
          }
          return new OpenAiCompatibleProvider({ baseUrl, model });
        },
      },
    ],
    ...createCompatiblePresetDescriptors(),
    [
      "openai",
      {
        name: "openai",
        description: "Official OpenAI Responses API adapter",
        deployment: "hosted",
        capabilities: {
          structuredOutput: "json-schema",
          toolCalling: true,
          vision: true,
          streaming: true,
          maxContext: null,
        },
        create: (modelOverride) =>
          new OpenAiProvider(
            modelOverride ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
          ),
      },
    ],
    [
      "anthropic",
      {
        name: "anthropic",
        description: "Official Anthropic Messages API adapter",
        deployment: "hosted",
        capabilities: {
          structuredOutput: "json-in-text",
          toolCalling: true,
          vision: true,
          streaming: true,
          maxContext: null,
        },
        create: (modelOverride) =>
          new AnthropicProvider(
            modelOverride ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
          ),
      },
    ],
    [
      "gemini",
      {
        name: "gemini",
        description: "Official Google GenAI adapter",
        deployment: "hosted",
        capabilities: {
          structuredOutput: "json-schema",
          toolCalling: true,
          vision: true,
          streaming: true,
          maxContext: null,
        },
        create: (modelOverride) =>
          new GeminiProvider(
            modelOverride ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
          ),
      },
    ],
    [
      "codex",
      {
        name: "codex",
        description:
          "Codex CLI using local saved login or a request-scoped CODEX_API_KEY",
        deployment: "self-hosted",
        capabilities: SUPPORTED_LLM_CAPABILITIES,
        create: (modelOverride) =>
          new CodexCliProvider({
            ...((modelOverride ?? process.env.CODEX_MODEL)
              ? { model: modelOverride ?? process.env.CODEX_MODEL }
              : {}),
          }),
      },
    ],
  ]);

/**
 * Resolves the provider named by `reference` (default: `LLM_PROVIDER`,
 * falling back to the self-hosted CLI default `opencode`).
 *
 * Enforces the deployment decision (docs/decision-deployment.md):
 * CLI-backed providers never resolve in `hosted` mode, and dev-only
 * doubles never resolve in production.
 */
export function getLlmProvider(
  reference?: string,
  modelOverride?: string,
): LlmProvider {
  const name = (reference ??
    process.env.LLM_PROVIDER ??
    "opencode") as LlmProviderName;
  const descriptor = llmProviders.get(name);

  if (!descriptor) {
    throw new ProviderResolutionError(
      `unknown LLM provider "${name}" - available providers: ${[...llmProviders.keys()].join(", ")}`,
    );
  }
  if (
    descriptor.deployment === "self-hosted" &&
    process.env.DEPLOYMENT_MODE === "hosted"
  ) {
    throw new ProviderResolutionError(
      `provider "${name}" is CLI-backed and self-hosted only; hosted deployments use bring-your-own-key providers`,
    );
  }
  if (descriptor.devOnly && process.env.NODE_ENV === "production") {
    throw new ProviderResolutionError(
      `provider "${name}" is a dev-only double and cannot serve production traffic`,
    );
  }

  return descriptor.create(modelOverride);
}

/** A minimal credential-aware probe through the provider's native API. */
export async function probeLlmProvider(
  reference: string,
  options?: import("./llm-provider.js").LlmCallOptions,
): Promise<void> {
  const provider = getLlmProvider(reference);
  if (provider.healthProbe) return provider.healthProbe(options);
  await provider.generateJson("Reply with the JSON string ok.", z.string(), {
    ...options,
    maxOutputTokens: 1,
  });
}

/** Registry diagnostics for health endpoints and CLI tooling. */
export function describeLlmProviders(): Array<{
  id: LlmProviderName;
  kind: "hosted-key" | "local-cli" | "test";
  name: LlmProviderName;
  description: string;
  deployment: ProviderDeployment;
  capabilities: LlmCapabilities;
  defaultModel: string | null;
  healthProbe: boolean;
  models?: ModelRef[];
}> {
  return [...llmProviders.values()].map(
    ({
      name,
      id,
      kind,
      defaultModel,
      healthProbe,
      description,
      deployment,
      capabilities,
      models,
    }) => ({
      id: id ?? name,
      kind:
        kind ??
        (name === "fake"
          ? "test"
          : deployment === "self-hosted"
            ? "local-cli"
            : "hosted-key"),
      name,
      description,
      deployment,
      capabilities,
      defaultModel: defaultModel ?? registryDefaultModel(name),
      healthProbe:
        healthProbe !== undefined ||
        llmProviders.get(name)?.create !== undefined,
      ...(models !== undefined ? { models } : {}),
    }),
  );
}

function registryDefaultModel(name: LlmProviderName): string | null {
  const configured: Partial<Record<LlmProviderName, string | undefined>> = {
    "hosted-openai": process.env.LLM_HOSTED_MODEL,
    openai: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    anthropic: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    gemini: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    codex: process.env.CODEX_MODEL,
  };
  return configured[name] ?? null;
}

export function getLlmProviderDefaultModel(
  name: LlmProviderName,
): string | null {
  return llmProviders.get(name)?.defaultModel ?? registryDefaultModel(name);
}

/** Re-exported so consumers never import `ZodType` handling themselves. */
export type GenerateJsonContract<T> = (
  prompt: string,
  schema: ZodType<T>,
) => Promise<T>;
