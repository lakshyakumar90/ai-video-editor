import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/async-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import {
  deleteUploadSession,
  getUploadSession,
  insertUploadSession,
} from "../services/media-store.js";
import { registerMediaUpload } from "../services/media-ingestion.js";

export class UploadTooLargeError extends Error {
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`upload exceeds the ${maxBytes}-byte upload limit`);
    this.name = "UploadTooLargeError";
  }
}
export class EmptyUploadError extends Error {
  readonly status = 400;
  constructor() {
    super("upload contained no data");
    this.name = "EmptyUploadError";
  }
}

const startChunkedSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  totalChunks: z.number().int().min(1).max(10_000),
  totalBytes: z.number().int().min(1),
});

export function uploadsRouter(): Router {
  const router = Router();
  const directory = resolve(env.UPLOAD_DIR);
  router.use(requireAuth);

  router.post(
    "/chunks",
    asyncHandler(async (req, res) => {
      const parsed = startChunkedSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            message:
              "filename, contentType, totalChunks and totalBytes are required",
          },
        });
        return;
      }
      if (parsed.data.totalBytes > env.UPLOAD_MAX_BYTES) {
        res.status(413).json({
          error: {
            message: `upload exceeds the ${env.UPLOAD_MAX_BYTES}-byte upload limit`,
          },
        });
        return;
      }
      const uploadId = `up_${randomUUID()}`;
      insertUploadSession({
        uploadId,
        userId: req.authUserId!,
        filename: parsed.data.filename,
        contentType: parsed.data.contentType,
        expectedChunks: parsed.data.totalChunks,
        expectedBytes: parsed.data.totalBytes,
      });
      await mkdir(join(directory, "chunks", uploadId), { recursive: true });
      res.status(201).json({
        uploadId,
        chunkSizeLimit: Math.min(env.UPLOAD_MAX_BYTES, 32 * 1024 * 1024),
      });
    }),
  );

  router.put(
    "/chunks/:uploadId/:index",
    asyncHandler(async (req, res) => {
      const uploadId = String(req.params.uploadId);
      const index = Number(req.params.index);
      const session = getUploadSession(uploadId!, req.authUserId!);
      if (!session) {
        res
          .status(404)
          .json({ error: { message: "upload session not found" } });
        return;
      }
      const expectedChunks = Number(session.expected_chunks);
      if (!Number.isInteger(index) || index < 0 || index >= expectedChunks) {
        res.status(400).json({
          error: { message: "chunk index is outside the declared range" },
        });
        return;
      }
      const maxChunk = Math.min(env.UPLOAD_MAX_BYTES, 32 * 1024 * 1024);
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxChunk) {
        res.status(413).json({
          error: { message: `chunk exceeds the ${maxChunk}-byte limit` },
        });
        req.resume();
        return;
      }
      const chunkPath = join(
        directory,
        "chunks",
        uploadId!,
        String(index).padStart(6, "0"),
      );
      try {
        await stat(chunkPath);
        res
          .status(409)
          .json({ error: { message: "chunk was already uploaded" } });
        return;
      } catch {
        // The chunk has not been uploaded yet.
      }
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(
            received > maxChunk ? new UploadTooLargeError(maxChunk) : null,
            received > maxChunk ? undefined : chunk,
          );
        },
      });
      try {
        await pipeline(
          req,
          counter,
          createWriteStream(chunkPath, { flags: "wx" }),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await rm(chunkPath, { force: true });
        }
        throw error;
      }
      if (!received) {
        await rm(chunkPath, { force: true });
        throw new EmptyUploadError();
      }
      res.status(201).json({ uploadId, index, bytes: received });
    }),
  );

  router.post(
    "/chunks/:uploadId/complete",
    asyncHandler(async (req, res) => {
      const uploadId = String(req.params.uploadId);
      const session = getUploadSession(uploadId!, req.authUserId!);
      if (!session) {
        res
          .status(404)
          .json({ error: { message: "upload session not found" } });
        return;
      }
      const chunkDir = join(directory, "chunks", uploadId!);
      const chunks = Number(session.expected_chunks);
      const chunkPaths = Array.from({ length: chunks }, (_, index) =>
        join(chunkDir, String(index).padStart(6, "0")),
      );
      const sizes: number[] = [];
      try {
        for (const file of chunkPaths) sizes.push((await stat(file)).size);
      } catch {
        res.status(400).json({
          error: { message: "one or more upload chunks are missing" },
        });
        return;
      }
      const bytes = sizes.reduce((sum, size) => sum + size, 0);
      if (bytes !== Number(session.expected_bytes)) {
        res.status(400).json({
          error: {
            message: `received ${bytes} bytes; expected ${session.expected_bytes}`,
          },
        });
        return;
      }
      const filePath = join(directory, uploadId!);
      await writeFile(filePath, Buffer.alloc(0), { flag: "wx" });
      try {
        for (const chunkPath of chunkPaths)
          await pipeline(
            createReadStream(chunkPath),
            createWriteStream(filePath, { flags: "a" }),
          );
        const accepted = await registerMediaUpload({
          userId: req.authUserId!,
          uploadId: uploadId!,
          filePath,
          filename: String(session.filename),
          contentType: String(session.content_type),
        });
        deleteUploadSession(uploadId!, req.authUserId!);
        await rm(chunkDir, { recursive: true, force: true });
        res.status(202).json({
          uploadId,
          assetId: accepted.asset.assetId,
          job: accepted.job,
          reused: accepted.reused,
        });
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > env.UPLOAD_MAX_BYTES) {
        res.status(413).json({
          error: {
            message: `upload exceeds the ${env.UPLOAD_MAX_BYTES}-byte upload limit`,
          },
        });
        req.resume();
        return;
      }
      const uploadId = `up_${randomUUID()}`;
      await mkdir(directory, { recursive: true });
      const filePath = join(directory, uploadId);
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(
            received > env.UPLOAD_MAX_BYTES
              ? new UploadTooLargeError(env.UPLOAD_MAX_BYTES)
              : null,
            received > env.UPLOAD_MAX_BYTES ? undefined : chunk,
          );
        },
      });
      try {
        await pipeline(
          req,
          counter,
          createWriteStream(filePath, { flags: "wx" }),
        );
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
      if (!received) {
        await rm(filePath, { force: true });
        throw new EmptyUploadError();
      }
      try {
        const accepted = await registerMediaUpload({
          userId: req.authUserId!,
          uploadId,
          filePath,
          filename: String(req.headers["x-file-name"] ?? uploadId),
          contentType: String(req.headers["content-type"] ?? ""),
        });
        res.status(202).json({
          uploadId,
          bytes: received,
          assetId: accepted.asset.assetId,
          job: accepted.job,
          reused: accepted.reused,
        });
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
    }),
  );

  return router;
}
