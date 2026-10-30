import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CaptionWord, Transcript } from "@repo/shared";
import { env } from "../config/env.js";
import { runFfmpeg, runFfprobe, runProcess } from "./ffmpeg.js";
import { getLlmProvider, llmProviders } from "./llm-registry.js";
import { resolveLlmCredential } from "./llm-credentials.js";
import { resolveTaskRoute, generateJsonForTask } from "./llm-task-router.js";
import {
  createMediaJob,
  getMediaAsset,
  updateMediaAsset,
  updateMediaJob,
  saveSearchDocuments,
  createMediaAsset,
  findMediaAssetByHash,
  getLatestMediaJob,
  listPendingMediaJobs,
  newId,
  type MediaAssetRecord,
  type MediaJobRecord,
  type SearchDocument,
} from "./media-store.js";
import { embedMediaTexts, indexMediaVectors } from "./media-vector-index.js";

export interface MediaProbe {
  kind: "video" | "audio" | "image";
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  formatNames: string[];
}

export interface ProcessedMedia {
  probe: MediaProbe;
  normalizedPath?: string;
  proxyPath?: string;
  audioPath?: string;
  thumbnails: string[];
  waveformPath?: string;
  transcript?: Transcript;
  silenceRanges: Array<{ start: number; end: number }>;
  sceneChanges: number[];
  frameDescriptions: Array<{ start: number; end: number; description: string }>;
  centerCrop?: { x: number; y: number; width: number; height: number };
  suggestedClips: Array<{
    start: number;
    end: number;
    score: number;
    reason: string;
    text: string;
  }>;
  searchDocuments: SearchDocument[];
}

export interface MediaIngestionDependencies {
  transcribe: (wavPath: string) => Promise<Transcript>;
  describeFrame: (
    userId: string,
    bytes: Buffer,
    mediaType: "image/jpeg",
  ) => Promise<string>;
  embedBatch: (userId: string, texts: string[]) => Promise<number[][]>;
  suggestHighlights: (
    userId: string,
    transcript: Transcript,
    duration: number,
  ) => Promise<ProcessedMedia["suggestedClips"]>;
}

export const defaultIngestionDependencies: MediaIngestionDependencies = {
  transcribe: transcribeWithWhisper,
  describeFrame: describeFrameWithLlm,
  embedBatch: embedMediaTexts,
  suggestHighlights: findHighlights,
};

export async function inspectMedia(filePath: string): Promise<MediaProbe> {
  const result = await runFfprobe([
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string; format_name?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.some((stream) => stream.codec_type === "audio");
  if (!video && !audio)
    throw new Error(
      "uploaded file contains no supported audio or video stream",
    );
  const duration = Number(parsed.format?.duration);
  if (video && (!Number.isFinite(duration) || duration <= 0)) {
    throw new Error("ffprobe could not determine a valid media duration");
  }
  return {
    kind: video ? "video" : "audio",
    duration: Number.isFinite(duration) ? duration : 0,
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    hasAudio: audio,
    formatNames: (parsed.format?.format_name ?? "").split(",").filter(Boolean),
  };
}

export async function hashMediaFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export class UnsupportedMediaTypeError extends Error {
  readonly status = 415;
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}
export class InvalidMediaFileError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidMediaFileError";
  }
}

export async function registerMediaUpload(input: {
  userId: string;
  uploadId: string;
  filePath: string;
  filename: string;
  contentType: string;
}): Promise<{
  asset: MediaAssetRecord;
  job?: MediaJobRecord;
  reused: boolean;
}> {
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  const allowed = new Set([
    "application/octet-stream",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
  ]);
  if (!allowed.has(contentType))
    throw new UnsupportedMediaTypeError(
      `unsupported media type: ${contentType || "missing"}`,
    );
  let probe: MediaProbe;
  try {
    probe = await inspectMedia(input.filePath);
  } catch (error) {
    throw new InvalidMediaFileError(
      error instanceof Error
        ? `ffprobe validation failed: ${error.message}`
        : "ffprobe validation failed",
    );
  }
  if (contentType.startsWith("video/") && probe.kind !== "video")
    throw new UnsupportedMediaTypeError(
      "declared video upload contains no video stream",
    );
  if (contentType.startsWith("audio/") && !probe.hasAudio)
    throw new UnsupportedMediaTypeError(
      "declared audio upload contains no audio stream",
    );
  const contentHash = await hashMediaFile(input.filePath);
  const existing = findMediaAssetByHash(input.userId, contentHash);
  if (existing) {
    if (existing.originalPath !== input.filePath)
      await rm(input.filePath, { force: true });
    const previousJob = getLatestMediaJob(input.userId, existing.assetId);
    const job =
      existing.status === "complete" ||
      previousJob?.status === "queued" ||
      previousJob?.status === "processing"
        ? previousJob
        : enqueueMediaIngestion({
            userId: input.userId,
            assetId: existing.assetId,
          });
    return {
      asset: getMediaAsset(input.userId, existing.assetId)!,
      ...(job ? { job } : {}),
      reused: true,
    };
  }
  const asset = createMediaAsset({
    assetId: newId("asset"),
    userId: input.userId,
    uploadId: input.uploadId,
    filename: path.basename(input.filename).slice(0, 255) || "upload",
    contentType,
    contentHash,
    originalPath: input.filePath,
    duration: probe.duration || null,
    status: "queued",
    metadata: { mediaKind: probe.kind, originalDuration: probe.duration },
    error: null,
  });
  const job = enqueueMediaIngestion({
    userId: input.userId,
    assetId: asset.assetId,
  });
  return { asset, job, reused: false };
}

export async function processMediaFile(
  input: {
    userId: string;
    assetId: string;
    filePath: string;
    outputDir: string;
    probe?: MediaProbe;
    onProgress?: (progress: number, stage: string) => void;
  },
  dependencies = defaultIngestionDependencies,
): Promise<ProcessedMedia> {
  const probe = input.probe ?? (await inspectMedia(input.filePath));
  await mkdir(input.outputDir, { recursive: true });
  const cachePath = path.join(input.outputDir, "processed-cache.json");
  try {
    const cached = JSON.parse(
      await readFile(cachePath, "utf8"),
    ) as ProcessedMedia;
    if (
      cached.probe.kind === probe.kind &&
      cached.probe.duration === probe.duration
    ) {
      const reboundDocuments = cached.searchDocuments.map((document) => {
        const suffix = document.documentId.slice(document.assetId.length);
        return {
          ...document,
          documentId: `${input.assetId}${suffix}`,
          userId: input.userId,
          assetId: input.assetId,
        };
      });
      if (reboundDocuments.length) {
        saveSearchDocuments(reboundDocuments);
        await indexMediaVectors(reboundDocuments);
      }
      return { ...cached, searchDocuments: reboundDocuments };
    }
  } catch {
    // A missing or incomplete cache triggers a clean derived-media pass.
  }
  const normalizedPath = path.join(
    input.outputDir,
    probe.kind === "audio" ? "normalized.m4a" : "normalized.mp4",
  );
  const proxyPath =
    probe.kind === "video"
      ? path.join(input.outputDir, "proxy.mp4")
      : undefined;
  const audioPath = probe.hasAudio
    ? path.join(input.outputDir, "audio-16k.wav")
    : undefined;
  const waveformPath = probe.hasAudio
    ? path.join(input.outputDir, "waveform.png")
    : undefined;
  const thumbnails: string[] = [];
  let transcript: Transcript | undefined;
  let silenceRanges: Array<{ start: number; end: number }> = [];
  let sceneChanges: number[] = [];
  const frameDescriptions: ProcessedMedia["frameDescriptions"] = [];

  input.onProgress?.(0.08, "normalizing");
  if (probe.kind === "video") {
    const args = [
      "-y",
      "-i",
      input.filePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      normalizedPath,
    ];
    await runFfmpeg(args);
    input.onProgress?.(0.24, "creating-proxy");
    await runFfmpeg([
      "-y",
      "-i",
      normalizedPath,
      "-vf",
      `scale=-2:${env.MEDIA_PROXY_HEIGHT}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      proxyPath!,
    ]);
  } else {
    await runFfmpeg([
      "-y",
      "-i",
      input.filePath,
      "-vn",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "aac",
      normalizedPath,
    ]);
  }

  if (probe.hasAudio && audioPath && waveformPath) {
    input.onProgress?.(0.32, "extracting-audio");
    await runFfmpeg([
      "-y",
      "-i",
      normalizedPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
    await runFfmpeg([
      "-y",
      "-i",
      normalizedPath,
      "-filter_complex",
      "showwavespic=s=1600x240:colors=0x33aaff",
      "-frames:v",
      "1",
      waveformPath,
    ]);
    silenceRanges = await detectSilence(normalizedPath, probe.duration);
    input.onProgress?.(0.44, "transcribing");
    transcript = await dependencies.transcribe(audioPath);
  }

  if (probe.kind === "video") {
    input.onProgress?.(0.56, "extracting-thumbnails");
    const interval = env.MEDIA_THUMBNAIL_INTERVAL_SECONDS;
    const thumbnailPattern = path.join(input.outputDir, "thumb-%05d.jpg");
    await runFfmpeg([
      "-y",
      "-i",
      normalizedPath,
      "-vf",
      "scale=320:-1",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      path.join(input.outputDir, "thumb-00000.jpg"),
    ]);
    await runFfmpeg([
      "-y",
      "-i",
      normalizedPath,
      "-vf",
      `fps=1/${interval},scale=320:-1`,
      "-q:v",
      "4",
      "-start_number",
      "1",
      thumbnailPattern,
    ]);
    const files = (await readdir(input.outputDir))
      .filter((name) => /^thumb-\d+\.jpg$/.test(name))
      .sort();
    thumbnails.push(...files.map((file) => path.join(input.outputDir, file)));
    sceneChanges = await detectSceneChanges(normalizedPath);
    input.onProgress?.(0.66, "describing-frames");
    const selected = chooseFrameIndexes(
      files.length,
      env.MEDIA_MAX_VISION_FRAMES,
    );
    for (const [order, index] of selected.entries()) {
      const framePath = path.join(input.outputDir, files[index]!);
      const description = await dependencies.describeFrame(
        input.userId,
        await readFile(framePath),
        "image/jpeg",
      );
      const start = index * interval;
      frameDescriptions.push({
        start,
        end: Math.min(probe.duration, start + interval),
        description,
      });
      input.onProgress?.(
        0.66 + 0.1 * ((order + 1) / Math.max(1, selected.length)),
        "describing-frames",
      );
    }
  }

  input.onProgress?.(0.78, "building-search-index");
  const texts = buildSearchTexts(
    input.assetId,
    input.userId,
    transcript,
    frameDescriptions,
    probe.duration,
  );
  const embeddings = await dependencies.embedBatch(
    input.userId,
    texts.map((item) => item.snippet),
  );
  const documents: SearchDocument[] = texts.map((item, index) => ({
    ...item,
    embedding: embeddings[index]!,
  }));
  if (documents.length) {
    saveSearchDocuments(documents);
    await indexMediaVectors(documents);
  }

  let suggestedClips: ProcessedMedia["suggestedClips"] = [];
  if (transcript && transcript.words.length > 0) {
    input.onProgress?.(0.92, "finding-highlights");
    suggestedClips = await dependencies.suggestHighlights(
      input.userId,
      transcript,
      probe.duration,
    );
  }

  const processed = {
    probe,
    normalizedPath,
    ...(proxyPath ? { proxyPath } : {}),
    ...(audioPath ? { audioPath } : {}),
    thumbnails,
    ...(waveformPath ? { waveformPath } : {}),
    ...(transcript ? { transcript } : {}),
    silenceRanges,
    sceneChanges,
    frameDescriptions,
    ...(probe.width && probe.height
      ? { centerCrop: centerCrop(probe.width, probe.height) }
      : {}),
    suggestedClips,
    searchDocuments: documents,
  };
  await writeFile(cachePath, JSON.stringify(processed), "utf8");
  return processed;
}

export function enqueueMediaIngestion(input: {
  userId: string;
  assetId: string;
  dependencies?: MediaIngestionDependencies;
}): MediaJobRecord {
  const asset = getMediaAsset(input.userId, input.assetId);
  if (!asset) throw new Error("media asset not found");
  const job = createMediaJob(input.userId, input.assetId);
  updateMediaAsset(input.userId, input.assetId, {
    status: "queued",
    error: null,
  });
  setImmediate(() => {
    void runMediaIngestion(
      asset,
      job,
      input.dependencies ?? defaultIngestionDependencies,
    );
  });
  return job;
}

export function resumePendingMediaJobs(): void {
  for (const job of listPendingMediaJobs()) {
    const asset = getMediaAsset(job.userId, job.assetId);
    if (!asset) continue;
    setImmediate(() => {
      void runMediaIngestion(asset, job, defaultIngestionDependencies);
    });
  }
}

async function runMediaIngestion(
  asset: MediaAssetRecord,
  job: MediaJobRecord,
  dependencies: MediaIngestionDependencies,
): Promise<void> {
  updateMediaAsset(asset.userId, asset.assetId, { status: "processing" });
  updateMediaJob(asset.userId, job.jobId, {
    status: "processing",
    progress: 0.02,
    stage: "starting",
  });
  try {
    const derived = path.join(env.UPLOAD_DIR, "derived", asset.contentHash);
    const processed = await processMediaFile(
      {
        userId: asset.userId,
        assetId: asset.assetId,
        filePath: asset.originalPath,
        outputDir: derived,
        onProgress: (progress, stage) =>
          updateMediaJob(asset.userId, job.jobId, { progress, stage }),
      },
      dependencies,
    );
    const toStoredPath = (file: string | undefined) =>
      file
        ? path.relative(env.UPLOAD_DIR, file).replaceAll(path.sep, "/")
        : undefined;
    const metadata = {
      ...asset.metadata,
      normalizedPath: toStoredPath(processed.normalizedPath),
      proxyPath: toStoredPath(processed.proxyPath),
      audioPath: toStoredPath(processed.audioPath),
      thumbnails: processed.thumbnails.map((file) => toStoredPath(file)),
      waveformPath: toStoredPath(processed.waveformPath),
      transcript: processed.transcript,
      silenceRanges: processed.silenceRanges,
      sceneChanges: processed.sceneChanges,
      frameDescriptions: processed.frameDescriptions,
      centerCrop: processed.centerCrop,
      suggestedClips: processed.suggestedClips,
      originalDuration: processed.probe.duration,
    };
    await writeFile(
      path.join(derived, "ingestion.json"),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
    updateMediaAsset(asset.userId, asset.assetId, {
      status: "complete",
      duration: processed.probe.duration,
      metadata,
      error: null,
    });
    updateMediaJob(asset.userId, job.jobId, {
      status: "complete",
      progress: 1,
      stage: "complete",
      error: null,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "media ingestion failed";
    updateMediaAsset(asset.userId, asset.assetId, {
      status: "failed",
      error: message,
    });
    updateMediaJob(asset.userId, job.jobId, {
      status: "failed",
      stage: "failed",
      error: message,
    });
  }
}

export function semanticRankLocal(
  userId: string,
  query: number[],
  documents: SearchDocument[],
  limit: number,
): Array<SearchDocument & { score: number }> {
  return documents
    .filter((document) => document.userId === userId)
    .map((document) => ({
      ...document,
      score: cosineSimilarity(query, document.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

async function detectSilence(
  file: string,
  duration: number,
): Promise<Array<{ start: number; end: number }>> {
  const result = await runFfmpeg([
    "-i",
    file,
    "-af",
    "silencedetect=noise=-35dB:d=0.4",
    "-f",
    "null",
    "-",
  ]);
  const markers = [
    ...result.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g),
  ].map((match) => ({ type: match[1]!, time: Number(match[2]) }));
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (const marker of markers) {
    if (marker.type === "start") start = marker.time;
    else if (start !== undefined && marker.time > start) {
      ranges.push({ start, end: marker.time });
      start = undefined;
    }
  }
  if (start !== undefined && duration > start)
    ranges.push({ start, end: duration });
  return ranges;
}

async function detectSceneChanges(file: string): Promise<number[]> {
  const result = await runFfmpeg([
    "-i",
    file,
    "-vf",
    "select='gt(scene,0.35)',showinfo",
    "-vsync",
    "vfr",
    "-f",
    "null",
    "-",
  ]);
  return [
    ...new Set(
      [...result.stderr.matchAll(/pts_time:([\d.]+)/g)].map((match) =>
        Number(match[1]!),
      ),
    ),
  ]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

async function transcribeWithWhisper(wavPath: string): Promise<Transcript> {
  const outputPrefix = path.join(path.dirname(wavPath), "transcription");
  const jsonPath = `${outputPrefix}.json`;
  await rm(jsonPath, { force: true });
  await runProcess(env.WHISPER_CPP_PATH, [
    "-m",
    env.WHISPER_MODEL_PATH,
    "-f",
    wavPath,
    "-ojf",
    "-of",
    outputPrefix,
    "-np",
  ]);
  let parsed: {
    transcription?: Array<{
      text?: string;
      timestamps?: { from?: string; to?: string };
      tokens?: Array<{
        text?: string;
        offsets?: { from?: number; to?: number };
        timestamps?: { from?: string; to?: string };
      }>;
    }>;
  };
  try {
    parsed = JSON.parse(await readFile(jsonPath, "utf8")) as typeof parsed;
  } catch (error) {
    throw new Error(
      `Whisper completed but its word-timestamp JSON was missing or invalid: ${jsonPath}`,
      { cause: error },
    );
  }
  const segments = parsed.transcription ?? [];
  const text = segments
    .map((segment) => segment.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (!text) return { text: "[no speech detected]", words: [] };
  const words: CaptionWord[] = [];
  for (const segment of segments) {
    const segmentText = segment.text?.trim() ?? "";
    const from = parseWhisperTime(segment.timestamps?.from);
    const to = parseWhisperTime(segment.timestamps?.to);
    const tokens = segment.tokens?.filter((token) => token.text?.trim());
    if (tokens?.length) {
      for (const token of tokens) {
        const word = token.text!.trim();
        const tokenStart =
          token.offsets?.from != null
            ? token.offsets.from / 1000
            : parseWhisperTime(token.timestamps?.from);
        const tokenEnd =
          token.offsets?.to != null
            ? token.offsets.to / 1000
            : parseWhisperTime(token.timestamps?.to);
        words.push({
          word,
          start: tokenStart ?? from,
          end: tokenEnd ?? Math.max(tokenStart ?? from, to),
        });
      }
    } else {
      const pieces = segmentText.split(/\s+/).filter(Boolean);
      const span = Math.max(0, to - from);
      pieces.forEach((word, i) =>
        words.push({
          word,
          start: from + (span * i) / pieces.length,
          end: from + (span * (i + 1)) / pieces.length,
        }),
      );
    }
  }
  return { text, words };
}

async function describeFrameWithLlm(
  userId: string,
  bytes: Buffer,
  mediaType: "image/jpeg",
): Promise<string> {
  const route = resolveTaskRoute("vision");
  let lastError: unknown;
  for (const target of route) {
    const descriptor = llmProviders.get(target.providerId)!;
    if (!descriptor.capabilities.vision) continue;
    try {
      const provider = getLlmProvider(target.providerId, target.model);
      const credential =
        descriptor.kind === "local-cli"
          ? undefined
          : resolveLlmCredential({ userId, providerId: target.providerId });
      return await provider.describeImage(
        { data: bytes, mediaType },
        "Describe the visible setting, actions, people and notable objects concisely for footage search.",
        { ...(credential ? { apiKey: credential.apiKey } : {}) },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : "no configured vision-capable provider is available",
  );
}

function buildSearchTexts(
  assetId: string,
  userId: string,
  transcript: Transcript | undefined,
  descriptions: ProcessedMedia["frameDescriptions"],
  duration: number,
): Array<Omit<SearchDocument, "embedding">> {
  const records: Array<Omit<SearchDocument, "embedding">> = [];
  if (transcript?.words.length) {
    const words = transcript.words;
    const maxChunkWords = 48;
    for (let i = 0; i < words.length; i += maxChunkWords) {
      const slice = words.slice(i, i + maxChunkWords);
      records.push({
        documentId: `${assetId}:transcript:${i}`,
        userId,
        assetId,
        kind: "transcript",
        start: slice[0]!.start,
        end: slice.at(-1)!.end,
        snippet: slice.map((word) => word.word).join(" "),
      });
    }
  }
  for (const [i, frame] of descriptions.entries()) {
    records.push({
      documentId: `${assetId}:frame:${i}`,
      userId,
      assetId,
      kind: "frame",
      start: frame.start,
      end: Math.min(duration, frame.end),
      snippet: frame.description,
    });
  }
  return records;
}

async function findHighlights(
  userId: string,
  transcript: Transcript,
  duration: number,
): Promise<ProcessedMedia["suggestedClips"]> {
  const schema = z.object({
    clips: z
      .array(
        z.object({
          start: z.number().min(0),
          end: z.number().positive(),
          score: z.number().min(0).max(1),
          reason: z.string(),
          text: z.string(),
        }),
      )
      .max(8),
  });
  const words = transcript.words
    .map(
      (word) => `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.word}`,
    )
    .join(" ");
  const result = await generateJsonForTask({
    task: "edit-agent",
    userId,
    prompt: `Choose up to 8 self-contained short clips from this transcript. Rank hooks, completeness and length. Only use the supplied time ranges; end must be after start and within ${duration.toFixed(2)} seconds. Return an empty list if no useful moments.\n${words}`,
    schema,
  });
  return result.clips.filter(
    (clip) => clip.end <= duration && clip.end > clip.start,
  );
}

function chooseFrameIndexes(count: number, max: number): number[] {
  if (count <= 0 || max <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  return Array.from({ length: max }, (_, index) =>
    Math.round((index * (count - 1)) / (max - 1 || 1)),
  );
}

function centerCrop(
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const target = 9 / 16;
  const aspect = width / height;
  if (aspect > target) {
    const cropWidth = target / aspect;
    return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
  }
  const cropHeight = aspect / target;
  return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
}

function parseWhisperTime(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":").map(Number);
  return parts.length === 3
    ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
    : Number(value) || 0;
}
