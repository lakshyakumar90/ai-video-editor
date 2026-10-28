import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { z } from "zod";
import type { LlmProvider } from "../src/services/llm-provider.js";

const replySchema = z.object({
  language: z.string().min(1),
  helloCount: z.number().int().nonnegative(),
});

type Reply = z.infer<typeof replySchema>;

const fakeProviderReply: Reply = { language: "fr", helloCount: 0 };

const fakeProvider: LlmProvider = {
  async generateJson<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    expect(prompt.length).toBeGreaterThan(0);
    return schema.parse(fakeProviderReply);
  },
};

describe("LlmProvider contract", () => {
  it("infers validated data from the schema", async () => {
    const reply: Reply = await fakeProvider.generateJson("say hello", replySchema);
    expect(reply).toEqual({ language: "fr", helloCount: 0 });
  });

  it("rejects data that violates the schema", async () => {
    const strict: LlmProvider = {
      async generateJson<T>(_prompt: string, schema: ZodType<T>): Promise<T> {
        return schema.parse({ language: "", helloCount: -1 });
      },
    };
    await expect(strict.generateJson("x", replySchema)).rejects.toThrow();
  });
});
