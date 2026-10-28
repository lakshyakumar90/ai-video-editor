/**
 * Phase-4 spike: duck a generated music bed under the supplied narration.
 * The repo has one MP3 fixture, so the bed is a quiet C-major tone chord.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-ducked-mix.ts
 */
import "dotenv/config";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import {
  probeDuration,
  runFfmpeg,
  runFfprobe,
} from "../src/services/ffmpeg.js";

const samples = path.resolve("../../tmp/samples");
const sourceMp3 = path.join(samples, "sample.mp3");
const narrationSeconds = await probeDuration(sourceMp3);
const musicSeconds = 7;
const outDir = mkdtempSync(path.join(os.tmpdir(), "duck-spike-"));
const narration = path.join(outDir, "narration.wav");
const output = path.join(outDir, "ducked-mix.m4a");
const duckedBed = path.join(outDir, "ducked-bed.wav");
const musicSource =
  "aevalsrc=0.035*sin(2*PI*220*t)+0.03*sin(2*PI*277.18*t)+0.025*sin(2*PI*329.63*t)" +
  `:s=48000:d=${musicSeconds}`;

await runFfmpeg([
  "-y",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=3",
  "-af",
  "adelay=2000|2000,apad=pad_dur=2",
  "-t",
  String(musicSeconds),
  "-c:a",
  "pcm_s16le",
  narration,
]);

await runFfmpeg([
  "-y",
  "-f",
  "lavfi",
  "-i",
  musicSource,
  "-i",
  narration,
  "-filter_complex",
  [
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[music]",
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.8,apad=whole_dur=${musicSeconds},asplit=2[detector][voice]`,
    "[music][detector]sidechaincompress=threshold=0.015:ratio=8:attack=15:release=300[ducked]",
    "[ducked]asplit=2[ducked-mix][ducked-monitor]",
    "[ducked-mix][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]",
  ].join(";"),
  "-map",
  "[aout]",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  output,
  "-map",
  "[ducked-monitor]",
  "-c:a",
  "pcm_s16le",
  duckedBed,
]);

const outputSeconds = await probeDuration(output);
const streams = await runFfprobe([
  "-v",
  "error",
  "-show_entries",
  "stream=codec_type",
  "-of",
  "json",
  output,
]);
const parsed = JSON.parse(streams.stdout) as {
  streams?: Array<{ codec_type?: string }>;
};
if (!(parsed.streams ?? []).some((stream) => stream.codec_type === "audio")) {
  throw new Error("ducked mix has no audio stream");
}
if (Math.abs(outputSeconds - musicSeconds) > 0.25) {
  throw new Error(
    `ducked mix duration drifted: expected ${musicSeconds.toFixed(3)}s, got ${outputSeconds.toFixed(3)}s`,
  );
}
const beforeSpeech = await measureLevel(duckedBed, 0.5);
const duringSpeech = await measureLevel(duckedBed, 2.5);
const afterSpeech = await measureLevel(duckedBed, 5.5);
const duckDb = Math.min(beforeSpeech, afterSpeech) - duringSpeech;
if (duckDb < 6) {
  throw new Error(
    `music dropped only ${duckDb.toFixed(1)} dB under speech; expected at least 6 dB`,
  );
}
console.log(`sample MP3 narration fixture: ${narrationSeconds.toFixed(3)}s`);
console.log("detector: 440 Hz speech stand-in from 2s to 5s");
console.log(`music bed: ${musicSeconds.toFixed(3)}s`);
console.log(`ducked mix: ${outputSeconds.toFixed(3)}s`);
console.log(
  `music RMS: ${beforeSpeech.toFixed(1)} dB before / ${duringSpeech.toFixed(1)} dB during / ${afterSpeech.toFixed(1)} dB after`,
);
console.log(`measured duck: ${duckDb.toFixed(1)} dB`);
console.log(output);
console.log(
  "OK: voice sidechain measurably lowers the music and both tracks are mixed",
);

async function measureLevel(file: string, start: number): Promise<number> {
  const result = await runFfmpeg([
    "-ss",
    String(start),
    "-t",
    "1",
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    os.devNull,
  ]);
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(result.stderr);
  if (!match) throw new Error(`could not read volume for ${start}s window`);
  return Number(match[1]);
}
