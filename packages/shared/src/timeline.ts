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

export const audioSchema = z.object({
  path: z.string().min(1),
  duration: z.number().positive(),
});

export const visualTypeSchema = z.enum(["image", "video", "color"]);

export const trimSchema = z.object({
  start: z.number().min(0).default(0),
  end: z.number().min(0).optional(),
});

export const visualSchema = z.object({
  type: visualTypeSchema,
  source: z.string().min(1),
  trim: trimSchema.optional(),
});

export const captionWordSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
});

export const sceneSchema = z.object({
  id: z.string().min(1),
  narration: z.string().optional(),
  audio: audioSchema,
  visual: visualSchema,
  captions: z.array(captionWordSchema).default([]),
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
export type Audio = z.infer<typeof audioSchema>;
export type VisualType = z.infer<typeof visualTypeSchema>;
export type Trim = z.infer<typeof trimSchema>;
export type Visual = z.infer<typeof visualSchema>;
export type CaptionWord = z.infer<typeof captionWordSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Music = z.infer<typeof musicSchema>;
export type Style = z.infer<typeof styleSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
