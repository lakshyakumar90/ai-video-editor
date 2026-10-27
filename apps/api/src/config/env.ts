import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // CORS
  WEB_ORIGIN: z.string().url(),

  // Pexels API
  PIXABAY_API_KEY: z.string().min(1, "PEXELS_API_KEY cannot be empty"),

  // Local Whisper.cpp
  WHISPER_CPP_PATH: z.string().min(1),
  WHISPER_MODEL_PATH: z.string().min(1),
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
