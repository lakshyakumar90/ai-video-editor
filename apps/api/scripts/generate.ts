import "dotenv/config";
import path from "node:path";
import { generateVideo } from "../src/services/generate-video.js";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const prompt = args
  .filter(
    (arg, index) =>
      arg !== "--preview" && arg !== "--out" && index !== outIndex + 1,
  )
  .join(" ")
  .trim();
if (!prompt) {
  console.error(
    'usage: pnpm --filter api exec tsx scripts/generate.ts "<prompt>" [--out path.mp4]',
  );
  process.exit(1);
}
const outputPath =
  outIndex >= 0 ? path.resolve(args[outIndex + 1]!) : undefined;
const quality = process.argv.includes("--preview") ? "preview" : "final";
const result = await generateVideo({
  userId: process.env.GENERATE_USER_ID ?? "local-generator",
  prompt,
  quality,
  ...(outputPath ? { outputPath } : {}),
  onProgress: (stage, percent) =>
    console.log(JSON.stringify({ stage, percent })),
});
console.log(
  JSON.stringify(
    {
      videoPath: result.videoPath,
      duration: result.render.duration,
      width: result.render.width,
      height: result.render.height,
      timings: result.timings,
      scenes: result.plan.length,
    },
    null,
    2,
  ),
);
