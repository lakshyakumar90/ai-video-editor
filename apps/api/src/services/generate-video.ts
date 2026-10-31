import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  generateScenePlansResponseSchema,
  timelineSchema,
  type Asset,
  type ScenePlan,
  type Timeline,
} from "@repo/shared";
import { env } from "../config/env.js";
import { generateJsonForTask } from "./llm-task-router.js";
import {
  createMediaProviders,
  ensureProceduralMusicLibrary,
  getMusicLibrary,
  rankSceneStock,
  type StockCandidate,
} from "./media-providers.js";
import { renderTimeline, type RenderResult } from "./timeline-renderer.js";

export type PipelineStage =
  | "planScript"
  | "synthesizeVoice"
  | "fetchVisuals"
  | "generateCaptions"
  | "assembleTimeline"
  | "renderTimeline";
export type ProgressCallback = (stage: PipelineStage, percent: number) => void;
export type StepTimings = Partial<Record<PipelineStage, number>>;

export interface GenerateVideoOptions {
  userId: string;
  prompt: string;
  outputPath?: string;
  aspectRatio?: "9:16" | "16:9" | "1:1";
  quality?: "preview" | "final";
  onProgress?: ProgressCallback;
}

function report(
  onProgress: ProgressCallback | undefined,
  stage: PipelineStage,
  percent: number,
) {
  onProgress?.(stage, percent);
}

async function measured<T>(
  stage: PipelineStage,
  timings: StepTimings,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const durationMs = Math.round(performance.now() - started);
    timings[stage] = (timings[stage] ?? 0) + durationMs;
    console.info(
      JSON.stringify({ event: "pipeline.step", step: stage, durationMs }),
    );
  }
}

export async function planScript(input: {
  userId: string;
  prompt: string;
}): Promise<ScenePlan[]> {
  const result = await generateJsonForTask({
    task: "script-planning",
    userId: input.userId,
    prompt: `Create a concise, visually specific short video script for this request. Return 3 scenes. Keep narration natural and concise; visualQuery must describe footage that can be found in stock video.\n\nRequest: ${input.prompt}`,
    schema: generateScenePlansResponseSchema,
  });
  return result.scenes;
}

export async function synthesizeVoice(input: {
  userId: string;
  sceneId: string;
  scene: ScenePlan;
}): Promise<{ key: string; url: string; duration: number }> {
  const providers = createMediaProviders();
  return providers.tts.synthesize({
    userId: input.userId,
    sceneId: input.sceneId,
    text: input.scene.narration,
    storage: providers.storage,
  });
}

export async function fetchVisuals(input: {
  userId: string;
  candidate: StockCandidate;
}): Promise<{ key: string; url: string; candidate: StockCandidate }> {
  const providers = createMediaProviders();
  const downloaded = await providers.stock.download({
    userId: input.userId,
    candidate: input.candidate,
    storage: providers.storage,
  });
  return { ...downloaded, candidate: input.candidate };
}

export async function generateCaptions(input: {
  userId: string;
  sceneId: string;
  speech: Promise<{ key: string; url: string; duration: number }>;
}): Promise<{ words: Array<{ word: string; start: number; end: number }> }> {
  const providers = createMediaProviders();
  const speech = await input.speech;
  const transcript = await providers.transcription.transcribe({
    userId: input.userId,
    audioPath: providers.fileUrlToPath(speech.url),
  });
  return { words: transcript.words };
}

export function assembleTimeline(input: {
  title: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  scenes: Array<{
    scene: ScenePlan;
    speech: { url: string; duration: number };
    visual: { url: string; candidate: StockCandidate };
    words: Array<{ word: string; start: number; end: number }>;
  }>;
  musicUrl?: string;
}): Timeline {
  const assets: Asset[] = [];
  const videoClips: Timeline["tracks"][number]["clips"] = [];
  const voiceClips: Timeline["tracks"][number]["clips"] = [];
  const captionClips: Timeline["tracks"][number]["clips"] = [];
  let cursor = 0;
  for (const [index, scene] of input.scenes.entries()) {
    const videoAssetId = `video-${index + 1}`;
    const audioAssetId = `voice-${index + 1}`;
    assets.push({
      id: videoAssetId,
      kind: "video",
      origin: "stock",
      src: scene.visual.url,
      name: scene.visual.candidate.description,
      duration: scene.visual.candidate.duration,
      thumbnails: [],
      sceneChanges: [],
      frameDescriptions: [],
      silenceRanges: [],
    });
    assets.push({
      id: audioAssetId,
      kind: "audio",
      origin: "generated",
      src: scene.speech.url,
      name: `Narration ${index + 1}`,
      duration: scene.speech.duration,
      thumbnails: [],
      sceneChanges: [],
      frameDescriptions: [],
      silenceRanges: [],
    });
    const duration = scene.speech.duration;
    videoClips.push({
      id: `video-clip-${index + 1}`,
      assetId: videoAssetId,
      sourceIn: 0,
      start: cursor,
      duration,
      speed: 1,
      volume: 0,
    });
    voiceClips.push({
      id: `voice-clip-${index + 1}`,
      assetId: audioAssetId,
      sourceIn: 0,
      start: cursor,
      duration,
      speed: 1,
      volume: 1,
    });
    const words = scene.words.map((word) => ({
      ...word,
      start: word.start + cursor,
      end: word.end + cursor,
    }));
    for (let at = 0; at < words.length; at += 4) {
      const group = words.slice(at, at + 4);
      if (!group.length) continue;
      const start = Math.max(cursor, group[0]!.start);
      const end = Math.min(cursor + duration, group.at(-1)!.end);
      if (end > start)
        captionClips.push({
          id: `caption-${index + 1}-${at / 4 + 1}`,
          start,
          duration: end - start,
          text: group.map((word) => word.word).join(" "),
          words: group,
        });
    }
    cursor += duration;
  }
  const tracks: Timeline["tracks"] = [
    {
      id: "video-track",
      kind: "video",
      name: "Visuals",
      muted: false,
      clips: videoClips,
    },
    {
      id: "narration-track",
      kind: "audio",
      name: "Narration",
      muted: false,
      clips: voiceClips,
    },
    {
      id: "captions-track",
      kind: "captions",
      name: "Captions",
      muted: false,
      clips: captionClips,
    },
  ];
  if (input.musicUrl) {
    const musicId = "music-bed";
    assets.push({
      id: musicId,
      kind: "audio",
      origin: "generated",
      src: input.musicUrl,
      name: "Music bed",
      duration: Math.max(cursor, 1),
      thumbnails: [],
      sceneChanges: [],
      frameDescriptions: [],
      silenceRanges: [],
    });
    tracks.push({
      id: "music-track",
      kind: "audio",
      name: "Music bed",
      muted: false,
      clips: [
        {
          id: "music-clip",
          assetId: musicId,
          sourceIn: 0,
          start: 0,
          duration: cursor,
          speed: 1,
          volume: 0.12,
        },
      ],
    });
  }
  const [width, height] =
    input.aspectRatio === "9:16"
      ? [1080, 1920]
      : input.aspectRatio === "16:9"
        ? [1920, 1080]
        : [1080, 1080];
  return timelineSchema.parse({
    schemaVersion: 2,
    project: {
      title: input.title,
      aspectRatio: input.aspectRatio,
      fps: 30,
      resolution: { width, height },
      mode: "prompt-to-video",
    },
    assets,
    tracks,
    style: { textColor: "white" },
  });
}

export async function generateVideo(options: GenerateVideoOptions): Promise<{
  timeline: Timeline;
  videoPath: string;
  render: RenderResult;
  plan: ScenePlan[];
  timings: StepTimings;
}> {
  const timings: StepTimings = {};
  const providers = createMediaProviders();
  const plans = await measured("planScript", timings, async () => {
    report(options.onProgress, "planScript", 0);
    const result = await planScript({
      userId: options.userId,
      prompt: options.prompt,
    });
    report(options.onProgress, "planScript", 100);
    return result;
  });
  report(options.onProgress, "fetchVisuals", 0);
  const ranked = await measured("fetchVisuals", timings, () =>
    rankSceneStock(
      providers.stock,
      plans.map((scene) => ({
        userId: options.userId,
        query: scene.visualQuery,
      })),
    ),
  );
  report(options.onProgress, "fetchVisuals", 20);
  let voiceDone = 0;
  let visualsDone = 0;
  let captionsDone = 0;
  const completed = await Promise.all(
    plans.map(async (scene, index) => {
      const sceneId = `scene-${index + 1}-${randomUUID().slice(0, 8)}`;
      const voice = measured("synthesizeVoice", timings, async () => {
        const result = await synthesizeVoice({
          userId: options.userId,
          sceneId,
          scene,
        });
        voiceDone += 1;
        report(
          options.onProgress,
          "synthesizeVoice",
          Math.round((voiceDone / plans.length) * 100),
        );
        return result;
      });
      const visual = measured("fetchVisuals", timings, async () => {
        const candidate = ranked[index]?.[0];
        if (!candidate)
          throw new Error(`no stock footage found for scene ${index + 1}`);
        const result = await fetchVisuals({
          userId: options.userId,
          candidate,
        });
        visualsDone += 1;
        report(
          options.onProgress,
          "fetchVisuals",
          20 + Math.round((visualsDone / plans.length) * 80),
        );
        return result;
      });
      const captions = measured("generateCaptions", timings, async () => {
        const result = await generateCaptions({
          userId: options.userId,
          sceneId,
          speech: voice,
        });
        captionsDone += 1;
        report(
          options.onProgress,
          "generateCaptions",
          Math.round((captionsDone / plans.length) * 100),
        );
        return result;
      });
      const [speech, fetched, transcript] = await Promise.all([
        voice,
        visual,
        captions,
      ]);
      return { scene, speech, visual: fetched, words: transcript.words };
    }),
  );
  let musicUrl: string | undefined;
  try {
    await ensureProceduralMusicLibrary();
    const mood = plans[0]?.mood.toLowerCase() ?? "";
    const category = /calm|peace|soft/.test(mood)
      ? "calm"
      : /upbeat|happy|uplift/.test(mood)
        ? "uplifting"
        : "dramatic";
    const track =
      getMusicLibrary().find((item) => item.mood === category) ??
      getMusicLibrary()[0];
    if (track) musicUrl = track.path;
  } catch {
    /* narration and visuals still produce a valid video without an optional music bed */
  }
  const timeline = await measured("assembleTimeline", timings, async () => {
    report(options.onProgress, "assembleTimeline", 0);
    const result = assembleTimeline({
      title: options.prompt.slice(0, 80) || "Generated video",
      aspectRatio: options.aspectRatio ?? "9:16",
      scenes: completed,
      ...(musicUrl ? { musicUrl } : {}),
    });
    report(options.onProgress, "assembleTimeline", 100);
    return result;
  });
  const outputPath = path.resolve(
    options.outputPath ??
      path.join(env.UPLOAD_DIR, "generated", `${randomUUID()}.mp4`),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  const rendered = await measured("renderTimeline", timings, async () => {
    report(options.onProgress, "renderTimeline", 0);
    const result = await renderTimeline(timeline, {
      outputPath,
      quality: options.quality ?? "final",
    });
    report(options.onProgress, "renderTimeline", 100);
    return result;
  });
  return {
    timeline,
    videoPath: outputPath,
    render: rendered,
    plan: plans,
    timings,
  };
}

const footagePlanSchema = z.object({
  cuts: z
    .array(
      z.object({
        assetId: z.string(),
        sourceIn: z.number().min(0),
        duration: z.number().positive(),
        reason: z.string().optional(),
        caption: z.string().optional(),
      }),
    )
    .min(1),
});

/** Edit already-ingested assets; the resulting schema is identical to prompt-to-video. */
export async function editFromFootage(input: {
  userId: string;
  assets: Asset[];
  instruction: string;
  outputPath?: string;
  aspectRatio?: "9:16" | "16:9" | "1:1";
  onProgress?: ProgressCallback;
}): Promise<{
  timeline: Timeline;
  videoPath: string;
  render: RenderResult;
  timings: StepTimings;
}> {
  const timings: StepTimings = {};
  const plan = await measured("planScript", timings, async () => {
    report(input.onProgress, "planScript", 0);
    const result = await generateJsonForTask({
      task: "edit-agent",
      userId: input.userId,
      prompt: `Choose useful source ranges from these ingested assets for a short video. Only use provided asset IDs and valid ranges.\nInstruction: ${input.instruction}\nAssets: ${JSON.stringify(input.assets.map((asset) => ({ id: asset.id, kind: asset.kind, duration: asset.duration, transcript: asset.transcript?.text, sceneChanges: asset.sceneChanges, frames: asset.frameDescriptions })))}`,
      schema: footagePlanSchema,
    });
    report(input.onProgress, "planScript", 100);
    return result.cuts;
  });
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const videoClips: Timeline["tracks"][number]["clips"] = [];
  const audioClips: Timeline["tracks"][number]["clips"] = [];
  let cursor = 0;
  for (const [index, cut] of plan.entries()) {
    const asset = assetsById.get(cut.assetId);
    if (
      !asset ||
      asset.kind !== "video" ||
      cut.sourceIn + cut.duration > (asset.duration ?? 0) + 0.01
    )
      throw new Error(
        `edit plan returned an invalid footage range for ${cut.assetId}`,
      );
    videoClips.push({
      id: `footage-${index + 1}`,
      assetId: asset.id,
      sourceIn: cut.sourceIn,
      start: cursor,
      duration: cut.duration,
      speed: 1,
      volume: 0,
    });
    if (cut.caption)
      audioClips.push({
        id: `caption-${index + 1}`,
        start: cursor,
        duration: cut.duration,
        text: cut.caption,
        words: [],
      });
    cursor += cut.duration;
  }
  const ratio = input.aspectRatio ?? "9:16";
  const [width, height] =
    ratio === "9:16"
      ? [1080, 1920]
      : ratio === "16:9"
        ? [1920, 1080]
        : [1080, 1080];
  const timeline = await measured("assembleTimeline", timings, async () => {
    report(input.onProgress, "assembleTimeline", 0);
    const value = timelineSchema.parse({
      schemaVersion: 2,
      project: {
        title: input.instruction.slice(0, 80),
        aspectRatio: ratio,
        fps: 30,
        resolution: { width, height },
        mode: "footage-to-edit",
      },
      assets: input.assets,
      tracks: [
        { id: "footage-track", kind: "video", muted: false, clips: videoClips },
        {
          id: "edit-captions",
          kind: "captions",
          muted: false,
          clips: audioClips,
        },
      ],
    });
    report(input.onProgress, "assembleTimeline", 100);
    return value;
  });
  const videoPath = path.resolve(
    input.outputPath ??
      path.join(env.UPLOAD_DIR, "generated", `${randomUUID()}.mp4`),
  );
  await mkdir(path.dirname(videoPath), { recursive: true });
  const render = await measured("renderTimeline", timings, async () => {
    report(input.onProgress, "renderTimeline", 0);
    const result = await renderTimeline(timeline, {
      outputPath: videoPath,
      quality: "final",
    });
    report(input.onProgress, "renderTimeline", 100);
    return result;
  });
  return { timeline, videoPath, render, timings };
}
