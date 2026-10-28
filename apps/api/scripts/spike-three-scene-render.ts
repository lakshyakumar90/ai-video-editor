/**
 * Phase-4 end-to-end render spike. It uses the committed still, clip, and
 * narration fixtures to make three portrait scenes, concatenate them, burn
 * ASS captions, and mix narration over a ducked synthesized music bed.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-three-scene-render.ts
 * Output: ../../tmp/outputs/three-scene-render.mp4
 */
import "dotenv/config";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeDuration,
  runFfmpeg,
  runFfprobe,
} from "../src/services/ffmpeg.js";

const samples = path.resolve("../../tmp/samples");
const image = path.join(samples, "sample.png");
const clip = path.join(samples, "sample-clip.mp4");
const narration = path.join(samples, "sample.mp3");
const outputDir = path.resolve("../../tmp/outputs");
const output = path.join(outputDir, "three-scene-render.mp4");
const workDir = mkdtempSync(path.join(os.tmpdir(), "three-scene-spike-"));
const width = 1080;
const height = 1920;
const fps = 30;

mkdirSync(outputDir, { recursive: true });
const narrationSeconds = await probeDuration(narration);
const sceneSeconds = narrationSeconds / 3;
const sceneFiles: string[] = [];
const scenes = [
  { name: "still", input: image, image: true, seek: undefined },
  { name: "clip-a", input: clip, image: false, seek: "0.5" },
  { name: "clip-b", input: clip, image: false, seek: "2.5" },
];

const cover = [
  `scale=${width}:${height}:force_original_aspect_ratio=increase`,
  `crop=${width}:${height}`,
  "setsar=1",
  `fps=${fps}`,
  "format=yuv420p",
].join(",");

for (const scene of scenes) {
  const segment = path.join(workDir, `${scene.name}.mp4`);
  const args = ["-y"];
  if (scene.seek) args.push("-ss", scene.seek);
  if (scene.image) args.push("-loop", "1", "-t", String(sceneSeconds));
  args.push("-i", scene.input, "-vf", cover, "-an", "-t", String(sceneSeconds));
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-video_track_timescale",
    "90000",
    segment,
  );
  await runFfmpeg(args);
  sceneFiles.push(segment);
}

const concatList = path.join(workDir, "scenes.txt");
writeFileSync(
  concatList,
  sceneFiles
    .map(
      (file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\\\''")}'`,
    )
    .join("\n"),
  "utf8",
);
const joinedVideo = path.join(workDir, "joined.mp4");
await runFfmpeg([
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concatList,
  "-c:v",
  "copy",
  joinedVideo,
]);

const captions = path.join(workDir, "captions.ass");
writeFileSync(captions, makeAss(sceneSeconds), "utf8");
const escapedCaptions = escapeFilterPath(captions);
const musicSeconds = narrationSeconds + 0.2;
const musicSource =
  "aevalsrc=0.035*sin(2*PI*220*t)+0.03*sin(2*PI*277.18*t)+0.025*sin(2*PI*329.63*t)" +
  `:s=48000:d=${musicSeconds}`;
const finalVideoSeconds = await probeDuration(joinedVideo);

await runFfmpeg([
  "-y",
  "-i",
  joinedVideo,
  "-i",
  narration,
  "-f",
  "lavfi",
  "-i",
  musicSource,
  "-vf",
  `ass=filename='${escapedCaptions}',format=yuv420p`,
  "-filter_complex",
  [
    `[1:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=1.8,apad=whole_dur=${finalVideoSeconds},asplit=2[detector][voice]`,
    "[2:a]aformat=sample_rates=48000:channel_layouts=stereo[bed]",
    "[bed][detector]sidechaincompress=threshold=0.015:ratio=8:attack=15:release=300[ducked]",
    "[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]",
  ].join(";"),
  "-map",
  "0:v",
  "-map",
  "[a]",
  "-t",
  String(finalVideoSeconds),
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-movflags",
  "+faststart",
  output,
]);

const resultDuration = await probeDuration(output);
const probe = await runFfprobe([
  "-v",
  "error",
  "-show_entries",
  "stream=codec_type,width,height",
  "-of",
  "json",
  output,
]);
const streams =
  (
    JSON.parse(probe.stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    }
  ).streams ?? [];
const video = streams.find((stream) => stream.codec_type === "video");
const hasAudio = streams.some((stream) => stream.codec_type === "audio");
if (video?.width !== width || video.height !== height) {
  throw new Error(
    `render is ${video?.width}x${video?.height}; expected ${width}x${height}`,
  );
}
if (!hasAudio) throw new Error("render has no mixed audio stream");
if (Math.abs(resultDuration - narrationSeconds) > 0.25) {
  throw new Error(
    `render duration drifted from narration: ${resultDuration.toFixed(3)}s vs ${narrationSeconds.toFixed(3)}s`,
  );
}

console.log(`scenes: ${sceneFiles.length} × ${sceneSeconds.toFixed(3)}s`);
console.log(`video: ${video.width}x${video.height}`);
console.log(`narration: ${narrationSeconds.toFixed(3)}s`);
console.log(`output: ${resultDuration.toFixed(3)}s`);
console.log(output);
console.log(
  "OK: three-scene portrait MP4 rendered with subtitles and ducked music",
);

function escapeFilterPath(file: string): string {
  const posix = file.replace(/\\/g, "/").replace(/ /g, "\\ ");
  return posix.replace(/^([A-Za-z]):/, "$1\\:");
}

function makeAss(seconds: number): string {
  const t1 = seconds;
  const t2 = seconds * 2;
  const t3 = seconds * 3;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,72,72,110,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,${assTime(0)},${assTime(t1)},Default,,0,0,0,,Scene 1
Dialogue: 0,${assTime(t1)},${assTime(t2)},Default,,0,0,0,,Scene 2
Dialogue: 0,${assTime(t2)},${assTime(t3)},Default,,0,0,0,,Scene 3
`;
}

function assTime(seconds: number): string {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}
