import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import OpenAI from "openai";
import { env } from "../config/env.js";
import { resolveLlmCredential } from "./llm-credentials.js";
import { probeDuration, runFfmpeg, runProcess } from "./ffmpeg.js";
import type { CaptionWord, Transcript } from "@repo/shared";

export interface TtsProvider {
  synthesize(input: {
    userId: string;
    sceneId: string;
    text: string;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string; duration: number }>;
}

export interface StockCandidate {
  id: string;
  url: string;
  description: string;
  duration: number;
  width: number;
  height: number;
  score?: number;
}

export interface StockProvider {
  search(input: {
    userId: string;
    query: string;
    broaden?: boolean;
  }): Promise<StockCandidate[]>;
  download(input: {
    userId: string;
    candidate: StockCandidate;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string }>;
}

export interface TranscriptionProvider {
  transcribe(input: { userId: string; audioPath: string }): Promise<Transcript>;
}

export interface StorageProvider {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorageProvider implements StorageProvider {
  constructor(
    private readonly root = path.resolve(env.UPLOAD_DIR, "library"),
  ) {}

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  get(key: string): Promise<Uint8Array> {
    return readFile(this.resolve(key));
  }

  async getUrl(key: string): Promise<string> {
    return pathToFileURL(this.resolve(key)).href;
  }

  async delete(key: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    if (!key || key.includes("\\") || key.split("/").includes(".."))
      throw new Error("storage key must be a safe relative path");
    const target = path.resolve(this.root, key);
    if (!target.startsWith(`${this.root}${path.sep}`))
      throw new Error("storage key escaped the storage root");
    return target;
  }
}

export class FakeTtsProvider implements TtsProvider {
  constructor(
    private readonly storage: StorageProvider = new LocalDiskStorageProvider(),
  ) {}

  async synthesize(input: {
    userId: string;
    sceneId: string;
    text: string;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string; duration: number }> {
    const storage = input.storage ?? this.storage;
    const key = `tts/${safePart(input.userId)}/${safePart(input.sceneId)}.mp3`;
    const fixture = path.resolve(process.cwd(), "../../tmp/samples/sample.mp3");
    await storage.put(key, await readFile(fixture));
    const url = await storage.getUrl(key);
    const duration = await probeDuration(fileURLToPath(url));
    return { key, url, duration };
  }
}

export class OpenAiTtsProvider implements TtsProvider {
  constructor(
    private readonly storage: StorageProvider = new LocalDiskStorageProvider(),
  ) {}

  async synthesize(input: {
    userId: string;
    sceneId: string;
    text: string;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string; duration: number }> {
    const credential = resolveLlmCredential({
      userId: input.userId,
      providerId: "openai-tts",
    });
    const client = new OpenAI({ apiKey: credential.apiKey });
    const speech = await client.audio.speech.create({
      model: env.TTS_MODEL,
      voice: env.TTS_VOICE as "alloy",
      input: input.text,
      response_format: "mp3",
    });
    const key = `tts/${safePart(input.userId)}/${safePart(input.sceneId)}.mp3`;
    const storage = input.storage ?? this.storage;
    await storage.put(key, new Uint8Array(await speech.arrayBuffer()));
    const url = await storage.getUrl(key);
    // Never substitute an estimate; use the encoded file's measured duration.
    const duration = await probeDuration(fileURLToPath(url));
    return { key, url, duration };
  }
}

export class FakeStockProvider implements StockProvider {
  constructor(
    private readonly storage: StorageProvider = new LocalDiskStorageProvider(),
  ) {}

  async search(input: {
    userId: string;
    query: string;
    broaden?: boolean;
  }): Promise<StockCandidate[]> {
    return [
      {
        id: "fixture-sample-clip",
        url: "fixture://sample-clip",
        description: input.query,
        duration: 4,
        width: 1920,
        height: 1080,
        score: 1,
      },
    ];
  }

  async download(input: {
    userId: string;
    candidate: StockCandidate;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string }> {
    const key = `stock/${safePart(input.candidate.id)}.mp4`;
    const storage = input.storage ?? this.storage;
    if (await storageContains(storage, key)) {
      return { key, url: await storage.getUrl(key) };
    }
    const fixture = path.resolve(
      process.cwd(),
      "../../tmp/samples/sample-clip.mp4",
    );
    await storage.put(key, await readFile(fixture));
    return { key, url: await storage.getUrl(key) };
  }
}

export class PexelsStockProvider implements StockProvider {
  constructor(
    private readonly storage: StorageProvider = new LocalDiskStorageProvider(),
  ) {}

  async search(input: {
    userId: string;
    query: string;
    broaden?: boolean;
  }): Promise<StockCandidate[]> {
    const credential = resolveLlmCredential({
      userId: input.userId,
      providerId: "pexels",
    });
    const query = input.broaden ? broadenStockQuery(input.query) : input.query;
    const params = new URLSearchParams({
      query,
      orientation: "portrait",
      size: "large",
      per_page: "30",
    });
    const response = await fetch(
      `https://api.pexels.com/videos/search?${params}`,
      { headers: { Authorization: credential.apiKey } },
    );
    if (!response.ok)
      throw new Error(`Pexels video search failed (${response.status})`);
    const body = (await response.json()) as {
      videos?: Array<{
        id: number;
        duration: number;
        width: number;
        height: number;
        url: string;
        user?: { name?: string };
        video_files?: Array<{
          link: string;
          width?: number;
          height?: number;
          quality?: string;
        }>;
      }>;
    };
    return (body.videos ?? [])
      .flatMap((video, index) => {
        const file = (video.video_files ?? [])
          .filter((item) => item.width && item.width >= 1080)
          .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
        if (!file) return [];
        const description = `${query}; ${video.user?.name ?? "Pexels footage"}`;
        return [
          {
            id: String(video.id),
            url: file.link,
            description,
            duration: video.duration,
            width: file.width ?? video.width,
            height: file.height ?? video.height,
            score: Math.max(0, 1 - index / Math.max(1, body.videos!.length)),
          },
        ];
      })
      .sort((a, b) => scoreCandidate(query, b) - scoreCandidate(query, a))
      .slice(0, 10);
  }

  async download(input: {
    userId: string;
    candidate: StockCandidate;
    storage?: StorageProvider;
  }): Promise<{ key: string; url: string }> {
    const key = `stock/${safePart(input.candidate.id)}.mp4`;
    const storage = input.storage ?? this.storage;
    if (await storageContains(storage, key)) {
      return { key, url: await storage.getUrl(key) };
    }
    const response = await fetch(input.candidate.url);
    if (!response.ok)
      throw new Error(`Pexels clip download failed (${response.status})`);
    await storage.put(key, new Uint8Array(await response.arrayBuffer()));
    return { key, url: await storage.getUrl(key) };
  }
}

export class FakeTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input: {
    userId: string;
    audioPath: string;
  }): Promise<Transcript> {
    const duration = await probeDuration(input.audioPath);
    const text = "Sample words for this scene";
    const tokens = text.split(" ");
    const words: CaptionWord[] = tokens.map((word, index) => ({
      word,
      start: (duration * index) / tokens.length,
      end: (duration * (index + 1)) / tokens.length,
    }));
    return { text, words };
  }
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input: { audioPath: string }): Promise<Transcript> {
    const prefix = path.join(
      path.dirname(input.audioPath),
      `whisper-${Date.now()}`,
    );
    const jsonPath = `${prefix}.json`;
    await runProcess(env.WHISPER_CPP_PATH, [
      "-m",
      env.WHISPER_MODEL_PATH,
      "-f",
      input.audioPath,
      "-ojf",
      "-of",
      prefix,
      "-np",
    ]);
    const body = JSON.parse(await readFile(jsonPath, "utf8")) as {
      transcription?: Array<{
        text?: string;
        timestamps?: { from?: string; to?: string };
        tokens?: Array<{
          text?: string;
          offsets?: { from?: number; to?: number };
          timestamps?: { from?: string; to?: string };
        }>;
      }>;
    };
    const segments = body.transcription ?? [];
    const words: CaptionWord[] = [];
    for (const segment of segments) {
      const from = parseWhisperTime(segment.timestamps?.from);
      const to = parseWhisperTime(segment.timestamps?.to);
      for (const token of segment.tokens ?? []) {
        if (!token.text?.trim()) continue;
        const start =
          token.offsets?.from != null
            ? token.offsets.from / 1000
            : (parseWhisperTime(token.timestamps?.from) ?? from);
        const end =
          token.offsets?.to != null
            ? token.offsets.to / 1000
            : (parseWhisperTime(token.timestamps?.to) ?? to);
        if (start == null || end == null)
          throw new Error("Whisper did not return timestamps for a word");
        words.push({
          word: token.text.trim(),
          start,
          end: Math.max(start, end),
        });
      }
    }
    const text = segments
      .map((item) => item.text?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    return { text: text || "[no speech detected]", words };
  }
}

export function createMediaProviders() {
  const storage: StorageProvider = new LocalDiskStorageProvider();
  const tts: TtsProvider =
    env.TTS_PROVIDER === "fake"
      ? new FakeTtsProvider(storage)
      : new OpenAiTtsProvider(storage);
  const stock: StockProvider =
    env.STOCK_PROVIDER === "fake"
      ? new FakeStockProvider(storage)
      : new PexelsStockProvider(storage);
  const transcription: TranscriptionProvider =
    env.TRANSCRIPTION_PROVIDER === "fake"
      ? new FakeTranscriptionProvider()
      : new WhisperTranscriptionProvider();
  return { tts, stock, transcription, storage, fileUrlToPath };
}

export async function searchAndRankStock(
  provider: StockProvider,
  input: { userId: string; query: string; usedIds?: Set<string> },
): Promise<StockCandidate[]> {
  let candidates = await provider.search({
    userId: input.userId,
    query: input.query,
  });
  if (!candidates.length)
    candidates = await provider.search({
      userId: input.userId,
      query: input.query,
      broaden: true,
    });
  return candidates
    .filter((candidate) => !input.usedIds?.has(candidate.id))
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(input.query, candidate),
    }))
    .sort((a, b) => b.score! - a.score!)
    .slice(0, 10);
}

export function rankSceneStock(
  provider: StockProvider,
  scenes: Array<{ userId: string; query: string }>,
): Promise<StockCandidate[][]> {
  const used = new Set<string>();
  return scenes.reduce<Promise<StockCandidate[][]>>(async (previous, scene) => {
    const results = await previous;
    const candidates = await searchAndRankStock(provider, {
      ...scene,
      usedIds: used,
    });
    const selected = candidates[0];
    if (selected) used.add(selected.id);
    results.push(candidates);
    return results;
  }, Promise.resolve([]));
}

export function transcriptWordsToAss(
  words: CaptionWord[],
  wordsPerLine = 4,
): string {
  if (!Number.isInteger(wordsPerLine) || wordsPerLine < 3 || wordsPerLine > 4)
    throw new Error("ASS caption lines must contain 3 or 4 words");
  const events = words.reduce<string[]>((all, _word, index) => {
    if (index % wordsPerLine === 0) {
      const group = words.slice(index, index + wordsPerLine);
      if (group.length)
        all.push(
          `Dialogue: 0,${assTime(group[0]!.start)},${assTime(group.at(-1)!.end)},Default,,0,0,0,,${group.map((item) => escapeAss(item.word)).join(" ")}`,
        );
    }
    return all;
  }, []);
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Arial,52,&H00FFFFFF,&H00000000,1,0,1,3,1,2,60,60,120,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events,
  ].join("\n");
}

export function getMusicLibrary(): Array<{
  id: string;
  mood: "calm" | "uplifting" | "dramatic";
  license: "CC0-1.0";
  path: string;
}> {
  const root = path.resolve(env.MEDIA_MUSIC_DIR);
  return (["calm", "uplifting", "dramatic"] as const).map((mood) => ({
    id: `invideo-${mood}-01`,
    mood,
    license: "CC0-1.0",
    path: path.join(root, `${mood}.mp3`),
  }));
}

export async function ensureProceduralMusicLibrary(): Promise<void> {
  const tracks = getMusicLibrary();
  for (const track of tracks) {
    try {
      await readFile(track.path);
      continue;
    } catch {
      /* Generate on first use. */
    }
    await mkdir(path.dirname(track.path), { recursive: true });
    const frequency =
      track.mood === "calm" ? 220 : track.mood === "uplifting" ? 330 : 110;
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=30`,
      "-af",
      "volume=0.15,afade=t=in:st=0:d=2,afade=t=out:st=27:d=3",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      track.path,
    ]);
  }
}

export function fileUrlToPath(url: string): string {
  return fileURLToPath(url);
}

export function broadenStockQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return (
    terms.slice(0, Math.max(1, Math.min(2, terms.length - 1))).join(" ") ||
    "cinematic"
  );
}

function scoreCandidate(query: string, candidate: StockCandidate): number {
  const words = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2),
  );
  const description = candidate.description.toLowerCase();
  const matches = [...words].filter((word) =>
    description.includes(word),
  ).length;
  return (
    (candidate.score ?? 0) +
    matches +
    (candidate.height >= candidate.width ? 0.25 : 0) +
    Math.min(candidate.width, 2160) / 21600
  );
}

async function storageContains(
  storage: StorageProvider,
  key: string,
): Promise<boolean> {
  try {
    await storage.get(key);
    return true;
  } catch {
    return false;
  }
}

function parseWhisperTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  const result = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(result) ? result : undefined;
}

function assTime(value: number): string {
  const centiseconds = Math.max(0, Math.round(value * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");
}
function safePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return safe || createHash("sha256").update(value).digest("hex").slice(0, 16);
}
