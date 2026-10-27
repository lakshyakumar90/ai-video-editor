import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

describe("GET /health", () => {
  let app: (typeof import("../src/app.js"))["app"];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.PORT = "3001";
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.PIXABAY_API_KEY = "test-key";
    process.env.WHISPER_CPP_PATH = "C:\\local-ai\\whisper\\whisper-cli.exe";
    process.env.WHISPER_MODEL_PATH = "C:\\local-ai\\whisper\\models\\ggml-base.bin";

    const mod = await import("../src/app.js");
    app = mod.app;
  });

  it("returns 200 with status ok", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
