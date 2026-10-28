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

/** Preferred OpenCode models in priority order, parsed from `provider/model` entries. */
export const openCodePreferredModels = env.OPENCODE_MODEL_PREFERENCE.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [providerID, ...rest] = entry.split("/");
    return { providerID: providerID ?? "", modelID: rest.join("/") };
  })
  .filter((model) => model.modelID.length > 0);
