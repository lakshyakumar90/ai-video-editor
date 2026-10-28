/**
 * Phase-4 render spike: burn ASS subtitles over a clip with libass.
 *
 * Verifies the burn really happened by decoding the same frame from the
 * source and the burned output and comparing them with ffmpeg's PSNR —
 * burned text must move the PSNR below "essentially identical"; if the
 * source and output frames were pixel-identical, we can't know whether
 * the subs were actually rendered or the filter silently no-oped.
 *
 * The Windows pitfall this encodes:
 *   filter arguments cannot take `C:/...` un-escaped — the drive colon
 *   must be escaped (C\:/...) and backslashes avoided entirely.
 *
 * Run: pnpm --filter api exec tsx scripts/spike-burn-ass.ts
 */
import "dotenv/config";
import path from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { probeDuration, runFfmpeg } from "../src/services/ffmpeg.js";

const SAMPLES = path.resolve("../../tmp/samples");
const clip = path.join(SAMPLES, "sample-clip.mp4");

const outDir = mkdtempSync(path.join(os.tmpdir(), "ass-spike-"));

// --- 1. Sample ASS file: three lines over the 4s clip ----------------------
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.40,0:00:01.30,Default,,0,0,0,,Phase 4: render spike
Dialogue: 0,0:00:01.40,0:00:02.80,Default,,0,0,0,,ASS subtitles burn over video
Dialogue: 0,0:00:02.90,0:00:03.80,Default,,0,0,0,,Drift check follows
`;
const subtitleFile = path.join(outDir, "captions.ass");
writeFileSync(subtitleFile, ass, "utf8");

// --- 2. Burn with the ass filter (escaped path) -----------------------------
const burned = path.join(outDir, "burned.mp4");
await runFfmpeg([
  "-y",
  "-i", clip,
  // NB: the ass filter's first positional option is `original_size` (WxH),
  // NOT the file — the filename must be given as the named option.
  "-vf", `ass=filename='${escapeForFilter(subtitleFile)}'`,
  burned,
]);

// --- 3. Verify duration preserved ------------------------------------------
const burnedSeconds = await probeDuration(burned);
console.log(`output duration: ${burnedSeconds.toFixed(3)}s (clip was 4.0s)`);

// --- 4. Verify the text is actually burned in (frame pair PSNR) -------------
const baseFrame = path.join(outDir, "base.png");
const burnedFrame = path.join(outDir, "burned.png");
await runFfmpeg(["-y", "-ss", "1", "-i", clip, "-frames:v", "1", baseFrame]);
await runFfmpeg(["-y", "-ss", "1", "-i", burned, "-frames:v", "1", burnedFrame]);

const compare = await runFfmpeg([
  "-i", baseFrame,
  "-i", burnedFrame,
  "-filter_complex", "psnr=stats_file=-",
  "-f", "null", os.devNull,
]);
const psnr = parsePsnr(compare.stderr);
if (psnr == null) throw new Error("could not parse PSNR from comparison output");

console.log(`burned frame PSNR vs source frame: ${psnr.toFixed(2)} dB`);
// identical frames score ~100 dB; burned text should land well below that
if (psnr > 40) {
  console.error("FAIL: burned output looks identical to source — subtitle render did not happen");
  process.exit(1);
}
console.log("OK: subtitles burned over clip");

/**
 * Escapes a filesystem path for use inside a single -vf filter argument:
 * forward slashes only, and the drive colon is escaped because ffmpeg
 * splits filter args on it.
 */
function escapeForFilter(file: string): string {
  const posix = file.replace(/\\/g, "/").replace(/ /g, "\\ ");
  return posix.replace(/^([A-Za-z]):/, "$1\\:");
}

/** Reads the overall average PSNR value out of ffmpeg's stderr chatter. */
function parsePsnr(stderr: string): number | null {
  const match = /average:(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) : null;
}
