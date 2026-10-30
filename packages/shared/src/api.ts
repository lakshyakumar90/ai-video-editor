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

/**
 * A clip the user uploaded, referenced by the upload identifier the
 * server issued at upload time. Raw client filesystem paths are never
 * accepted.
 */
export const footageClipSchema = z.object({
  uploadId: z.string().min(1),
  filename: z.string().min(1).optional(),
});

/**
 * Mode 1 of the MVP (docs/mvp.md): generate a video from a text prompt.
 */
export const promptToVideoRequestSchema = z.object({
  mode: z.literal("prompt-to-video"),
  prompt: z.string().min(1),
});

/**
 * Mode 2 of the MVP (docs/mvp.md): edit a video from uploaded footage.
 */
export const footageToEditRequestSchema = z.object({
  mode: z.literal("footage-to-edit"),
  footage: z.array(footageClipSchema).min(1),
  instructions: z.string().min(1).optional(),
});

/**
 * Both MVP modes end in an editable timeline, so timeline generation
 * accepts either mode as a discriminated union on `mode`.
 */
export const generateTimelineRequestSchema = z.discriminatedUnion("mode", [
  promptToVideoRequestSchema,
  footageToEditRequestSchema,
]);

export const generateTimelineResponseSchema = timelineSchema;

export const generateScenePlansRequestSchema = z.object({
  prompt: z.string().min(1),
});

export const generateScenePlansResponseSchema = z.object({
  scenes: scenePlansSchema,
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type FootageClip = z.infer<typeof footageClipSchema>;
export type PromptToVideoRequest = z.infer<typeof promptToVideoRequestSchema>;
export type FootageToEditRequest = z.infer<typeof footageToEditRequestSchema>;
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
