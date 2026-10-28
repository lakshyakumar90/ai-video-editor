/**
 * Phase-4 render spike: take a video clip and an audio track, and make
 * the clip's video length exactly match the audio — by trimming the clip
 * when it is too long, or looping it seamlessly when it is too short.
 *
 * - clip longer / equal → single pass: `-i clip -i audio -shortest`
 * - clip shorter        → two passes: first loop the clip stream to the
 *   needed length (`stream_loop`), then mux with the audio and cut.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-clip-fits-audio.ts
 */
import "dotenv/config";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { probeDuration, runFfmpeg } from "../src/services/ffmpeg.js";

const SAMPLES = path.resolve("../../tmp/samples");
const clip = path.join(SAMPLES, "sample-clip.mp4"); // 4.0s
const audio = path.join(SAMPLES, "sample.mp3"); // ~3.03s

const outDir = mkdtempSync(path.join(os.tmpdir(), "clip-fit-spike-"));
const audioSeconds = await probeDuration(audio);

/** Video stays; audio replaced, output ends exactly with the audio. */
const COMMON_ARGS = [
  "-map", "0:v",
  "-map", "1:a",
  "-c:v", "copy", // video already H.264/yuv420p — no re-code needed
  "-c:a", "aac",
  "-b:a", "128k",
  "-shortest",
  "-movflags", "+faststart",
];

// ---- Case 1: clip longer than audio → trim with -shortest -----------------
if (audioSeconds <= (await probeDuration(clip))) {
  const output = path.join(outDir, "trim.mp4");
  await runFfmpeg([
    "-y",
    "-i", clip,
    "-i", audio,
    ...COMMON_ARGS,
    output,
  ]);

  const resultSeconds = await probeDuration(output);
  report("trim", audioSeconds, resultSeconds);
}

// ---- Case 2: clip shorter than audio → loop then cut ----------------------
{
  const longAudio = path.join(outDir, "long-audio.m4a");
  // make an audio track longer than the clip to force the loop case:
  // tone slowed to half speed → ~6.06s
  await runFfmpeg([
    "-y",
    "-i", audio,
    "-filter:a", "atempo=0.5",
    "-c:a", "aac",
    longAudio,
  ]);
  const longAudioSeconds = await probeDuration(longAudio);

  // -stream_loop -1 loops the video stream indefinitely and -shortest
  // cuts at the audio's end point. The video must be re-encoded here:
  // with `-c:v copy`, loop truncation overruns whole GOPs and restarts
  // timestamps past the cut (verified that failure mode), while a
  // re-encode lets -shortest cut precisely at the boundary.
  const output = path.join(outDir, "loop-fit.mp4");
  await runFfmpeg([
    "-y",
    "-stream_loop", "-1", // infinitely loop the incoming video stream
    "-i", clip,
    "-i", longAudio,
    "-map", "0:v",
    "-map", "1:a",
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

  const resultSeconds = await probeDuration(output);
  report("loop-fit", longAudioSeconds, resultSeconds);
}

function report(
  label: string,
  audioSeconds: number,
  resultSeconds: number,
): void {
  const drift = Math.abs(resultSeconds - audioSeconds);
  console.log(`${label}: audio ${audioSeconds.toFixed(3)}s / output ${resultSeconds.toFixed(3)}s / drift ${drift.toFixed(3)}s`);
  if (drift > 0.25) {
    console.error(`FAIL: drift over 0.25s`);
    process.exit(1);
  }
  console.log(`${label}: OK`);
}
