/**
 * Phase-4 render spike: concatenate three prepared segments into one MP4.
 *
 * This uses the *demuxer-based* concatenation (`-f concat -safe 0 -i list.txt`),
 * which requires every segment to match on codec/size/timebase — that is
 * exactly the constraint the renderer will satisfy by pre-normalizing every
 * scene segment to 1080x1920 CFR, H.264/AAC (the two previous spikes).
 *
 * Cheaper than re-encoding: video is copied; only the concat demuxer's
 * bookkeeping runs. (If segments differ, ffmpeg re-encode fallback —
 * not exercised here.)
 *
 * Run: pnpm --filter api exec tsx scripts/spike-concat.ts
 */
import "dotenv/config";
import path from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { probeDuration, runFfmpeg, runFfprobe } from "../src/services/ffmpeg.js";

const SAMPLES = path.resolve("../../tmp/samples");
const W = 1080;
const H = 1920;
const SEGMENT_SECONDS = 2;

const outDir = mkdtempSync(path.join(os.tmpdir(), "concat-spike-"));

// --- 1. Prepare three segments with identical parameters -------------------
const segmentFiles: string[] = [];
for (let index = 0; index < 3; index++) {
  // visually distinguishable: steelblue/navy/unify colors per segment
  const colors = ["seagreen", "steelblue", "salmon"];
  const file = path.join(outDir, `seg-${index}.mp4`);
  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", `color=c=${colors[index]}:s=${W}x${H}:r=24:d=${SEGMENT_SECONDS}`,
    "-f", "lavfi",
    "-i", `sine=frequency=${440 + index * 110}:duration=${SEGMENT_SECONDS}`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    file,
  ]);
  segmentFiles.push(file);
}

// --- 2. Build the concat list ----------------------------------------------
const listFile = path.join(outDir, "list.txt");
writeFileSync(
  listFile,
  segmentFiles.map((file) => `file '${file.replace(/\\/g, "/")}'`).join("\n"),
  "utf8",
);

// --- 3. Concat with copy-mode video demuxer --------------------------------
const output = path.join(outDir, "concatenated.mp4");
await runFfmpeg([
  "-y",
  "-f", "concat",
  "-safe", "0",
  "-i", listFile,
  "-c:v", "copy",
  "-c:a", "aac", // audio gets re-boxed for survivor across concat boundaries
  "-b:a", "128k",
  "-movflags", "+faststart",
  output,
]);

// --- 4. Verify --------------------------------------------------------------
const outputSeconds = await probeDuration(output);
const expectedSeconds = SEGMENT_SECONDS * 3;
const drift = Math.abs(outputSeconds - expectedSeconds);
console.log(`segments: ${segmentFiles.length} × ${SEGMENT_SECONDS}s`);
console.log(`output duration: ${outputSeconds.toFixed(3)}s (expected ${expectedSeconds}s, drift ${drift.toFixed(3)}s)`);
console.log(output);

if (drift > 0.25) {
  console.error("FAIL: concatenated duration drifts by more than 0.25s");
  process.exit(1);
}

// 3 visual streams only, 3 audio only
const streams = await countStreams(output);
const okStreams = streams.video === 1 && streams.audio === 1;
console.log(`streams: ${streams.video} video + ${streams.audio} audio ${okStreams ? "OK" : "FAIL"}`);
if (!okStreams) {
  console.error("FAIL: unexpected stream layout after concat");
  process.exit(1);
}

console.log("OK: three segments concatenated");

async function countStreams(
  file: string,
): Promise<{ video: number; audio: number }> {
  const r = await runFfprobe([
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    file,
  ]);
  const parsed = JSON.parse(r.stdout) as {
    streams?: Array<{ codec_type?: string }>;
  };
  return {
    video: parsed.streams?.filter((s) => s.codec_type === "video").length ?? 0,
    audio: parsed.streams?.filter((s) => s.codec_type === "audio").length ?? 0,
  };
}
