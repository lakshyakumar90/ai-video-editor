import path from "node:path";
import type { ZodType } from "zod";
import {
  SUPPORTED_LLM_CAPABILITIES,
  type LlmCapabilities,
  type LlmProvider,
} from "./llm-provider.js";
import { FakeLlmProvider } from "./fake-llm-provider.js";
import { OpenCodeProvider } from "./opencode-llm-provider.js";
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
  /** Stable name used by `LLM_PROVIDER`. */
  readonly name: LlmProviderName;
  readonly description: string;
  readonly deployment: ProviderDeployment;
  /** Dev-only doubles must never serve production traffic. */
  readonly devOnly?: boolean;
  readonly capabilities: LlmCapabilities;
  /** Fallback models, highest priority first (not meaningful for fakes). */
  readonly models?: ModelRef[];
  create(): LlmProvider;
}

export type LlmProviderName = "fake" | "opencode" | "hosted-openai";

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

export const llmProviders: Map<LlmProviderName, LlmProviderDescriptor> =
  new Map([
    [
      "fake",
      {
        name: "fake",
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
        create: () => {
          const models = LLM_MODEL_FALLBACK.openCode();
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
        create: () => {
          const baseUrl = process.env.LLM_HOSTED_BASE_URL ?? "";
          const model = process.env.LLM_HOSTED_MODEL ?? "";
          if (baseUrl === "" || model === "") {
            throw new ProviderResolutionError(
              'provider "hosted-openai" needs LLM_HOSTED_BASE_URL and LLM_HOSTED_MODEL',
            );
          }
          return new OpenAiCompatibleProvider({ baseUrl, model });
        },
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
export function getLlmProvider(reference?: string): LlmProvider {
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

  return descriptor.create();
}

/** Registry diagnostics for health endpoints and CLI tooling. */
export function describeLlmProviders(): Array<{
  name: LlmProviderName;
  description: string;
  deployment: ProviderDeployment;
  capabilities: LlmCapabilities;
  models?: ModelRef[];
}> {
  return [...llmProviders.values()].map(
    ({ name, description, deployment, capabilities, models }) => ({
      name,
      description,
      deployment,
      capabilities,
      ...(models !== undefined ? { models } : {}),
    }),
  );
}

/** Re-exported so consumers never import `ZodType` handling themselves. */
export type GenerateJsonContract<T> = (
  prompt: string,
  schema: ZodType<T>,
) => Promise<T>;
