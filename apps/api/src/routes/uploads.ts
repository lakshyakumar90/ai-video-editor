import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/async-handler.js";

/** Requested upload is larger than `UPLOAD_MAX_BYTES` (HTTP 413). */
export class UploadTooLargeError extends Error {
  readonly status = 413;

  constructor(maxBytes: number) {
    super(`upload exceeds the ${maxBytes}-byte upload limit`);
    this.name = "UploadTooLargeError";
  }
}

/** Upload carried no bytes at all (HTTP 400). */
export class EmptyUploadError extends Error {
  readonly status = 400;

  constructor() {
    super("upload contained no data");
    this.name = "EmptyUploadError";
  }
}

/**
 * Responds to the client and stops reading the request stream as soon
 * as it is known to be over the byte cap, so oversized bodies never
 * reach disk.
 */
function abortUpload(
  req: import("express").Request,
  res: import("express").Response,
  maxBytes: number,
): void {
  const tooLarge = new UploadTooLargeError(maxBytes);
  res.status(tooLarge.status).json({ error: { message: tooLarge.message } });
  // Discard whatever of the body is still in flight; the response has
  // already been sent and the bytes must not reach disk.
  req.resume();
}

export function uploadsRouter(): Router {
  const router = Router();
  const maxBytes = env.UPLOAD_MAX_BYTES;

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      // A declared content-length over the cap rejects immediately,
      // before a single byte is streamed.
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        abortUpload(req, res, maxBytes);
        return;
      }

      const uploadId = `up_${randomUUID()}`;
      const directory = resolve(env.UPLOAD_DIR);
      await mkdir(directory, { recursive: true });
      const filePath = join(directory, uploadId);

      let received = 0;
      const byteCounter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > maxBytes) {
            callback(new UploadTooLargeError(maxBytes));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        // Stream straight to disk: a 100 MB clip is never buffered in
        // memory, and the hard cap applies even without a declared
        // content-length.
        await pipeline(
          req,
          byteCounter,
          createWriteStream(filePath, { flags: "wx" }),
        );
      } catch (error) {
        // A failed upload must never leave a partial file behind.
        await rm(filePath, { force: true });
        throw error;
      }

      if (received === 0) {
        await rm(filePath, { force: true });
        throw new EmptyUploadError();
      }

      res.status(201).json({ uploadId, bytes: received });
    }),
  );

  return router;
}
