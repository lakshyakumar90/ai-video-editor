import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The retrofit rule: adapter modules are implementation details. Every
 * consumer (src, scripts, future routes) must resolve LLM providers via
 * the registry. Only the registry itself may import the adapters.
 *
 * This scan keeps that promise from silently eroding.
 */
describe("LLM provider import surface", () => {
  const allowedImporters = new Set(["llm-registry"]);
  const adapterModulePattern =
    /services\/(opencode-llm-provider|fake-llm-provider|hosted-llm-provider)(?:\.js)?["']/;

  async function* tsFiles(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* tsFiles(path);
      else if (entry.name.endsWith(".ts")) yield path;
    }
  }

  it("lets only the registry import LLM adapters", async () => {
    const violations: Array<{ file: string; module: string }> = [];
    for (const dir of ["src", "scripts"]) {
      const root = join(import.meta.dirname, "..", dir);
      for await (const file of tsFiles(root)) {
        const filename = file.replaceAll("\\", "/");
        const importer = filename.split("/").at(-1) ?? "";
        if (allowedImporters.has(importer.replace(".ts", ""))) continue;
        const content = await readFile(file, "utf8");
        for (const line of content.split("\n")) {
          if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue; // comments don't import
          const match = adapterModulePattern.exec(line);
          if (match) violations.push({ file: filename, module: match[1] ?? "" });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the registry the only import surface passing", async () => {
    // Sanity-check the guard itself: the registry may import adapters.
    const registry = await readFile(
      join(import.meta.dirname, "..", "src", "services", "llm-registry.ts"),
      "utf8",
    );
    expect(registry).toMatch(/from "\.\/(opencode|fake|hosted)-llm-provider\.js"/);
  });
});
