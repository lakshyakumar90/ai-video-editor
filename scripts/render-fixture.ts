import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { renderTimeline } from "../apps/api/src/services/timeline-renderer.js";

async function main(): Promise<void> {
  const root = process.cwd();
  const fixturePath = path.join(root, "apps/api/fixtures/render-timeline.json");
  const outputPath = path.join(root, "tmp/outputs/timeline-fixture.mp4");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const result = await renderTimeline(fixture, {
    outputPath,
    baseDir: path.dirname(fixturePath),
  });

  if (result.width !== 1080 || result.height !== 1920) {
    throw new Error(
      `expected 1080x1920, received ${result.width}x${result.height}`,
    );
  }
  if (!result.hasAudio)
    throw new Error("expected rendered video to contain mixed audio");
  if (Math.abs(result.duration - 3) > 0.2) {
    throw new Error(
      `expected duration 3s ±0.2s, received ${result.duration.toFixed(3)}s`,
    );
  }
  console.log(
    `Rendered ${result.width}x${result.height}, ${result.duration.toFixed(3)}s`,
  );
  console.log(
    `Clip cache: ${result.cacheHits} hit(s), ${result.cacheMisses} miss(es)`,
  );
  console.log(result.outputPath);
}

void main();
