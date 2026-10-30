import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptionWord } from "@repo/shared";
import {
  FakeStockProvider,
  FakeTranscriptionProvider,
  FakeTtsProvider,
  LocalDiskStorageProvider,
  broadenStockQuery,
  rankSceneStock,
  searchAndRankStock,
  transcriptWordsToAss,
  type StockCandidate,
  type StockProvider,
} from "../src/services/media-providers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function storage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-storage-"));
  roots.push(root);
  return new LocalDiskStorageProvider(root);
}

describe("media provider contracts", () => {
  it("stores, reads, addresses, and deletes files through local storage", async () => {
    const store = await storage();
    await store.put("assets/test.txt", new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await store.get("assets/test.txt"))).toBe(
      "hello",
    );
    expect(await store.getUrl("assets/test.txt")).toMatch(/^file:/);
    await store.delete("assets/test.txt");
    await expect(store.get("assets/test.txt")).rejects.toThrow();
    expect(() => store.get("../escape")).toThrow(/safe relative/);
  });

  it("returns a sample MP3 and measures its actual encoded duration", async () => {
    const store = await storage();
    const result = await new FakeTtsProvider(store).synthesize({
      userId: "user-a",
      sceneId: "scene-one",
      text: "ignored by fake",
    });
    expect(result.duration).toBeGreaterThan(0);
    expect(
      Buffer.from(await store.get(result.key))
        .subarray(0, 3)
        .toString(),
    ).toBe("ID3");
  });

  it("spreads fake word timings evenly over the measured audio", async () => {
    const transcript = await new FakeTranscriptionProvider().transcribe({
      userId: "user-a",
      audioPath: path.resolve("../../tmp/samples/sample.mp3"),
    });
    expect(transcript.words).toHaveLength(5);
    expect(transcript.words[0]!.start).toBe(0);
    expect(transcript.words.at(-1)!.end).toBeGreaterThan(
      transcript.words[0]!.end,
    );
  });

  it("writes 3-4 word ASS events with word timestamps", () => {
    const words: CaptionWord[] = Array.from({ length: 7 }, (_, index) => ({
      word: `w${index + 1}`,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    }));
    const ass = transcriptWordsToAss(words, 4);
    expect(ass).toContain("0:00:00.00,0:00:01.90");
    expect(ass).toContain("w1 w2 w3 w4");
    expect(ass).toContain("w5 w6 w7");
    expect(() => transcriptWordsToAss(words, 2)).toThrow(/3 or 4/);
  });

  it("provides a local stock clip and caches the downloaded bytes", async () => {
    const store = await storage();
    const provider = new FakeStockProvider(store);
    const candidate = (
      await provider.search({ userId: "user-a", query: "mountains" })
    )[0]!;
    const downloaded = await provider.download({ userId: "user-a", candidate });
    expect(downloaded.key).toBe("stock/fixture-sample-clip.mp4");
    expect((await store.get(downloaded.key)).byteLength).toBeGreaterThan(1000);
  });

  it("retries a zero-result query broadly and never selects the same clip twice", async () => {
    expect(broadenStockQuery("very specific mountain trail")).toBe(
      "very specific",
    );
    const candidates: StockCandidate[] = ["one", "two"].map((id) => ({
      id,
      url: id,
      description: "mountain trail",
      duration: 5,
      width: 1080,
      height: 1920,
    }));
    let calls = 0;
    const broadFlags: boolean[] = [];
    const fake: StockProvider = {
      async search(input) {
        calls++;
        broadFlags.push(Boolean(input.broaden));
        return input.broaden ? candidates : [];
      },
      async download() {
        return { key: "", url: "" };
      },
    };
    const ranked = await searchAndRankStock(fake, {
      userId: "u",
      query: "very specific mountain trail",
    });
    expect(calls).toBe(2);
    expect(broadFlags).toEqual([false, true]);
    expect(ranked.length).toBe(2);
    const perScene = await rankSceneStock(fake, [
      { userId: "u", query: "mountain trail" },
      { userId: "u", query: "mountain trail" },
    ]);
    expect(perScene.map((items) => items[0]?.id)).toEqual(["one", "two"]);
  });

  it("serves procedural music tracks with mood and CC0 license tags", async () => {
    const { ensureProceduralMusicLibrary, getMusicLibrary } =
      await import("../src/services/media-providers.js");
    await ensureProceduralMusicLibrary();
    const tracks = getMusicLibrary();
    expect(tracks.map((track) => track.mood)).toEqual([
      "calm",
      "uplifting",
      "dramatic",
    ]);
    expect(tracks.every((track) => track.license === "CC0-1.0")).toBe(true);
    for (const track of tracks)
      expect((await readFile(track.path)).byteLength).toBeGreaterThan(1000);
  });
});
