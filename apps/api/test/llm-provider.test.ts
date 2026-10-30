import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { z } from "zod";
import {
  JSON_IN_TEXT_CAPABILITIES,
  LlmProviderBase,
  type LlmToolDefinition,
} from "../src/services/llm-provider.js";

const replySchema = z.object({
  language: z.string().min(1),
  helloCount: z.number().int().nonnegative(),
});

type Reply = z.infer<typeof replySchema>;

const fakeProviderReply: Reply = { language: "fr", helloCount: 0 };

const fakeProvider = new (class extends LlmProviderBase {
  readonly capabilities = JSON_IN_TEXT_CAPABILITIES;

  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    expect(prompt.length).toBeGreaterThan(0);
    return schema.parse(fakeProviderReply);
  }
})();

describe("LlmProvider contract", () => {
  it("infers validated data from the schema", async () => {
    const reply: Reply = await fakeProvider.generateJson(
      "say hello",
      replySchema,
    );
    expect(reply).toEqual({ language: "fr", helloCount: 0 });
  });

  it("rejects data that violates the schema", async () => {
    const strict = new (class extends LlmProviderBase {
      readonly capabilities = JSON_IN_TEXT_CAPABILITIES;

      async generateJson<T>(_prompt: string, schema: ZodType<T>): Promise<T> {
        return schema.parse({ language: "", helloCount: -1 });
      }
    })();
    await expect(strict.generateJson("x", replySchema)).rejects.toThrow();
  });

  it("falls back to schema-validated operation lists for text-only providers", async () => {
    const tools: LlmToolDefinition[] = [
      {
        name: "setSpeed",
        description: "Set the speed of one clip",
        parameters: z.object({
          clipId: z.string(),
          speed: z.number().min(0.1),
        }),
      },
    ];
    const textOnly = new (class extends LlmProviderBase {
      readonly capabilities = JSON_IN_TEXT_CAPABILITIES;

      async generateJson<T>(_prompt: string, schema: ZodType<T>): Promise<T> {
        return schema.parse({
          operations: [
            { name: "setSpeed", arguments: { clipId: "clip-1", speed: 1.5 } },
          ],
        });
      }
    })();

    await expect(
      textOnly.generateWithTools("speed up the clip", tools),
    ).resolves.toEqual([
      { name: "setSpeed", arguments: { clipId: "clip-1", speed: 1.5 } },
    ]);
  });

  it("rejects tool arguments that fail their declared parameter schema", async () => {
    const tool: LlmToolDefinition = {
      name: "setSpeed",
      description: "Set the speed of one clip",
      parameters: z.object({ speed: z.number().min(0.1) }),
    };
    const textOnly = new (class extends LlmProviderBase {
      readonly capabilities = JSON_IN_TEXT_CAPABILITIES;

      async generateJson<T>(_prompt: string, schema: ZodType<T>): Promise<T> {
        return schema.parse({
          operations: [{ name: "setSpeed", arguments: { speed: 0 } }],
        });
      }
    })();

    await expect(
      textOnly.generateWithTools("bad args", [tool]),
    ).rejects.toThrow();
  });
});
