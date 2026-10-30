import { z } from "zod";
import {
  timelineSchema,
  type Project,
  type Style,
  type Timeline,
  type TimelineInput,
} from "./timeline.js";
import {
  timelineSchemaV1,
  type TimelineV1,
} from "./timeline-v1.js";

/** Raised when neither the v1 nor the v2 schema accepts the input. */
export class TimelineMigrationError extends Error {
  /** Human-readable issue list, one string per problem. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`timeline does not match schemaVersion 1 or 2 - ${issues.join("; ")}`);
    this.name = "TimelineMigrationError";
    this.issues = issues;
  }
}

function issueMessages(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
  );
}

/**
 * Migrates a scenes-only timeline (schemaVersion 1) into the v2
 * tracks-and-clips model. Sources are untouched: each scene's audio,
 * visual and captions become assets and clips with the same times.
 *
 * Projection rules (v1 recorded none of this, so the migration fixes a
 * documented convention):
 * - scene visuals become `stock` or `generated`-color assets; scene
 *   audio (locally synthesized narration) becomes `generated` assets;
 *   music becomes a `stock` audio asset.
 * - v1 caption word times were scene-relative; they are offset by the
 *   scene's timeline start.
 * - legacy `music` is folded into a dedicated audio track.
 */
export function migrateV1TimelineToV2(v1: TimelineV1): Timeline {
  // Stable, derivable ids: assets take their id from the source path.
  const assets = new Map<string, Timeline["assets"][number]>();
  const assetFor = (
    source: string,
    kind: Timeline["assets"][number]["kind"],
    origin: Timeline["assets"][number]["origin"],
    duration?: number,
  ): Timeline["assets"][number] => {
    const existing = assets.get(source);
    if (existing) {
      // Backfill a first-seen duration so media assets always declare one.
      if (existing.duration === undefined && duration !== undefined) {
        existing.duration = duration;
      }
      return existing;
    }
    const asset = {
      id: `asset-${source.replace(/[^a-zA-Z0-9._-]+/g, "-")}`,
      kind,
      origin,
      src: source,
      ...(duration !== undefined ? { duration } : {}),
      silenceRanges: [],
    } as Timeline["assets"][number];
    assets.set(source, asset);
    return asset;
  };

  const videoClips: Timeline["tracks"][number]["clips"] = [];
  const audioClips: Timeline["tracks"][number]["clips"] = [];
  const captionClips: Timeline["tracks"][number]["clips"] = [];
  let cursor = 0;

  for (const scene of v1.scenes) {
    const sceneStart = cursor;
    const sceneDuration = scene.audio.duration;

    // Visual → video-track clip (and its asset).
    if (scene.visual.type === "color") {
      const colorAsset = assetFor(scene.visual.source, "color", "generated");
      videoClips.push({
        id: `clip-${scene.id}-visual`,
        assetId: colorAsset.id,
        sourceIn: 0,
        start: sceneStart,
        duration: sceneDuration,
        speed: 1,
        volume: 1,
      });
    } else {
      const trim = scene.visual.trim;
      const sourceIn = trim?.start ?? 0;
      const sourceOut = trim?.end ?? sourceIn + sceneDuration;
      const mediaAsset = assetFor(
        scene.visual.source,
        scene.visual.type,
        "stock",
        // First sighting declares the asset long enough for its own trim.
        sourceIn > 0 ? sourceIn + (sourceOut - sourceIn) : sourceOut,
      );
      videoClips.push({
        id: `clip-${scene.id}-visual`,
        assetId: mediaAsset.id,
        sourceIn,
        start: sceneStart,
        duration: sourceOut - sourceIn,
        speed: 1,
        volume: 1,
      });
    }

    // Narration audio → audio-track clip (generated TTS asset).
    const audioAsset = assetFor(scene.audio.path, "audio", "generated", sceneDuration);
    audioClips.push({
      id: `clip-${scene.id}-narration`,
      assetId: audioAsset.id,
      sourceIn: 0,
      start: sceneStart,
      duration: sceneDuration,
      speed: 1,
      volume: 1,
    });

    // Captions → one captions clip per scene, words offset to timeline time.
    if (scene.narration || scene.captions.length > 0) {
      const words = scene.captions.map((word) => ({
        word: word.word,
        start: sceneStart + word.start,
        end: sceneStart + word.end,
      }));
      const text =
        scene.narration ?? words.map((word) => word.word).join(" ");
      captionClips.push({
        id: `clip-${scene.id}-captions`,
        start: sceneStart,
        duration: sceneDuration,
        text,
        words,
      });
    }

    cursor += sceneDuration;
  }

  const trackList: Timeline["tracks"] = [];
  if (videoClips.length > 0) {
    trackList.push({ id: "track-video", kind: "video", muted: false, clips: videoClips });
  }
  trackList.push({ id: "track-audio", kind: "audio", muted: false, clips: audioClips });
  if (captionClips.length > 0) {
    trackList.push({
      id: "track-captions",
      kind: "captions",
      muted: false,
      clips: captionClips,
    });
  }

  // Legacy music folds into its own audio track.
  if (v1.music?.src) {
    const total = cursor;
    const musicAsset = assetFor(
      v1.music.src,
      "audio",
      "stock",
      // Unknown length: give it at least the full timeline duration so
      // clips can cover the video. The parser caps the clip below.
      total,
    );
    trackList.push({
      id: "track-music",
      kind: "audio",
      name: "Music",
      muted: false,
      clips: [
        {
          id: "clip-music",
          assetId: musicAsset.id,
          sourceIn: 0,
          start: 0,
          duration: total,
          speed: 1,
          volume: v1.music.volume,
        },
      ],
    });
  }

  const project: Project = {
    title: v1.project.title,
    aspectRatio: v1.project.aspectRatio,
    fps: v1.project.fps,
    resolution: v1.project.resolution,
    ...(v1.project.mode !== undefined ? { mode: v1.project.mode } : {}),
  };

  const style: Style | undefined = v1.style
    ? {
        ...(v1.style.backgroundColor !== undefined
          ? { backgroundColor: v1.style.backgroundColor }
          : {}),
        ...(v1.style.textColor !== undefined ? { textColor: v1.style.textColor } : {}),
        ...(v1.style.fontFamily !== undefined ? { fontFamily: v1.style.fontFamily } : {}),
        ...(v1.style.fontSize !== undefined ? { fontSize: v1.style.fontSize } : {}),
      }
    : undefined;

  const migrated = {
    schemaVersion: 2,
    project,
    assets: [...assets.values()],
    tracks: trackList,
    ...(style !== undefined ? { style } : {}),
  };

  // The migration must never emit a timeline the v2 schema rejects.
  return timelineSchema.parse(migrated);
}

/**
 * Accepts either schema version: v2 passes through unchanged; v1 is
 * migrated with {@link migrateV1TimelineToV2}. Any other input rejects
 * with a `TimelineMigrationError` listing what was wrong.
 */
export function migrateTimeline(input: TimelineInput): Timeline {
  const v2 = timelineSchema.safeParse(input);
  if (v2.success) return v2.data;

  const v1 = timelineSchemaV1.safeParse(input);
  if (v1.success) return migrateV1TimelineToV2(v1.data);

  throw new TimelineMigrationError([
    ...issueMessages(v2.error),
    ...issueMessages(v1.error),
  ]);
}
