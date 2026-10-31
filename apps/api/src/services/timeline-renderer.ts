import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  timelineSchema,
  type Asset,
  type CaptionClip,
  type MediaClip,
  type Timeline,
} from "@repo/shared";
import { runFfmpeg, runFfprobe } from "./ffmpeg.js";

export interface RenderOptions {
  outputPath: string;
  baseDir?: string;
  cacheDir?: string;
  quality?: "preview" | "final";
  start?: number;
  duration?: number;
}

function appendVideoLayers(
  graph: string[],
  timeline: Timeline,
  clips: CachedVideo[],
  start: number,
  duration: number,
  height: number,
): string {
  let current = "v0";
  clips.forEach((item, i) => {
    const localStart = item.clip.start - start;
    const localEnd = localStart + item.clip.duration;
    const shifted = `shift${i}`;
    const next = `v${i + 1}`;
    const skipped = Math.max(0, start - item.clip.start);
    graph.push(
      `[${i + 1}:v]trim=start=${skipped}:duration=${Math.max(0.001, item.clip.duration - skipped)},setpts=PTS-STARTPTS+${localStart}/TB[${shifted}]`,
    );
    graph.push(
      `[${current}][${shifted}]overlay=0:0:eof_action=pass:repeatlast=0:enable='between(t,${Math.max(0, localStart)},${Math.min(duration, localEnd)})'[${next}]`,
    );
    current = next;
  });

  const captions = timeline.tracks
    .filter((track) => track.kind === "captions" && !track.muted)
    .flatMap((track) =>
      track.clips.filter((clip): clip is CaptionClip => !isMediaClip(clip)),
    );
  for (const [i, caption] of captions.entries()) {
    const from = Math.max(0, caption.start - start);
    const to = Math.min(duration, caption.start + caption.duration - start);
    if (to <= from) continue;
    const next = `caption${i}`;
    graph.push(
      `[${current}]drawtext=text='${escapeDrawtext(caption.text)}':fontcolor=${escapeColor(timeline.style?.textColor ?? "white")}:fontsize=${Math.round(height * 0.035)}:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-${Math.round(height * 0.07)}:enable='between(t,${from},${to})'[${next}]`,
    );
    current = next;
  }
  return current;
}

function appendAudioMix(
  graph: string[],
  inputs: AudioInput[],
  videoInputCount: number,
  start: number,
  duration: number,
): void {
  for (const item of inputs) {
    const clip = item.clip;
    const skipped = Math.max(0, start - clip.start);
    const sourceIn = clip.sourceIn + skipped * clip.speed;
    const sourceSeconds = Math.max(0.001, clip.duration - skipped) * clip.speed;
    const filters = [
      `atrim=start=${sourceIn}:duration=${sourceSeconds}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (clip.speed !== 1) filters.push(...atempoFilters(1 / clip.speed));
    const delay = Math.round(Math.max(0, clip.start - start) * 1000);
    filters.push(
      `volume=${clip.volume}`,
      `adelay=${delay}|${delay}`,
      `apad=whole_dur=${duration}`,
      `atrim=duration=${duration}`,
    );
    graph.push(
      `[${videoInputCount + 1 + item.index}:a]${filters.join(",")}[a${item.index}]`,
    );
  }

  const music = inputs
    .map((item, i) => (/music|bed/i.test(item.trackName) ? i : -1))
    .filter((i) => i >= 0);
  const voice = inputs
    .map((item, i) => (/music|bed/i.test(item.trackName) ? -1 : i))
    .filter((i) => i >= 0);
  const group = (ids: number[], label: string) => {
    if (ids.length === 1) graph.push(`[a${ids[0]}]anull[${label}]`);
    else
      graph.push(
        `${ids.map((id) => `[a${id}]`).join("")}amix=inputs=${ids.length}:duration=longest:normalize=0[${label}]`,
      );
  };
  group(music.length ? music : inputs.map((_, i) => i), "bed");
  if (music.length && voice.length) {
    group(voice, "voice");
    graph.push("[voice]asplit=2[detector][voiceout]");
    graph.push(
      "[bed][detector]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=250[ducked]",
    );
    graph.push(
      `[ducked][voiceout]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95,atrim=duration=${duration}[aout]`,
    );
  } else {
    graph.push(`[bed]alimiter=limit=0.95,atrim=duration=${duration}[aout]`);
  }
}

export interface RenderResult {
  outputPath: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  cacheHits: number;
  cacheMisses: number;
}

type CachedVideo = { clip: MediaClip; asset: Asset; file: string };
type AudioInput = {
  trackName: string;
  clip: MediaClip;
  asset: Asset;
  index: number;
  source: string;
};

const SIZES = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:3": [1440, 1080],
} as const;

/** Render a validated timeline without mutating it. Temporary render files are always removed. */
export async function renderTimeline(
  input: unknown,
  options: RenderOptions,
): Promise<RenderResult> {
  const timeline = timelineSchema.parse(input);
  const [fullWidth, fullHeight] = SIZES[timeline.project.aspectRatio];
  const scale =
    options.quality === "preview" ? Math.min(1, 480 / fullHeight) : 1;
  const width = Math.max(2, Math.round((fullWidth * scale) / 2) * 2);
  const height = Math.max(2, Math.round((fullHeight * scale) / 2) * 2);
  const fps = timeline.project.fps;
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const cacheDir = path.resolve(
    options.cacheDir ?? path.join(process.cwd(), ".cache", "timeline-render"),
  );
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "timeline-render-"));
  let cacheHits = 0;
  let cacheMisses = 0;

  try {
    await mkdir(path.dirname(path.resolve(options.outputPath)), {
      recursive: true,
    });
    await mkdir(cacheDir, { recursive: true });
    const assets = new Map(timeline.assets.map((asset) => [asset.id, asset]));
    const videoClips = timeline.tracks
      .filter(
        (track) =>
          (track.kind === "video" || track.kind === "overlay") && !track.muted,
      )
      .flatMap((track) =>
        track.clips
          .filter(isMediaClip)
          .map((clip) => ({ track, clip, asset: assets.get(clip.assetId)! })),
      );
    const audioClips = timeline.tracks
      .filter((track) => track.kind === "audio" && !track.muted)
      .flatMap((track) =>
        track.clips
          .filter(isMediaClip)
          .map((clip) => ({ track, clip, asset: assets.get(clip.assetId)! })),
      );
    const end = Math.max(
      0,
      ...timeline.tracks.flatMap((track) =>
        track.clips.map((clip) => clip.start + clip.duration),
      ),
    );
    const start = options.start ?? 0;
    const duration = Math.min(options.duration ?? end - start, end - start);
    if (duration <= 0) throw new Error("timeline has no renderable duration");

    const cachedVideos: CachedVideo[] = [];
    const videoAudioClips: Array<{
      trackName: string;
      clip: MediaClip;
      asset: Asset;
    }> = [];
    for (const item of videoClips) {
      const source = resolveAsset(item.asset, baseDir, options.quality);
      if (item.asset.kind === "video") {
        const audioProbe = await runFfprobe([
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "json",
          source,
        ]);
        const streams = (
          JSON.parse(audioProbe.stdout) as {
            streams?: Array<{ codec_type?: string }>;
          }
        ).streams;
        if (streams?.some((stream) => stream.codec_type === "audio")) {
          videoAudioClips.push({
            trackName: "Clip audio",
            clip: item.clip,
            asset: item.asset,
          });
        }
      }
      const key = await hashClip(
        source,
        item.clip,
        width,
        height,
        fps,
        options.quality,
      );
      const cached = path.join(cacheDir, `${key}.mp4`);
      try {
        await stat(cached);
        cacheHits++;
      } catch {
        cacheMisses++;
        const tempClip = path.join(tempDir, `${key}.mp4`);
        await renderClip(
          source,
          item.asset,
          item.clip,
          tempClip,
          width,
          height,
          fps,
          options.quality,
        );
        const staged = `${cached}.${process.pid}.tmp`;
        await copyFile(tempClip, staged);
        await rename(staged, cached).catch(
          async (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
            await rm(staged, { force: true });
          },
        );
      }
      const local = path.join(tempDir, `input-${cachedVideos.length}.mp4`);
      await copyFile(cached, local);
      cachedVideos.push({ ...item, file: local });
    }

    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${escapeColor(timeline.style?.backgroundColor ?? "black")}:s=${width}x${height}:r=${fps}:d=${duration}`,
    ];
    for (const item of cachedVideos) args.push("-i", item.file);
    const audioInputs: AudioInput[] = [];
    const allAudioClips = [
      ...videoAudioClips,
      ...audioClips.map((item) => ({
        trackName: item.track.name ?? item.track.id,
        clip: item.clip,
        asset: item.asset,
      })),
    ];
    for (const item of allAudioClips) {
      const source = resolveAsset(item.asset, baseDir, options.quality);
      audioInputs.push({
        trackName: item.trackName,
        clip: item.clip,
        asset: item.asset,
        index: audioInputs.length,
        source,
      });
      args.push("-i", source);
    }

    const graph: string[] = ["[0:v]setpts=PTS-STARTPTS[v0]"];
    const layeredVideo = appendVideoLayers(
      graph,
      timeline,
      cachedVideos,
      start,
      duration,
      height,
    );
    graph.push(
      `[${layeredVideo}]trim=duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[vout]`,
    );
    if (audioInputs.length) {
      appendAudioMix(graph, audioInputs, cachedVideos.length, start, duration);
    }

    args.push("-filter_complex", graph.join(";"), "-map", "[vout]");
    if (audioInputs.length) args.push("-map", "[aout]");
    else args.push("-an");
    args.push(
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      options.quality === "preview" ? "ultrafast" : "fast",
      "-crf",
      options.quality === "preview" ? "30" : "20",
      "-r",
      String(fps),
      "-pix_fmt",
      "yuv420p",
    );
    if (audioInputs.length) args.push("-c:a", "aac", "-b:a", "128k");
    args.push("-movflags", "+faststart", path.resolve(options.outputPath));
    await runFfmpeg(args);
    const probe = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path.resolve(options.outputPath),
    ]);
    const metadata = JSON.parse(probe.stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    return {
      outputPath: path.resolve(options.outputPath),
      duration: Number(metadata.format?.duration),
      width:
        metadata.streams?.find((stream) => stream.codec_type === "video")
          ?.width ?? width,
      height:
        metadata.streams?.find((stream) => stream.codec_type === "video")
          ?.height ?? height,
      hasAudio:
        metadata.streams?.some((stream) => stream.codec_type === "audio") ??
        false,
      cacheHits,
      cacheMisses,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Render one source clip as a normalized, cacheable video segment. */
export async function renderClip(
  source: string,
  asset: Asset,
  clip: MediaClip,
  output: string,
  width: number,
  height: number,
  fps: number,
  quality: "preview" | "final" = "final",
): Promise<void> {
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    `fps=${fps}`,
    `setpts=(PTS-STARTPTS)/${clip.speed}`,
    `tpad=stop_mode=clone:stop_duration=${clip.duration}`,
    `trim=duration=${clip.duration}`,
    "format=yuv420p",
  ];
  const args = ["-y"];
  if (asset.kind === "image")
    args.push("-loop", "1", "-t", String(clip.duration));
  else args.push("-ss", String(clip.sourceIn));
  args.push(
    "-i",
    source,
    "-vf",
    filters.join(","),
    "-an",
    "-t",
    String(clip.duration),
    "-c:v",
    "libx264",
    "-preset",
    quality === "preview" ? "ultrafast" : "fast",
    "-crf",
    quality === "preview" ? "30" : "20",
    "-r",
    String(fps),
    "-pix_fmt",
    "yuv420p",
    output,
  );
  await runFfmpeg(args);
}

/** Concatenate compatible segments losslessly via FFmpeg's concat demuxer. */
export async function concatScenes(
  segments: string[],
  output: string,
  workDir: string,
): Promise<void> {
  if (!segments.length)
    throw new Error("concatScenes requires at least one segment");
  const list = path.join(workDir, "concat.txt");
  await writeFile(
    list,
    segments
      .map(
        (file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
      )
      .join("\n"),
    "utf8",
  );
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    output,
  ]);
}

/** Extract a JPEG still or a short MP4 range from a completed render. */
export async function exportStillOrRange(
  input: string,
  output: string,
  options: { at?: number; duration?: number } = {},
): Promise<void> {
  if (options.duration && options.duration > 0) {
    await runFfmpeg([
      "-y",
      "-ss",
      String(options.at ?? 0),
      "-i",
      input,
      "-t",
      String(options.duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "24",
      "-c:a",
      "aac",
      output,
    ]);
  } else {
    await runFfmpeg([
      "-y",
      "-ss",
      String(options.at ?? 0),
      "-i",
      input,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      output,
    ]);
  }
}

function isMediaClip(clip: unknown): clip is MediaClip {
  return Boolean(clip && typeof clip === "object" && "assetId" in clip);
}
function resolveAsset(
  asset: Asset,
  baseDir: string,
  quality?: "preview" | "final",
): string {
  const selected =
    quality === "preview" ? (asset.proxyPath ?? asset.src) : asset.src;
  if (selected.startsWith("file:")) return fileURLToPath(selected);
  return path.isAbsolute(selected) ? selected : path.resolve(baseDir, selected);
}
async function hashClip(
  source: string,
  clip: MediaClip,
  width: number,
  height: number,
  fps: number,
  quality?: string,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  hash.update(
    JSON.stringify({
      sourceIn: clip.sourceIn,
      duration: clip.duration,
      speed: clip.speed,
      width,
      height,
      fps,
      quality,
    }),
  );
  return hash.digest("hex");
}
function atempoFilters(factor: number): string[] {
  const filters: string[] = [];
  while (factor > 2) {
    filters.push("atempo=2");
    factor /= 2;
  }
  while (factor < 0.5) {
    filters.push("atempo=0.5");
    factor /= 0.5;
  }
  filters.push(`atempo=${factor}`);
  return filters;
}
function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\n/g, "\\n");
}
function escapeColor(value: string): string {
  return value.replace(/[^#a-zA-Z0-9&@]/g, "");
}
