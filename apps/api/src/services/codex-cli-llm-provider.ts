import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z, type ZodType } from "zod";
import {
  JSON_IN_TEXT_CAPABILITIES,
  LlmProviderBase,
  reportUsage,
  type LlmCallOptions,
  type ProviderCapabilities,
} from "./llm-provider.js";
import { LlmProviderError, mapProviderError } from "./llm-provider-error.js";

export interface CodexCliOptions {
  executable?: string;
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  runner?: CodexCliRunner;
}

export type CodexCliRunner = (
  executable: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string }>;

/** Codex CLI adapter. Every request runs read-only in a fresh empty directory. */
export class CodexCliProvider extends LlmProviderBase {
  readonly capabilities: ProviderCapabilities = JSON_IN_TEXT_CAPABILITIES;
  private readonly executable: string;
  constructor(private readonly config: CodexCliOptions = {}) {
    super();
    this.executable = config.executable ?? "codex";
  }

  async generateJson<T>(
    prompt: string,
    schema: ZodType<T>,
    options?: LlmCallOptions,
  ): Promise<T> {
    if (!prompt.trim())
      throw new LlmProviderError(
        "codex",
        "invalid_request",
        "prompt must not be empty",
      );
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-llm-"));
    const workdir = path.join(tempRoot, "workspace");
    await mkdir(workdir);
    const schemaPath = path.join(tempRoot, "response-schema.json");
    const outputPath = path.join(tempRoot, "final-message.txt");
    try {
      await writeFile(
        schemaPath,
        JSON.stringify(z.toJSONSchema(schema)),
        "utf8",
      );
      const instruction = [
        "Return a single JSON value and do not modify files or run commands.",
        `The JSON must satisfy this schema: ${JSON.stringify(z.toJSONSchema(schema))}`,
        `User request: ${prompt}`,
      ].join("\n\n");
      const args = [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "--cd",
        workdir,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
      ];
      if (this.config.model) args.push("--model", this.config.model);
      args.push("-");
      const { stdout } = await (this.config.runner ?? runCli)(
        this.executable,
        args,
        instruction,
        {
          cwd: workdir,
          timeoutMs: this.config.timeoutMs ?? 120_000,
          signal: options?.signal,
          env: {
            ...process.env,
            ...this.config.env,
            ...(options?.apiKey ? { CODEX_API_KEY: options.apiKey } : {}),
          },
        },
      );
      reportCodexUsage(stdout, options);
      let message: string;
      try {
        message = await readFile(outputPath, "utf8");
      } catch {
        message = lastAgentMessage(stdout);
      }
      return schema.parse(parseJson(message));
    } catch (error) {
      throw mapProviderError("codex", error);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function runCli(
  executable: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else
        reject(
          new Error(
            stderr.includes("SIGTERM")
              ? "Codex CLI timed out"
              : `Codex CLI exited (${code}): ${stderr.slice(-2000)}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

function lastAgentMessage(output: string): string {
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text
      )
        return event.item.text;
    } catch {
      /* Ignore non-JSON diagnostic lines. */
    }
  }
  throw new LlmProviderError(
    "codex",
    "invalid_response",
    "Codex CLI returned no final assistant message",
  );
}

function parseJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new LlmProviderError(
      "codex",
      "invalid_response",
      "Codex CLI did not return valid JSON",
      { cause: error },
    );
  }
}

function reportCodexUsage(output: string, options?: LlmCallOptions): void {
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  if (usage)
    reportUsage(options, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });
}
