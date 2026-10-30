import "dotenv/config";
import { generateScenePlansResponseSchema } from "@repo/shared";
import { randomUUID } from "node:crypto";
import { generateJsonForTask } from "../src/services/llm-task-router.js";
import {
  createMediaProviders,
  rankSceneStock,
  transcriptWordsToAss,
} from "../src/services/media-providers.js";

const userId = process.argv[2];
const prompt = process.argv.slice(3).join(" ").trim();
if (!userId || !prompt) {
  console.error(
    'usage: pnpm --filter api exec tsx scripts/generate-scene-media.ts <userId> "<prompt>"',
  );
  process.exit(1);
}

const plan = await generateJsonForTask({
  task: "script-planning",
  userId,
  prompt,
  schema: generateScenePlansResponseSchema,
});
const providers = createMediaProviders();
const stockCandidates = await rankSceneStock(
  providers.stock,
  plan.scenes.map((scene) => ({ userId, query: scene.visualQuery })),
);

const output = [];
for (const [index, scene] of plan.scenes.entries()) {
  const sceneId = `scene-${index + 1}-${randomUUID().slice(0, 8)}`;
  const speech = await providers.tts.synthesize({
    userId,
    sceneId,
    text: scene.narration,
    storage: providers.storage,
  });
  const candidates = stockCandidates[index] ?? [];
  if (!candidates.length)
    throw new Error(`no stock footage was found for scene ${index + 1}`);
  const video = await providers.stock.download({
    userId,
    candidate: candidates[0]!,
    storage: providers.storage,
  });
  const transcript = await providers.transcription.transcribe({
    userId,
    audioPath: providers.fileUrlToPath(speech.url),
  });
  const captionsKey = `captions/${sceneId}.ass`;
  await providers.storage.put(
    captionsKey,
    new TextEncoder().encode(transcriptWordsToAss(transcript.words)),
  );
  output.push({
    sceneId,
    narration: scene.narration,
    mood: scene.mood,
    speech: { key: speech.key, duration: speech.duration },
    stock: {
      key: video.key,
      candidateId: candidates[0]!.id,
      alternatives: candidates.length - 1,
    },
    captionsKey,
  });
}
console.log(JSON.stringify({ scenes: output }, null, 2));
