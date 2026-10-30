import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Transcript } from "@repo/shared";
import {
  processMediaFile,
  semanticRankLocal,
  type MediaIngestionDependencies,
} from "../src/services/media-ingestion.js";

const sample = path.resolve("../../tmp/samples/sample-clip.mp4");

describe("media ingestion", () => {
  it("normalizes footage and extracts proxy, audio, waveform, thumbnails, analysis, and searchable ranges", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "media-ingestion-test-"),
    );
    const wordTranscript: Transcript = {
      text: "A sample road trip",
      words: [
        { word: "A", start: 0, end: 0.3 },
        { word: "sample", start: 0.3, end: 0.8 },
        { word: "road", start: 0.8, end: 1.2 },
        { word: "trip", start: 1.2, end: 1.6 },
      ],
    };
    let transcribeCalls = 0;
    let embedCalls = 0;
    const dependencies: MediaIngestionDependencies = {
      transcribe: async () => {
        transcribeCalls++;
        return wordTranscript;
      },
      describeFrame: async () => "A scenic view from a coastal road.",
      embedBatch: async (_userId, texts) => {
        embedCalls++;
        return texts.map(() => [1, 0, 0, 0]);
      },
      suggestHighlights: async () => [
        {
          start: 0.2,
          end: 1.6,
          score: 0.9,
          reason: "Complete short hook",
          text: "A sample road trip",
        },
      ],
    };
    const input = {
      userId: "media-test-user",
      assetId: `asset-test-${Date.now()}`,
      filePath: sample,
      outputDir,
    };
    try {
      const processed = await processMediaFile(input, dependencies);
      expect(processed.probe.kind).toBe("video");
      expect(processed.probe.duration).toBeCloseTo(4, 1);
      expect(processed.normalizedPath).toBeTruthy();
      expect(processed.proxyPath).toBeTruthy();
      expect(processed.waveformPath).toBeTruthy();
      expect(processed.thumbnails.length).toBeGreaterThan(0);
      expect(processed.transcript?.words[0]?.word).toBe("A");
      expect(processed.frameDescriptions[0]?.description).toContain("coastal");
      expect(processed.centerCrop?.width).toBeLessThan(1);
      expect(processed.suggestedClips).toHaveLength(1);
      expect(processed.searchDocuments.length).toBeGreaterThan(0);
      expect(
        await stat(processed.proxyPath!).then((info) => info.size),
      ).toBeGreaterThan(0);
      expect(
        (await readFile(processed.waveformPath!))
          .subarray(0, 8)
          .toString("hex"),
      ).toBe("89504e470d0a1a0a");

      const cached = await processMediaFile(input, dependencies);
      expect(cached.searchDocuments).toHaveLength(
        processed.searchDocuments.length,
      );
      expect(transcribeCalls).toBe(1);
      expect(embedCalls).toBe(1);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("ranks local semantic matches and cannot return another user's documents", () => {
    const documents = [
      {
        documentId: "a",
        userId: "owner",
        assetId: "asset-a",
        kind: "transcript" as const,
        start: 1,
        end: 2,
        snippet: "coastal highway",
        embedding: [1, 0],
      },
      {
        documentId: "b",
        userId: "other",
        assetId: "asset-b",
        kind: "frame" as const,
        start: 0,
        end: 1,
        snippet: "private road",
        embedding: [1, 0],
      },
      {
        documentId: "c",
        userId: "owner",
        assetId: "asset-c",
        kind: "frame" as const,
        start: 3,
        end: 4,
        snippet: "open desert",
        embedding: [0, 1],
      },
    ];
    const results = semanticRankLocal("owner", [1, 0], documents, 10);
    expect(results.map((result) => result.assetId)).toEqual([
      "asset-a",
      "asset-c",
    ]);
    expect(results[0]?.score).toBeCloseTo(1);
  });
});
