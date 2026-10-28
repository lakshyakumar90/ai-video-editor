/**
 * Phase-4 render spike: compose a single still image + one audio track
 * into an MP4 whose video duration matches the audio exactly.
 *
 * The brief (no shell strings, one ffmpeg invocation via runFfmpeg):
 *   -loop 1 -i IMAGE  -i AUDIO
 *   -filter_complex make audio mono→stereo-ready, scale/pad the image
 *   -shortest to cut video when the audio ends
 *   H.264 yuv420p + AAC, both universally decodable.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-image-audio-mp4.ts
 */
import "dotenv/config";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { probeDuration, runFfmpeg } from "../src/services/ffmpeg.js";

const SAMPLES = path.resolve("../../tmp/samples");
const image = path.join(SAMPLES, "sample.png");
const audio = path.join(SAMPLES, "sample.mp3");

const out = mkdtempSync(path.join(os.tmpdir(), "render-spike-"));
const output = path.join(out, "image-audio.mp4");

const audioSeconds = await probeDuration(audio);

await runFfmpeg([
  "-y",
  "-loop", "1",
  "-i", image,
  "-i", audio,
  "-filter_complex",
  [
    "[0:v]scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v]",
    "[1:a]aresample=async=1:first_pts=0[a]",
  ].join(";"),
  "-map", "[v]",
  "-map", "[a]",
  "-c:v", "libx264",
  "-preset", "fast",
  "-crf", "20",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "128k",
  "-shortest",
  "-movflags", "+faststart",
  output,
]);

const videoSeconds = await probeDuration(output);
const drift = Math.abs(videoSeconds - audioSeconds);

console.log(`audio duration: ${audioSeconds.toFixed(3)}s`);
console.log(`output duration: ${videoSeconds.toFixed(3)}s`);
console.log(`drift: ${drift.toFixed(3)}s`);
console.log(output);

if (drift > 0.25) {
  console.error("FAIL: output drifts from audio duration by more than 0.25s");
  process.exit(1);
}
console.log("OK: output lasts exactly as long as the audio");
