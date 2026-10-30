import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/require-auth.js";
import { llmKeyVault } from "../services/llm-key-vault.js";
import { llmProviders, probeLlmProvider } from "../services/llm-registry.js";
import { LlmProviderError } from "../services/llm-provider-error.js";
import { resolveLlmCredential } from "../services/llm-credentials.js";
import { recordLlmUsage } from "../services/llm-usage.js";

const saveKeySchema = z.object({
  providerId: z.string().min(1).max(80),
  apiKey: z.string().min(1).max(4096),
});

export function providersRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/keys", (req, res) => {
    res.json({ keys: llmKeyVault.list(req.authUserId!) });
  });

  router.put("/keys", (req, res) => {
    const parsed = saveKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: { message: "providerId and apiKey are required" } });
      return;
    }
    const { providerId, apiKey } = parsed.data;
    const key = llmKeyVault.set(req.authUserId!, providerId, apiKey);
    res.json({ key });
  });

  router.delete("/keys/:providerId", (req, res) => {
    llmKeyVault.delete(req.authUserId!, req.params.providerId!);
    res.status(204).end();
  });

  router.post("/test", async (req, res) => {
    const providerId = z.string().min(1).safeParse(req.body?.providerId);
    if (!providerId.success || !llmProviders.has(providerId.data as never)) {
      res.status(400).json({ ok: false, error: "unknown provider" });
      return;
    }
    const id = providerId.data;
    const descriptor = llmProviders.get(id as never)!;
    try {
      const isLocal =
        descriptor.kind === "local-cli" || descriptor.kind === "test";
      const credential = isLocal
        ? undefined
        : resolveLlmCredential({ userId: req.authUserId!, providerId: id });
      await probeLlmProvider(id, {
        ...(credential ? { apiKey: credential.apiKey } : {}),
        maxOutputTokens: 1,
        onUsage: (usage) =>
          recordLlmUsage(req.authUserId!, {
            ...usage,
            providerId: id,
            model: descriptor.defaultModel ?? id,
            payer: credential?.payer ?? "local",
          }),
      });
      res.json({
        ok: true,
        providerId: id,
        capabilities: descriptor.capabilities,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "provider test failed";
      const status =
        error instanceof LlmProviderError && error.code === "missing_key"
          ? 400
          : 502;
      res.status(status).json({
        ok: false,
        providerId: id,
        capabilities: descriptor.capabilities,
        error: message,
      });
    }
  });

  return router;
}
