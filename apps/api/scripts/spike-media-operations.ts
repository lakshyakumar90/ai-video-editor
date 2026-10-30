/**
 * Timed media-operation spikes against a deterministic 5-minute fixture.
 * The fixture loops the checked-in sample clip and adds a synthetic tone with
 * regular silent gaps. All generated media stays under ignored tmp/outputs.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-media-operations.ts
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runFfmpeg, runFfprobe } from "../src/services/ffmpeg.js";

const sampleClip = path.resolve("../../tmp/samples/sample-clip.mp4");
const outputDir = path.resolve("../../tmp/outputs/ffmpeg-spikes");
const source = path.join(outputDir, "benchmark-5min-vfr.mp4");
mkdirSync(outputDir, { recursive: true });

const timings: Array<{ name: string; seconds: number; detail: string }> = [];

async function timed<T>(
  name: string,
  operation: () => Promise<T>,
  detail: (value: T) => string | Promise<string> = () => "",
): Promise<T> {
  const start = performance.now();
  const value = await operation();
  const seconds = (performance.now() - start) / 1000;
  const extra = await detail(value);
  timings.push({ name, seconds, detail: extra });
  console.log(`${name}: ${seconds.toFixed(3)}s${extra ? ` | ${extra}` : ""}`);
  return value;
}

async function mediaInfo(file: string): Promise<{
  duration: number;
  size: number;
  width: number;
  height: number;
  avgFrameRate: string;
  sampleRate: string;
}> {
  const result = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,width,height,avg_frame_rate,sample_rate",
    "-of",
    "json",
    file,
  ]);
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      sample_rate?: string;
    }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(parsed.format?.duration ?? 0),
    size: Number(parsed.format?.size ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    avgFrameRate: video?.avg_frame_rate ?? "n/a",
    sampleRate: audio?.sample_rate ?? "n/a",
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

// Generate five minutes from the committed clip. Drop a patterned frame
// cadence to make a variable-frame-rate source; the audio has 5s silence at
// each minute edge so silence detection and synchronized removal are visible.
await timed(
  "create 5-minute VFR benchmark source",
  async () => {
    const audio =
      "aevalsrc=0.1*sin(2*PI*440*t)*gte(mod(t\\,60)\\,5)*lt(mod(t\\,60)\\,55):s=48000:d=300";
    await runFfmpeg([
      "-y",
      "-stream_loop",
      "-1",
      "-i",
      sampleClip,
      "-f",
      "lavfi",
      "-i",
      audio,
      "-vf",
      "select='not(eq(mod(n,4),1))'",
      "-fps_mode",
      "vfr",
      "-t",
      "300",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "27",
      "-g",
      "60",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      source,
    ]);
    return mediaInfo(source);
  },
  (info) =>
    `${info.duration.toFixed(2)}s, ${info.width}x${info.height}, ${info.avgFrameRate}, ${info.sampleRate} Hz, ${mb(info.size)}`,
);

// Source trim: accurate seek decodes from the preceding keyframe; copy seek
// is quick and lands on a keyframe, so its actual in-point may move.
const trimStart = 71.237;
const trimDuration = 20;
const accurateTrim = path.join(outputDir, "trim-frame-accurate.mp4");
const keyframeTrim = path.join(outputDir, "trim-keyframe-copy.mp4");
await timed(
  "frame-accurate trim (re-encode)",
  () =>
    runFfmpeg([
      "-y",
      "-ss",
      String(trimStart),
      "-i",
      source,
      "-t",
      String(trimDuration),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "24",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      accurateTrim,
    ]),
  async () => {
    const info = await mediaInfo(accurateTrim);
    return `${info.duration.toFixed(3)}s, ${mb(info.size)}, requested in=${trimStart}s`;
  },
);
await timed(
  "fast keyframe trim (stream copy)",
  () =>
    runFfmpeg([
      "-y",
      "-ss",
      String(trimStart),
      "-i",
      source,
      "-t",
      String(trimDuration),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      keyframeTrim,
    ]),
  async () => {
    const info = await mediaInfo(keyframeTrim);
    return `${info.duration.toFixed(3)}s, ${mb(info.size)}, requested in=${trimStart}s`;
  },
);

// Normalize cadence and audio clock/sample rate for a predictable edit/render.
const normalized = path.join(outputDir, "cfr-30fps-audio-48khz.mp4");
await timed(
  "VFR to CFR 30fps + audio resample 48kHz",
  () =>
    runFfmpeg([
      "-y",
      "-i",
      source,
      "-vf",
      "fps=30,setpts=N/(30*TB)",
      "-af",
      "aresample=48000:async=1:first_pts=0",
      "-fps_mode",
      "cfr",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "27",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      normalized,
    ]),
  async () => {
    const info = await mediaInfo(normalized);
    return `${info.duration.toFixed(2)}s, ${info.avgFrameRate}, ${info.sampleRate} Hz, ${mb(info.size)}`;
  },
);

// A 480px-high proxy is useful for browsing and scrubbing; compare its size
// and multi-point random seek latency with the original benchmark source.
const proxy = path.join(outputDir, "proxy-480p.mp4");
await timed(
  "480p proxy encode",
  () =>
    runFfmpeg([
      "-y",
      "-i",
      source,
      "-vf",
      "scale=-2:480,fps=30",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      proxy,
    ]),
  async () => {
    const original = await mediaInfo(source);
    const reduced = await mediaInfo(proxy);
    return `${mb(original.size)} -> ${mb(reduced.size)} (${(100 * (1 - reduced.size / original.size)).toFixed(1)}% smaller)`;
  },
);

async function seekSample(file: string, label: string): Promise<number> {
  const starts = [17.3, 61.1, 123.7, 211.4, 287.6];
  const start = performance.now();
  for (let index = 0; index < starts.length; index++) {
    await runFfmpeg([
      "-y",
      "-ss",
      String(starts[index]),
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(`${label} five random seeks: ${seconds.toFixed(3)}s`);
  return seconds;
}
const sourceSeek = await seekSample(source, "original");
const proxySeek = await seekSample(proxy, "480p proxy");
timings.push({
  name: "five random seeks (original)",
  seconds: sourceSeek,
  detail: "5 timestamps",
});
timings.push({
  name: "five random seeks (480p proxy)",
  seconds: proxySeek,
  detail: "5 timestamps",
});

// Extract the soundtrack, 1 thumbnail per 30s, and a full-file waveform.
const audioFile = path.join(outputDir, "extracted-audio-48khz.wav");
await timed("extract audio to 48kHz PCM", () =>
  runFfmpeg([
    "-y",
    "-i",
    source,
    "-vn",
    "-af",
    "aresample=48000",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    audioFile,
  ]),
);
const thumbnails = path.join(outputDir, "thumbnail-%03d.jpg");
await timed(
  "thumbnails every 30 seconds",
  () =>
    runFfmpeg([
      "-y",
      "-i",
      source,
      "-vf",
      "fps=1/30,scale=320:-2",
      "-q:v",
      "4",
      thumbnails,
    ]),
  () => "10 JPEGs at 30s intervals",
);
const waveform = path.join(outputDir, "waveform.png");
await timed("waveform image", () =>
  runFfmpeg([
    "-y",
    "-i",
    source,
    "-filter_complex",
    "showwavespic=s=1600x260:colors=0x2a9d8f",
    "-frames:v",
    "1",
    waveform,
  ]),
);

// Parse silencedetect's ranges, invert them to speech/audio intervals, then
// trim and concatenate video and audio with identical boundaries.
const silenceLog = await timed(
  "silencedetect parse",
  () =>
    runFfmpeg([
      "-hide_banner",
      "-i",
      source,
      "-vn",
      "-af",
      "silencedetect=noise=-45dB:d=2",
      "-f",
      "null",
      "-",
    ]),
  (result) =>
    `${(result.stderr.match(/silence_start:/g) ?? []).length} silence starts`,
);
const silences = parseSilences(silenceLog.stderr, 300);
const speechRanges = invertRanges(silences, 300);
if (speechRanges.length === 0)
  throw new Error("silencedetect found no audio to keep");
const removeSilence = path.join(outputDir, "silence-removed-synced.mp4");
const filters: string[] = [];
speechRanges.forEach(([start, end], index) => {
  filters.push(
    `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
  );
  filters.push(
    `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`,
  );
});
filters.push(
  `${speechRanges.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${speechRanges.length}:v=1:a=1[v][a]`,
);
await timed(
  "remove silence with synchronized audio/video trims",
  () =>
    runFfmpeg([
      "-y",
      "-i",
      source,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "27",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      removeSilence,
    ]),
  async () => {
    const info = await mediaInfo(removeSilence);
    return `${silences.length} silences removed, ${info.duration.toFixed(2)}s kept of 300s, audio ${info.sampleRate} Hz`;
  },
);

// Crop a 16:9 source to portrait and expose a normalized movable horizontal
// window position: 0 = left, 0.5 = centered, 1 = right.
for (const [name, position] of [
  ["left", 0.2],
  ["center", 0.5],
  ["right", 0.8],
] as const) {
  const cropped = path.join(outputDir, `portrait-crop-${name}.mp4`);
  await timed(
    `movable 9:16 crop (${name}, x=${position})`,
    () =>
      runFfmpeg([
        "-y",
        "-ss",
        "10",
        "-i",
        source,
        "-t",
        "8",
        "-vf",
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x='(iw-ow)*${position}':y='(ih-oh)/2',setsar=1`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "27",
        "-pix_fmt",
        "yuv420p",
        cropped,
      ]),
    async () => {
      const info = await mediaInfo(cropped);
      return `${info.width}x${info.height}, ${info.duration.toFixed(2)}s`;
    },
  );
}

// Playback speed 1.25× shortens video and applies the matching audio tempo;
// loudnorm targets -16 LUFS, -1.5 dBTP, and 11 LU LRA in the same render.
const speedNormalized = path.join(outputDir, "speed-1.25x-loudnorm.mp4");
await timed(
  "1.25x speed + matching audio tempo + loudnorm",
  () =>
    runFfmpeg([
      "-y",
      "-i",
      source,
      "-filter_complex",
      "[0:v]setpts=(PTS-STARTPTS)/1.25[v];[0:a]atempo=1.25,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000:async=1:first_pts=0[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "27",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      speedNormalized,
    ]),
  async () => {
    const info = await mediaInfo(speedNormalized);
    return `${info.duration.toFixed(2)}s (expected ~240s), audio ${info.sampleRate} Hz`;
  },
);

const timingFile = path.join(outputDir, "spike-timings.json");
writeFileSync(timingFile, `${JSON.stringify(timings, null, 2)}\n`, "utf8");
console.log(`\nTiming data: ${timingFile}`);
console.log(`All outputs: ${outputDir}`);

function parseSilences(
  stderr: string,
  duration: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*([\d.]+)/.exec(line);
    if (start) open = Number(start[1]);
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && open !== undefined) {
      ranges.push([open, Number(end[1])]);
      open = undefined;
    }
  }
  if (open !== undefined) ranges.push([open, duration]);
  return ranges;
}

function invertRanges(
  excluded: Array<[number, number]>,
  duration: number,
): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of excluded) {
    if (start - cursor > 0.05) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (duration - cursor > 0.05) kept.push([cursor, duration]);
  return kept;
}
