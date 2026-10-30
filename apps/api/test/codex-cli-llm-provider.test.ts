import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CodexCliProvider } from "../src/services/codex-cli-llm-provider.js";

describe("Codex CLI adapter", () => {
  it("runs read-only in an empty workspace with a schema and parses the final message", async () => {
    const provider = new CodexCliProvider({
      runner: async (_exe, args, prompt, options) => {
        expect(await readdir(options.cwd)).toEqual([]);
        expect(args).toContain("read-only");
        expect(args).toContain("--ephemeral");
        expect(args).toContain("--skip-git-repo-check");
        expect(args).toContain("--output-schema");
        expect(prompt).toContain("must satisfy this schema");
        const schemaPath = args[args.indexOf("--output-schema") + 1]!;
        expect(JSON.parse(await readFile(schemaPath, "utf8"))).toHaveProperty(
          "type",
          "object",
        );
        await writeFile(
          args[args.indexOf("--output-last-message") + 1]!,
          '{"ok":true}',
          "utf8",
        );
        return { stdout: "" };
      },
    });
    await expect(
      provider.generateJson("return ok", z.object({ ok: z.boolean() })),
    ).resolves.toEqual({ ok: true });
  });

  it("maps CLI timeouts to a stable timeout error", async () => {
    const provider = new CodexCliProvider({
      runner: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    await expect(
      provider.generateJson("return ok", z.string()),
    ).rejects.toMatchObject({ providerId: "codex", code: "timeout" });
  });

  it("returns schema-validated tool operations through JSON-in-text fallback", async () => {
    const provider = new CodexCliProvider({
      runner: async (_exe, args) => {
        await writeFile(
          args[args.indexOf("--output-last-message") + 1]!,
          '{"operations":[{"name":"save","arguments":{"value":"ok"}}]}',
          "utf8",
        );
        return { stdout: "" };
      },
    });
    const calls = await provider.generateWithTools("save ok", [
      {
        name: "save",
        description: "Save a value",
        parameters: z.object({ value: z.string() }),
      },
    ]);
    expect(calls).toEqual([{ name: "save", arguments: { value: "ok" } }]);
  });
});
