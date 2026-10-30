import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

describe("authenticated media uploads", () => {
  let app: (typeof import("../src/app.js"))["app"];
  let uploadDir: string;
  let cookie: string[];
  let sample: Buffer;
  let sampleAudio: Buffer;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.UPLOAD_DIR = await mkdtemp(
      path.join(tmpdir(), "invideo-media-upload-test-"),
    );
    process.env.UPLOAD_MAX_BYTES = "2000000";
    uploadDir = process.env.UPLOAD_DIR;
    sample = await readFile(path.resolve("../../tmp/samples/sample-clip.mp4"));
    sampleAudio = await readFile(path.resolve("../../tmp/samples/sample.mp3"));
    const mod = await import("../src/app.js");
    app = mod.createApp();
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "Media test",
        email: `media-${randomUUID()}@example.test`,
        password: "a-long-test-password",
      });
    expect(signup.status).toBe(200);
    const cookieHeader = signup.headers["set-cookie"];
    cookie = cookieValues(cookieHeader);
  });

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("requires a verified Better Auth session", async () => {
    const response = await request(app)
      .post("/api/uploads")
      .set("content-type", "video/mp4")
      .send(sample);
    expect(response.status).toBe(401);
  });

  it("ffprobes a valid streamed media upload and creates an ingestion job", async () => {
    const response = await request(app)
      .post("/api/uploads")
      .set("Cookie", cookie)
      .set("content-type", "video/mp4")
      .set("x-file-name", "sample-clip.mp4")
      .send(sample);

    expect(response.status).toBe(202);
    expect(response.body.assetId).toMatch(/^asset_/);
    expect(response.body.job.status).toBe("queued");
    const stored = await readFile(path.join(uploadDir, response.body.uploadId));
    expect(stored.equals(sample)).toBe(true);
    await waitForTerminalJob(app, cookie, response.body.job.jobId);
  }, 120_000);

  it("rejects invalid media even when its declared type is allowed", async () => {
    const before = await readdir(uploadDir);
    const response = await request(app)
      .post("/api/uploads")
      .set("Cookie", cookie)
      .set("content-type", "video/mp4")
      .send(Buffer.from("not a video"));
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/ffprobe validation failed/i);
    expect(await readdir(uploadDir)).toEqual(before);
  });

  it("enforces content type and the streamed byte cap", async () => {
    const wrongType = await request(app)
      .post("/api/uploads")
      .set("Cookie", cookie)
      .set("content-type", "application/pdf")
      .send(Buffer.from("pdf"));
    expect(wrongType.status).toBe(415);

    const tooLarge = await request(app)
      .post("/api/uploads")
      .set("Cookie", cookie)
      .set("content-type", "application/octet-stream")
      .send(Buffer.alloc(2_000_001, 1));
    expect(tooLarge.status).toBe(413);
  });

  it("assembles ordered chunks before validating and scheduling ingestion", async () => {
    const chunks = [
      sampleAudio.subarray(0, 8_000),
      sampleAudio.subarray(8_000, 16_000),
      sampleAudio.subarray(16_000),
    ];
    const started = await request(app)
      .post("/api/uploads/chunks")
      .set("Cookie", cookie)
      .send({
        filename: "chunked.mp3",
        contentType: "audio/mpeg",
        totalChunks: chunks.length,
        totalBytes: sampleAudio.length,
      });
    expect(started.status).toBe(201);
    for (const [index, chunk] of chunks.entries()) {
      const response = await request(app)
        .put(`/api/uploads/chunks/${started.body.uploadId}/${index}`)
        .set("Cookie", cookie)
        .set("content-type", "application/octet-stream")
        .send(chunk);
      expect(response.status).toBe(201);
    }
    const completed = await request(app)
      .post(`/api/uploads/chunks/${started.body.uploadId}/complete`)
      .set("Cookie", cookie);
    expect(completed.status).toBe(202);
    expect(completed.body.assetId).toMatch(/^asset_/);
    const stored = await readFile(path.join(uploadDir, started.body.uploadId));
    expect(stored.equals(sampleAudio)).toBe(true);
    expect(
      await stat(path.join(uploadDir, "chunks", started.body.uploadId)).catch(
        () => undefined,
      ),
    ).toBeUndefined();
    await waitForTerminalJob(app, cookie, completed.body.job.jobId);
  }, 120_000);

  it("does not let another account inspect an asset", async () => {
    const firstAssets = await request(app)
      .get("/api/media/assets")
      .set("Cookie", cookie);
    expect(firstAssets.status).toBe(200);
    const assetId = firstAssets.body.assets[0]?.id as string;
    expect(assetId).toBeTruthy();
    const otherSignup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "Other user",
        email: `other-${randomUUID()}@example.test`,
        password: "a-long-test-password",
      });
    const header = otherSignup.headers["set-cookie"];
    const otherCookie = cookieValues(header);
    const response = await request(app)
      .get(`/api/media/assets/${assetId}`)
      .set("Cookie", otherCookie);
    expect(response.status).toBe(404);
  });
});

function cookieValues(header: string | string[] | undefined): string[] {
  if (Array.isArray(header))
    return header.filter((value): value is string => Boolean(value));
  return header ? [header] : [];
}

async function waitForTerminalJob(
  app: (typeof import("../src/app.js"))["app"],
  cookie: string[],
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await request(app)
      .get(`/api/media/jobs/${jobId}`)
      .set("Cookie", cookie);
    if (
      result.body.job?.status === "complete" ||
      result.body.job?.status === "failed"
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`media job ${jobId} did not finish within 90 seconds`);
}
