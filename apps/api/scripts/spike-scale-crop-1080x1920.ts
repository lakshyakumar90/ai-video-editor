/**
 * Phase-4 render spike: normalize any input (image, video, any geometry)
 * to 1080x1920 portrait — filling the frame by scaling up until it
 * covers, then center-cropping the overflow. Never letterbox, never
 * distort.
 *
 * The single expression that makes it input-independent:
 *   scale = max(1080/w, 1920/h)  (computed by ffmpeg's scale filter)
 * then crop + pad(0) to the exact 1080x1920 box, setsar=1.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-scale-crop-1080x1920.ts
 */
import "dotenv/config";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { runFfprobe, runFfmpeg } from "../src/services/ffmpeg.js";

const W = 1080;
const H = 1920;
const SAMPLES = path.resolve("../../tmp/samples");

const outDir = mkdtempSync(path.join(os.tmpdir(), "crop-spike-"));
const fixtures: Array<{ name: string; file: string }> = [
  { name: "landscape clip 1280x720", file: path.join(SAMPLES, "sample-clip.mp4") },
  { name: "square-ish still", file: path.join(SAMPLES, "sample.png") },
];

// add an extreme-size fixture (very wide 2560x400) to prove the ratio math
const extreme = path.join(outDir, "wide.png");
await runFfmpeg([
  "-y",
  "-f", "lavfi",
  "-i", `color=c=orange:s=2560x400`,
  "-frames:v", "1",
  extreme,
]);
fixtures.push({ name: "ultra-wide still 2560x400", file: extreme });

/** scale-to-cover (integer-safe) + center-crop, works for video and image. */
const coverChain = [
  `scale=${W}:${H}:force_original_aspect_ratio=increase`,
  `crop=${W}:${H}`, // centers by default when x/y omitted
  "setsar=1",
].join(",");

for (const { name, file } of fixtures) {
  const output = path.join(outDir, `${name.split(" ")[0]}-${W}x${H}.mp4`);
  const isImage = file.endsWith(".png");
  const imageArgs = isImage ? ["-loop", "1", "-t", "1"] : []; // give images a 1s timeline

  await runFfmpeg([
    "-y",
    ...imageArgs,
    "-i", file,
    "-vf", coverChain,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    output,
  ]);

  const size = await probeSize(output);
  const ok = size.w === W && size.h === H;
  console.log(`${name}: -> ${size.w}x${size.h} ${ok ? "OK" : "FAIL"}`);
  if (!ok) {
    console.error(`FAIL: ${name} did not come out at ${W}x${H}`);
    process.exit(1);
  }
}

console.log("all inputs normalized to 1080x1920");

async function probeSize(
  file: string,
): Promise<{ w: number; h: number }> {
  const result = await runFfprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    file,
  ]);
  const stream = JSON.parse(result.stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
  };
  return {
    w: stream.streams?.[0]?.width ?? -1,
    h: stream.streams?.[0]?.height ?? -1,
  };
}
