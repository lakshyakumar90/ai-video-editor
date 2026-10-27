import { z } from "zod";
import { timelineSchema } from "./timeline.js";
import { scenePlansSchema } from "./scene-plan.js";

export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const generateTimelineRequestSchema = z.object({
  prompt: z.string().min(1),
});

export const generateTimelineResponseSchema = timelineSchema;

export const generateScenePlansRequestSchema = z.object({
  prompt: z.string().min(1),
});

export const generateScenePlansResponseSchema = z.object({
  scenes: scenePlansSchema,
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type GenerateTimelineRequest = z.infer<
  typeof generateTimelineRequestSchema
>;
export type GenerateTimelineResponse = z.infer<
  typeof generateTimelineResponseSchema
>;
export type GenerateScenePlansRequest = z.infer<
  typeof generateScenePlansRequestSchema
>;
export type GenerateScenePlansResponse = z.infer<
  typeof generateScenePlansResponseSchema
>;
