import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../src/services/ffmpeg.js";
import {
  exportStillOrRange,
  renderTimeline,
} from "../src/services/timeline-renderer.js";

const fixturePath = path.resolve("fixtures/render-timeline.json");

describe("renderTimeline", () => {
  it("renders the JSON fixture to portrait video with its expected duration", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const outputPath = path.resolve(
      "../../tmp/outputs/timeline-renderer-test.mp4",
    );
    const result = await renderTimeline(fixture, {
      outputPath,
      baseDir: path.dirname(fixturePath),
    });

    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.hasAudio).toBe(true);
    expect(Math.abs(result.duration - 3)).toBeLessThanOrEqual(0.2);
    const stillPath = path.resolve(
      "../../tmp/outputs/timeline-renderer-test.jpg",
    );
    await exportStillOrRange(outputPath, stillPath, { at: 1 });
    expect((await stat(stillPath)).size).toBeGreaterThan(0);
    const rangePath = path.resolve(
      "../../tmp/outputs/timeline-renderer-test-range.mp4",
    );
    await exportStillOrRange(outputPath, rangePath, { at: 1, duration: 0.5 });
    expect(await probeDuration(rangePath)).toBeCloseTo(0.5, 1);
  }, 120_000);

  it("reuses unchanged clip render cache entries", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const outputPath = path.resolve(
      "../../tmp/outputs/timeline-renderer-cache-test.mp4",
    );
    const first = await renderTimeline(fixture, {
      outputPath,
      baseDir: path.dirname(fixturePath),
    });
    const second = await renderTimeline(fixture, {
      outputPath,
      baseDir: path.dirname(fixturePath),
    });
    expect(first.cacheHits + first.cacheMisses).toBe(3);
    expect(second.cacheHits).toBe(3);
    expect(second.cacheMisses).toBe(0);
  }, 120_000);

  it("renders quick previews at 480p-class dimensions", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const result = await renderTimeline(fixture, {
      outputPath: path.resolve(
        "../../tmp/outputs/timeline-renderer-preview.mp4",
      ),
      baseDir: path.dirname(fixturePath),
      quality: "preview",
    });
    expect(result.width).toBe(270);
    expect(result.height).toBe(480);
    expect(Math.abs(result.duration - 3)).toBeLessThanOrEqual(0.2);
  }, 120_000);
});
