import { z } from "zod";

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3"]);

export const resolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const projectSchema = z.object({
  title: z.string().min(1),
  aspectRatio: aspectRatioSchema,
  fps: z.number().int().positive(),
  resolution: resolutionSchema,
});

export const sceneSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  duration: z.number().positive(),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
});

export const musicSchema = z.object({
  src: z.string().optional(),
  volume: z.number().min(0).max(1).default(1),
  loop: z.boolean().default(true),
});

export const styleSchema = z.object({
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
});

export const timelineSchema = z.object({
  project: projectSchema,
  scenes: z.array(sceneSchema),
  music: musicSchema.optional(),
  style: styleSchema.optional(),
});

export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Music = z.infer<typeof musicSchema>;
export type Style = z.infer<typeof styleSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
