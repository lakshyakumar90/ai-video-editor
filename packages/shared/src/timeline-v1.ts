import { z } from "zod";
import {
  aspectRatioSchema,
  captionWordSchema,
  mvpModeSchema,
  resolutionSchema,
} from "./timeline.js";

/**
 * The pre-retrofit, scene-based timeline (schemaVersion 1). Kept only
 * so legacy timelines can be migrated (`migrateTimeline`); it is not on
 * the public API surface.
 */
export const projectSchemaV1 = z.object({
  title: z.string().min(1),
  aspectRatio: aspectRatioSchema,
  fps: z.number().int().positive(),
  resolution: resolutionSchema,
  /** Which MVP mode created this timeline; unset on legacy timelines. */
  mode: mvpModeSchema.optional(),
});

export const audioSchemaV1 = z.object({
  path: z.string().min(1),
  duration: z.number().positive(),
});

export const visualTypeSchemaV1 = z.enum(["image", "video", "color"]);
export type VisualTypeV1 = z.infer<typeof visualTypeSchemaV1>;

export const trimSchemaV1 = z.object({
  start: z.number().min(0).default(0),
  end: z.number().min(0).optional(),
});

export const visualSchemaV1 = z.object({
  type: visualTypeSchemaV1,
  source: z.string().min(1),
  trim: trimSchemaV1.optional(),
});

export const styleSchemaV1 = z.object({
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
});

export const sceneSchemaV1 = z.object({
  id: z.string().min(1),
  narration: z.string().optional(),
  audio: audioSchemaV1,
  visual: visualSchemaV1,
  captions: z.array(captionWordSchema).default([]),
});

export const musicSchemaV1 = z.object({
  src: z.string().optional(),
  volume: z.number().min(0).max(1).default(1),
  loop: z.boolean().default(true),
});

export const timelineSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  project: projectSchemaV1,
  scenes: z.array(sceneSchemaV1),
  music: musicSchemaV1.optional(),
  style: styleSchemaV1.optional(),
});

export type ProjectV1 = z.infer<typeof projectSchemaV1>;
export type AudioV1 = z.infer<typeof audioSchemaV1>;
export type VisualV1 = z.infer<typeof visualSchemaV1>;
export type StyleV1 = z.infer<typeof styleSchemaV1>;
export type SceneV1 = z.infer<typeof sceneSchemaV1>;
export type MusicV1 = z.infer<typeof musicSchemaV1>;
export type TimelineV1 = z.infer<typeof timelineSchemaV1>;
