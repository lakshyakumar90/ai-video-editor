import type { ZodType } from "zod";
import type { LlmCallOptions, ProviderUsage } from "./llm-provider.js";
import { LlmProviderError } from "./llm-provider-error.js";
import { resolveLlmCredential, type LlmKeyPayer } from "./llm-credentials.js";
import {
  getLlmProvider,
  getLlmProviderDefaultModel,
  llmProviders,
  type LlmProviderName,
} from "./llm-registry.js";

export type LlmTask =
  "script-planning" | "edit-agent" | "vision" | "translation";
export interface TaskProviderRef {
  providerId: LlmProviderName;
  model?: string;
}

export function resolveTaskRoute(task: LlmTask): TaskProviderRef[] {
  const envName = `LLM_TASK_${task.replaceAll("-", "_").toUpperCase()}`;
  const configured = process.env[envName];
  const defaults =
    configured ??
    (task === "vision" ? "openai" : (process.env.LLM_PROVIDER ?? "opencode"));
  const refs = defaults.split(",").map((entry) => {
    const [providerRaw, model] = entry.trim().split("|");
    if (!providerRaw || !llmProviders.has(providerRaw as LlmProviderName)) {
      throw new Error(`unknown provider in ${envName}: ${providerRaw ?? ""}`);
    }
    return {
      providerId: providerRaw as LlmProviderName,
      ...(model ? { model } : {}),
    };
  });
  if (refs.length === 0)
    throw new Error(`no provider is configured for task ${task}`);
  return refs;
}

export interface RoutedUsage extends ProviderUsage {
  providerId: string;
  model: string;
  payer: LlmKeyPayer | "local";
}

/** Executes schema-validated generation using the task's ordered fallback chain. */
export async function generateJsonForTask<T>(input: {
  task: LlmTask;
  prompt: string;
  schema: ZodType<T>;
  userId?: string;
  allowPlatformFallback?: boolean;
  planAllowsPlatformKey?: boolean;
  platformKey?: string;
  signal?: AbortSignal;
  onUsage?: (usage: RoutedUsage) => void;
}): Promise<T> {
  const route = resolveTaskRoute(input.task);
  let lastRetryable: unknown;
  for (let index = 0; index < route.length; index++) {
    const target = route[index]!;
    const descriptor = llmProviders.get(target.providerId)!;
    const provider = getLlmProvider(target.providerId, target.model);
    let apiKey: string | undefined;
    let payer: RoutedUsage["payer"] = "local";
    if (
      (descriptor.kind ??
        (descriptor.deployment === "self-hosted"
          ? "local-cli"
          : "hosted-key")) === "hosted-key"
    ) {
      if (!input.userId)
        throw new Error(
          "authenticated user is required to resolve provider credentials",
        );
      const credential = resolveLlmCredential({
        userId: input.userId,
        providerId: target.providerId,
        allowPlatformFallback: input.allowPlatformFallback,
        planAllowsPlatformKey: input.planAllowsPlatformKey,
        platformKey: input.platformKey,
      });
      apiKey = credential.apiKey;
      payer = credential.payer;
    }
    const model =
      target.model ??
      getLlmProviderDefaultModel(target.providerId) ??
      target.providerId;
    const options: LlmCallOptions = {
      ...(apiKey ? { apiKey } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onUsage: (usage) =>
        input.onUsage?.({
          ...usage,
          providerId: target.providerId,
          model,
          payer,
        }),
    };
    try {
      return await provider.generateJson(input.prompt, input.schema, options);
    } catch (error) {
      if (isFallbackError(error) && index < route.length - 1) {
        lastRetryable = error;
        continue;
      }
      throw error;
    }
  }
  throw (
    lastRetryable ?? new Error(`no provider succeeded for task ${input.task}`)
  );
}

function isFallbackError(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retryable;
}
