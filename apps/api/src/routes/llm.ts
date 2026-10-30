import { Router } from "express";
import { generateScenePlansResponseSchema } from "@repo/shared";
import { z } from "zod";
import { requireAuth } from "../middleware/require-auth.js";
import { generateJsonForTask } from "../services/llm-task-router.js";
import { recordLlmUsage } from "../services/llm-usage.js";

const planRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
});

export function llmRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.post("/scene-plan", async (req, res) => {
    const parsed = planRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: "prompt is required" } });
      return;
    }
    try {
      const plan = await generateJsonForTask({
        task: "script-planning",
        prompt: parsed.data.prompt,
        schema: generateScenePlansResponseSchema,
        userId: req.authUserId,
        onUsage: (usage) => {
          recordLlmUsage(req.authUserId!, usage);
        },
      });
      res.json(plan);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "LLM request failed";
      res.status(502).json({ error: { message } });
    }
  });
  return router;
}
