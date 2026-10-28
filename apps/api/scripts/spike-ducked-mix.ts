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
import { probeDuration, runFfmpeg, runFfprobe } from "../src/services/ffmpeg.js";

const samples = path.resolve("../../tmp/samples");
const narration = path.join(samples, "sample.mp3");
const narrationSeconds = await probeDuration(narration);
const musicSeconds = narrationSeconds + 4;
const outDir = mkdtempSync(path.join(os.tmpdir(), "duck-spike-"));
const output = path.join(outDir, "ducked-mix.m4a");
const musicSource =
  "aevalsrc=0.035*sin(2*PI*220*t)+0.03*sin(2*PI*277.18*t)+0.025*sin(2*PI*329.63*t)" +
  `:s=48000:d=${musicSeconds}`;

await runFfmpeg([
  "-y",
  "-f", "lavfi", "-i", musicSource,
  "-i", narration,
  "-filter_complex",
  [
    "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[music]",
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.8,apad=whole_dur=${musicSeconds},asplit=2[detector][voice]`,
    "[music][detector]sidechaincompress=threshold=0.015:ratio=8:attack=15:release=300[ducked]",
    "[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]",
  ].join(";"),
  "-map", "[aout]",
  "-c:a", "aac", "-b:a", "128k",
  output,
]);

const outputSeconds = await probeDuration(output);
const streams = await runFfprobe([
  "-v", "error",
  "-show_entries", "stream=codec_type",
  "-of", "json",
  output,
]);
const parsed = JSON.parse(streams.stdout) as { streams?: Array<{ codec_type?: string }> };
if (!(parsed.streams ?? []).some((stream) => stream.codec_type === "audio")) {
  throw new Error("ducked mix has no audio stream");
}
if (Math.abs(outputSeconds - musicSeconds) > 0.25) {
  throw new Error(`ducked mix duration drifted: expected ${musicSeconds.toFixed(3)}s, got ${outputSeconds.toFixed(3)}s`);
}
console.log(`narration: ${narrationSeconds.toFixed(3)}s (followed by music-only tail)`);
console.log(`music bed: ${musicSeconds.toFixed(3)}s`);
console.log(`ducked mix: ${outputSeconds.toFixed(3)}s`);
console.log(output);
console.log("OK: narration sidechains the music bed and both tracks are mixed");

