import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";

const mode = process.argv[2] ?? "all";
const userId =
  process.env.MEDIA_TEST_USER_ID ?? `media-provider-test-${randomUUID()}`;
const { authReady } = await import("../src/services/auth.js");
await authReady;
const providers = await import("../src/services/media-providers.js");
const { tts, stock, transcription, storage } = providers.createMediaProviders();

if (mode === "all" || mode === "storage") {
  const key = `smoke/${randomUUID()}.txt`;
  const sample = new TextEncoder().encode("storage round-trip");
  await storage.put(key, sample);
  const actual = new TextDecoder().decode(await storage.get(key));
  if (actual !== "storage round-trip")
    throw new Error("storage round-trip failed");
  await storage.delete(key);
  console.log("storage provider: put/get/getUrl/delete passed");
}

if (mode === "all" || mode === "tts") {
  const result = await tts.synthesize({
    userId,
    sceneId: `smoke-${randomUUID()}`,
    text: "This is a provider smoke test.",
    storage,
  });
  if (!(result.duration > 0)) throw new Error("TTS duration was not measured");
  console.log(`TTS provider: ${result.key} (${result.duration.toFixed(2)}s)`);
  await storage.delete(result.key);
}

if (mode === "all" || mode === "transcription") {
  const audioPath = path.resolve(process.cwd(), "../../tmp/samples/sample.mp3");
  const result = await transcription.transcribe({ userId, audioPath });
  if (!result.text || !Array.isArray(result.words))
    throw new Error("transcription provider returned invalid output");
  console.log(`transcription provider: ${result.words.length} word timings`);
}

if (mode === "all" || mode === "stock") {
  const candidates = await providers.searchAndRankStock(stock, {
    userId,
    query: "city walk",
  });
  if (!candidates.length)
    throw new Error("stock provider returned no candidates");
  const clip = await stock.download({
    userId,
    candidate: candidates[0]!,
    storage,
  });
  console.log(
    `stock provider: ${candidates.length} candidate(s), cached ${clip.key}`,
  );
  if (process.env.STOCK_PROVIDER !== "pexels") await storage.delete(clip.key);
}

if (mode === "all" || mode === "music") {
  await providers.ensureProceduralMusicLibrary();
  console.log(
    `music library: ${providers.getMusicLibrary().length} CC0 tracks`,
  );
}

if (
  !["all", "storage", "tts", "transcription", "stock", "music"].includes(mode)
) {
  throw new Error(
    "usage: test-media-providers.ts [all|tts|stock|transcription|storage|music]",
  );
}
