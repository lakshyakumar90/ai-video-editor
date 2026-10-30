import { z } from "zod";

/**
 * Timeline schemaVersion 2: a non-destructive edit model.
 *
 * - `assets[]` holds every piece of source media (uploaded, stock or
 *   generated) with its proxy path, transcript and silence ranges.
 * - `tracks[]` are named layers (video, audio, captions, overlay), each
 *   holding an ordered, non-overlapping sequence of `clips[]`.
 * - Every asset, track and clip carries a stable `id` so edit
 *   operations and undo stack entries can point at them durably.
 * - Clips never mutate sources: each clip states WHERE its content
 *   comes from (`assetId` + `sourceIn`), WHERE it sits (`start`),
 *   and HOW it plays (`duration`, `speed`, `volume`). Renderers read
 *   the source, apply speed/volume and place the trimmed span.
 */

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3"]);

export const resolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** The two MVP modes (docs/mvp.md). */
export const mvpModeSchema = z.enum(["prompt-to-video", "footage-to-edit"]);

export const projectSchema = z.object({
  title: z.string().min(1),
  aspectRatio: aspectRatioSchema,
  fps: z.number().int().positive(),
  resolution: resolutionSchema,
  /** Which MVP mode created this timeline; unset on legacy timelines. */
  mode: mvpModeSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Stable ids                                                          */
/* ------------------------------------------------------------------ */

/** Non-empty id that is not just whitespace; ids are stable across edits. */
export const stableIdSchema = z
  .string()
  .min(1, "id must not be empty")
  .refine((id) => id.trim().length > 0, "id must not be blank");

/**
 * One timed word of a caption line or transcript. `start`/`end` are in
 * the timebase the container uses (see each usage).
 */
export const captionWordSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
});

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

/** Where an asset came from. */
export const assetOriginSchema = z.enum(["uploaded", "stock", "generated"]);

export const assetKindSchema = z.enum(["video", "audio", "image", "color"]);

/** A single detected silent span inside the asset's own timebase. */
export const silenceRangeSchema = z
  .object({
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine(
    (range) => range.end > range.start,
    "silence range end must be greater than start",
  );

/**
 * Speech transcription for the asset (whisper.cpp output). Words are
 * timed in the asset's own timebase, not timeline time.
 */
export const transcriptSchema = z.object({
  text: z.string().min(1),
  language: z.string().min(1).optional(),
  words: z.array(captionWordSchema).default([]),
});

export const assetSchema = z
  .object({
    id: stableIdSchema,
    kind: assetKindSchema,
    origin: assetOriginSchema,
    /** The source the renderer reads (path or URL). Never a raw
     * client-supplied path on hosted deployments. */
    src: z.string().min(1),
    /** Human label shown in the editor/project bin. */
    name: z.string().min(1).optional(),
    /** Lower-resolution preview copy used when editing; edits re-render. */
    proxyPath: z.string().min(1).optional(),
    /** Known source duration, seconds. Images/colors have none. */
    duration: z.number().positive().optional(),
    transcript: transcriptSchema.optional(),
    /** Silent spans detected in the asset's own timebase. */
    silenceRanges: z.array(silenceRangeSchema).default([]),
  })
  .refine(
    (asset) =>
      asset.kind === "video" || asset.kind === "audio" ? asset.duration !== undefined : true,
    { message: "video and audio assets must declare their duration" },
  )
  .refine(
    (asset) => asset.kind !== "color" || asset.silenceRanges.length === 0,
    { message: "silence ranges are meaningless on color assets" },
  );

/* ------------------------------------------------------------------ */
/* Clips and tracks                                                    */
/* ------------------------------------------------------------------ */

/**
 * A reframing of the clip's source span for the render viewport.
 * Values are fractions of the source frame (0..1), not pixels, so a
 * reframe survives resolution changes.
 */
export const reframeRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .refine(
    (region) => region.x + region.width <= 1 && region.y + region.height <= 1,
    "reframe region must stay inside the source frame",
  );

/**
 * A clip placed on a video/overlay/audio track: a non-destructive
 * reference to a span of an asset.
 *
 * Timeline duration is `duration`; the source span consumed is
 * `duration * speed`, starting at `sourceIn` (see {@link sourceOutOf}).
 * `speed` changes playback rate without re-encoding the source, and
 * `volume` scales the clip's own audio only.
 */
export const mediaClipSchema = z.object({
  id: stableIdSchema,
  /** Reference into `assets[]` - stable across undo/redo. */
  assetId: stableIdSchema,
  /** Source-time position the clip starts reading, seconds. */
  sourceIn: z.number().min(0),
  /** Timeline position on its track, seconds. */
  start: z.number().min(0),
  /** Timeline duration, seconds (after `speed` is applied). */
  duration: z.number().positive("duration must be greater than zero"),
  /** Playback rate; 2 plays the source span twice as fast. */
  speed: z.number().min(0.1, "speed must be at least 0.1").max(10).default(1),
  /** Clip-local audio gain; 0 mutes the clip, 1 is unity. */
  volume: z.number().min(0, "volume must be at least 0").max(1).default(1),
  /** Optional custom framing of the source span. */
  reframe: reframeRegionSchema.optional(),
});

/**
 * A clip on a captions track: styled text over time, with optional
 * word timings to drive karaoke captions. Word times are TIMELINE
 * time, absolute, not source-relative.
 */
export const captionClipSchema = z.object({
  id: stableIdSchema,
  start: z.number().min(0),
  duration: z.number().positive("duration must be greater than zero"),
  text: z.string().min(1),
  words: z.array(captionWordSchema).default([]),
});

export const clipSchema = z.union([mediaClipSchema, captionClipSchema]);

export const trackKindSchema = z.enum(["video", "audio", "captions", "overlay"]);

export const trackSchema = z.object({
  id: stableIdSchema,
  kind: trackKindSchema,
  name: z.string().min(1).optional(),
  muted: z.boolean().default(false),
  clips: z.array(clipSchema),
});

/** End source point of a media clip on its asset's timebase. */
export function sourceOutOf(clip: { sourceIn: number; duration: number; speed: number }): number {
  return clip.sourceIn + clip.duration * clip.speed;
}

/* ------------------------------------------------------------------ */
/* Style                                                               */
/* ------------------------------------------------------------------ */

export const styleSchema = z.object({
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
});

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

export const timelineSchema = z
  .object({
    schemaVersion: z.literal(2, {
      message: "expected schemaVersion 2 (migrate older timelines with migrateTimeline)",
    }),
    project: projectSchema,
    /** Every piece of source media used by clips. */
    assets: z.array(assetSchema),
    /** Named layers in paint order (later tracks on top). */
    tracks: z.array(trackSchema),
    style: styleSchema.optional(),
  })
  .superRefine((timeline, ctx) => {
    const issues: string[] = [];

    // Duplicate ids make edits and undo ambiguous - reject them up front.
    const seen = new Map<string, string>();
    const checkId = (id: string, label: string) => {
      if (seen.has(id)) issues.push(`duplicate id "${id}" used by ${seen.get(id)} and ${label}`);
      else seen.set(id, label);
    };
    timeline.assets.forEach((asset, index) => checkId(asset.id, `assets[${index}]`));
    timeline.tracks.forEach((track) => {
      checkId(track.id, `track "${track.id}"`);
      track.clips.forEach((clip) => checkId(clip.id, `clip "${clip.id}"`));
    });

    const assets = new Map(timeline.assets.map((asset) => [asset.id, asset]));
    const findAsset = (id: string) => assets.get(id);
    const epsilon = 1e-9;

    for (const track of timeline.tracks) {
      const clips = [...track.clips].sort((a, b) => a.start - b.start);
      let previous: (typeof clips)[number] | undefined;
      for (const clip of clips) {
        // Captions clips vs media clips, per track kind.
        if (track.kind === "captions") {
          if ("assetId" in clip) {
            issues.push(`clip "${clip.id}" on captions track "${track.id}" must not reference an asset`);
          }
        } else {
          if (!("assetId" in clip)) {
            issues.push(`clip "${clip.id}" on ${track.kind} track "${track.id}" must reference an assetId`);
            previous = clip;
            continue;
          }
          const asset = findAsset(clip.assetId);
          if (!asset) {
            issues.push(`clip "${clip.id}" references unknown asset "${clip.assetId}"`);
            previous = clip;
            continue;
          }
          const kinds = track.kind === "audio" ? (["audio"] as const) : (["video", "image", "color"] as const);
          if (!(kinds as readonly string[]).includes(asset.kind)) {
            issues.push(
              `clip "${clip.id}" places ${asset.kind} asset "${asset.id}" on a ${track.kind} track "${track.id}"`,
            );
            continue;
          }
          if (asset.kind !== "color" && asset.duration !== undefined) {
            const out = sourceOutOf(clip);
            if (out > asset.duration + epsilon) {
              issues.push(
                `clip "${clip.id}" spans source [${clip.sourceIn}, ${out}] which exceeds asset "${asset.id}" duration ${asset.duration}`,
              );
            }
          }
          if (clip.reframe && asset.kind === "audio") {
            issues.push(`clip "${clip.id}" has a reframe but audio assets have no frame`);
          }
        }

        // Caption words must sit inside their clip's window.
        if ("words" in clip) {
          for (const word of clip.words) {
            if (word.start < clip.start - epsilon || word.end > clip.start + clip.duration + epsilon) {
              issues.push(
                `caption word "${word.word}" [${word.start}, ${word.end}] falls outside clip "${clip.id}" window [${clip.start}, ${clip.start + clip.duration}]`,
              );
            }
          }
        }

        // Non-overlapping clips per track (touching edges allowed).
        if (previous && clip.start < previous.start + previous.duration - epsilon) {
          issues.push(
            `clip "${clip.id}" starts at ${clip.start} before clip "${previous.id}" ends at ${previous.start + previous.duration} on track "${track.id}"`,
          );
        }
        previous = clip;
      }
    }

    if (issues.length > 0) {
      for (const issue of issues) {
        ctx.addIssue({ code: "custom", message: issue });
      }
    }
  });

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Anything a caller holds that could be a v1 or v2 timeline. */
export type TimelineInput = unknown;

export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type MvpMode = z.infer<typeof mvpModeSchema>;
export type Project = z.infer<typeof projectSchema>;
export type StableId = z.infer<typeof stableIdSchema>;
export type AssetOrigin = z.infer<typeof assetOriginSchema>;
export type AssetKind = z.infer<typeof assetKindSchema>;
export type SilenceRange = z.infer<typeof silenceRangeSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type CaptionWord = z.infer<typeof captionWordSchema>;
export type ReframeRegion = z.infer<typeof reframeRegionSchema>;
export type MediaClip = z.infer<typeof mediaClipSchema>;
export type CaptionClip = z.infer<typeof captionClipSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type TrackKind = z.infer<typeof trackKindSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Style = z.infer<typeof styleSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
