import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

describe("POST /api/uploads", () => {
  let app: (typeof import("../src/app.js"))["app"];
  let uploadDir: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.UPLOAD_DIR = await mkdtemp(join(tmpdir(), "invideo-uploads-"));
    // Deliberately tiny so the byte cap can be exercised in tests.
    process.env.UPLOAD_MAX_BYTES = "64";
    uploadDir = process.env.UPLOAD_DIR;

    const mod = await import("../src/app.js");
    app = mod.app;
  });

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("streams a small upload to disk and returns its id and byte count", async () => {
    const payload = Buffer.from("portrait clip bytes");

    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "application/octet-stream")
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body.uploadId).toMatch(/^up_/);
    expect(response.body.bytes).toBe(payload.length);

    const files = await readdir(uploadDir);
    const stored = files.find((file) => file === response.body.uploadId);
    expect(stored).toBe(response.body.uploadId);
    const bytes = await readFile(join(uploadDir, response.body.uploadId));
    expect(bytes.equals(payload)).toBe(true);
  });

  it("rejects an upload whose declared content-length is over the cap", async () => {
    // Declared length (65) is over the 64-byte cap, so the server must
    // refuse before reading any body bytes.
    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "application/octet-stream")
      .send(Buffer.alloc(65, 1));

    expect(response.status).toBe(413);
    expect(response.body.error.message).toContain("upload limit");

    const files = await readdir(uploadDir);
    expect(files.filter((file) => file.startsWith("up_"))).toHaveLength(1);
  });

  it("rejects an empty upload with 400 and stores nothing", async () => {
    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "application/octet-stream")
      .send(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("no data");

    const files = await readdir(uploadDir);
    expect(files.filter((file) => file.startsWith("up_"))).toHaveLength(1);
  });
});

describe("JSON body limit", () => {
  let app: (typeof import("../src/app.js"))["app"];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const mod = await import("../src/app.js");
    app = mod.app;
  });

  it("rejects a JSON body above the small limit with 413", async () => {
    const bigPrompt = JSON.stringify({ prompt: "x".repeat(200_000) });

    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "application/json")
      .send(bigPrompt);

    expect(response.status).toBe(413);
    expect(response.body.error).toBeDefined();
  });

  it("lets a small JSON body through express.json to the route", async () => {
    // The small JSON body parses cleanly; the upload route then sees an
    // already-consumed stream and reports its own empty-upload error
    // instead of a body-limit failure.
    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "application/json")
      .send({ prompt: "make me a video" });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("no data");
  });
});
