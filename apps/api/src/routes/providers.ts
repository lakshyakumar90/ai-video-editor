import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/require-auth.js";
import { llmKeyVault } from "../services/llm-key-vault.js";

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

  return router;
}
