import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  LLM_DATABASE_PATH: z.string().min(1).optional(),
  LLM_MODEL_PRICING_JSON: z.string().default("{}"),

  // CORS
  WEB_ORIGIN: z.string().url(),

  TTS_PROVIDER: z.enum(["fake", "openai"]).default("fake"),
  TTS_MODEL: z.string().min(1).default("gpt-4o-mini-tts"),
  TTS_VOICE: z.string().min(1).default("alloy"),
  STOCK_PROVIDER: z.enum(["fake", "pexels"]).default("fake"),
  TRANSCRIPTION_PROVIDER: z.enum(["fake", "whisper"]).default("fake"),
  STORAGE_PROVIDER: z.enum(["local-disk"]).default("local-disk"),
  MEDIA_MUSIC_DIR: z.string().min(1).default("assets/music"),

  // Local Whisper.cpp
  WHISPER_CPP_PATH: z.string().min(1),
  WHISPER_MODEL_PATH: z.string().min(1),

  // Large-file uploads (raw footage, audio): streamed to disk outside
  // the JSON body parser, with a hard per-request byte cap.
  UPLOAD_DIR: z.string().min(1),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(104_857_600),
  MEDIA_DATABASE_URL: z.string().optional(),
  MEDIA_PROXY_HEIGHT: z.coerce.number().int().min(144).max(1080).default(480),
  MEDIA_THUMBNAIL_INTERVAL_SECONDS: z.coerce.number().positive().default(10),
  MEDIA_MAX_VISION_FRAMES: z.coerce.number().int().min(0).max(24).default(12),
  MEDIA_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),

  // Deployment mode (docs/decision-deployment.md):
  // - "self-hosted": CLI LLM providers (OpenCode server, Codex CLI) allowed
  // - "hosted": CLI providers never; users bring their own API keys
  DEPLOYMENT_MODE: z.enum(["self-hosted", "hosted"]).default("self-hosted"),

  // Master key used to encrypt stored user API keys (32 random bytes,
  // hex-encoded). Users in hosted deployments bring their own API keys
  // (docs/decision-deployment.md); those keys are only ever persisted
  // encrypted under this key. Rotating it requires re-encrypting every
  // stored key.
  MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "MASTER_KEY must be 64 hex characters (32 random bytes)",
    ),

  // LLM provider selection lives in the registry (llm-registry.ts).
  LLM_PROVIDER: z
    .enum([
      "fake",
      "opencode",
      "codex",
      "hosted-openai",
      "openai-compatible",
      "openrouter",
      "groq",
      "together",
      "deepseek",
      "ollama",
      "lm-studio",
      "vllm",
      "openai",
      "anthropic",
      "gemini",
    ])
    .default("opencode"),

  // Hosted OpenAI-compatible provider (bring-your-own-key; only needed
  // when LLM_PROVIDER=hosted-openai).
  LLM_HOSTED_BASE_URL: z.string().default(""),
  LLM_HOSTED_API_KEY: z.string().default(""),
  LLM_HOSTED_MODEL: z.string().default(""),

  // OpenCode local LLM server
  OPENCODE_BASE_URL: z.string().url(),
  OPENCODE_SERVER_PASSWORD: z.string().min(1),
  OPENCODE_MODEL_PREFERENCE: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .every((entry) => /^[^/]+\/.+/.test(entry)),
      "OPENCODE_MODEL_PREFERENCE entries must look like provider/model",
    ),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables:");

  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }

  process.exit(1);
}

export const env = result.data;
