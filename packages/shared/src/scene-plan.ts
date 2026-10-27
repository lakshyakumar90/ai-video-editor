import { z } from "zod";

export const scenePlanSchema = z.object({
  narration: z.string().min(1),
  visualQuery: z.string().min(1),
  mood: z.string().min(1),
});

export const scenePlansSchema = z.array(scenePlanSchema);

export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type ScenePlans = z.infer<typeof scenePlansSchema>;
