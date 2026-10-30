import { z } from "zod";
import {
  captionWordSchema,
  reframeRegionSchema,
  stableIdSchema,
} from "./timeline.js";

/**
 * The single edit vocabulary shared by the LLM tool loop, the API and
 * the UI. Every operation targets stable ids from the timeline, so the
 * same object an undo entry points at is the object the UI highlights.
 * Operations describe intent; applying them is the pipeline's job.
 */
export const editOperationSchema = z.discriminatedUnion("kind", [
  /** Trim a media clip to a new source-in point and/or duration. */
  z.object({
    kind: z.literal("trim"),
    clipId: stableIdSchema,
    sourceIn: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
  }),

  /** Split one clip into two at a timeline time inside it. */
  z.object({
    kind: z.literal("split"),
    clipId: stableIdSchema,
    at: z.number().min(0),
  }),

  /** Delete a clip from its track. */
  z.object({
    kind: z.literal("delete"),
    clipId: stableIdSchema,
  }),

  /** Move a clip in time, optionally onto another track. */
  z.object({
    kind: z.literal("move"),
    clipId: stableIdSchema,
    start: z.number().min(0),
    trackId: stableIdSchema.optional(),
  }),

  /** Point an existing clip at a different asset without creating one. */
  z.object({
    kind: z.literal("replaceClip"),
    clipId: stableIdSchema,
    assetId: stableIdSchema,
    sourceIn: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
  }),

  /** Change the text of a captions clip. */
  z.object({
    kind: z.literal("setText"),
    clipId: stableIdSchema,
    text: z.string().min(1),
  }),

  /** Change a clip's audio gain (0 mutes, 1 is unity). */
  z.object({
    kind: z.literal("setVolume"),
    clipId: stableIdSchema,
    volume: z.number().min(0).max(1),
  }),

  /** Change a clip's playback rate. */
  z.object({
    kind: z.literal("setSpeed"),
    clipId: stableIdSchema,
    speed: z.number().min(0.1).max(10),
  }),

  /** Add a captions clip carrying word timings. */
  z.object({
    kind: z.literal("addCaptions"),
    words: z.array(captionWordSchema).min(1),
    start: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
    trackId: stableIdSchema.optional(),
  }),

  /** Cut silent spans out of a clip's source, given in source time. */
  z.object({
    kind: z.literal("removeSilence"),
    clipId: stableIdSchema,
    ranges: z
      .array(
        z.object({ start: z.number().min(0), end: z.number().min(0) }),
      )
      .optional(),
  }),

  /** Reframe a clip's viewport to a region of the source frame. */
  z.object({
    kind: z.literal("reframe"),
    clipId: stableIdSchema,
    region: reframeRegionSchema,
  }),
]);

export type EditOperation = z.infer<typeof editOperationSchema>;

export type EditOperationKind = EditOperation["kind"];

/** An ordered batch of edits, what the API and LLM tool loop exchange. */
export const editBatchSchema = z.object({
  operations: z.array(editOperationSchema).min(1),
});

export type EditBatch = z.infer<typeof editBatchSchema>;
