import { Router } from "express";
import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/async-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import {
  getLatestMediaJob,
  getMediaAsset,
  getMediaJob,
  listMediaAssets,
  listSearchDocuments,
  type MediaAssetRecord,
} from "../services/media-store.js";
import {
  embedMediaText,
  searchMediaVectors,
} from "../services/media-vector-index.js";
import { semanticRankLocal } from "../services/media-ingestion.js";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(50).default(10),
});

export function mediaRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/assets", (req, res) => {
    res.json({ assets: listMediaAssets(req.authUserId!).map(publicAsset) });
  });

  router.get("/assets/:assetId", (req, res) => {
    const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
    if (!asset) {
      res.status(404).json({ error: { message: "media asset not found" } });
      return;
    }
    res.json({
      asset: publicAsset(asset),
      job: getLatestMediaJob(req.authUserId!, asset.assetId) ?? null,
    });
  });

  router.get("/jobs/:jobId", (req, res) => {
    const job = getMediaJob(req.authUserId!, String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: { message: "media job not found" } });
      return;
    }
    res.json({ job });
  });

  router.get(
    "/assets/:assetId/proxy",
    asyncHandler(async (req, res) => {
      const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
      if (!asset) {
        res.status(404).json({ error: { message: "media asset not found" } });
        return;
      }
      const proxyPath = asset.metadata.proxyPath;
      if (typeof proxyPath !== "string") {
        res
          .status(409)
          .json({ error: { message: "proxy is not ready for this asset" } });
        return;
      }
      const file = resolveOwnedPath(proxyPath);
      try {
        await access(file);
      } catch {
        res.status(404).json({ error: { message: "proxy file is missing" } });
        return;
      }
      res.sendFile(file);
    }),
  );

  router.get(
    "/assets/:assetId/original",
    asyncHandler(async (req, res) => {
      const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
      if (!asset) {
        res.status(404).json({ error: { message: "media asset not found" } });
        return;
      }
      res.sendFile(asset.originalPath);
    }),
  );

  router.get(
    "/assets/:assetId/thumbnails/:index",
    asyncHandler(async (req, res) => {
      const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
      const index = Number(req.params.index);
      const thumbnails = asset?.metadata.thumbnails;
      if (
        !asset ||
        !Array.isArray(thumbnails) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= thumbnails.length
      ) {
        res.status(404).json({ error: { message: "thumbnail not found" } });
        return;
      }
      res.sendFile(resolveOwnedPath(String(thumbnails[index])));
    }),
  );

  router.get(
    "/assets/:assetId/waveform",
    asyncHandler(async (req, res) => {
      const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
      const waveform = asset?.metadata.waveformPath;
      if (!asset || typeof waveform !== "string") {
        res.status(404).json({ error: { message: "waveform not found" } });
        return;
      }
      res.sendFile(resolveOwnedPath(waveform));
    }),
  );

  router.get("/assets/:assetId/highlights", (req, res) => {
    const asset = getMediaAsset(req.authUserId!, String(req.params.assetId));
    if (!asset) {
      res.status(404).json({ error: { message: "media asset not found" } });
      return;
    }
    res.json({
      clips: Array.isArray(asset.metadata.suggestedClips)
        ? asset.metadata.suggestedClips
        : [],
    });
  });

  router.post(
    "/search",
    asyncHandler(async (req, res) => {
      const parsed = searchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            message: "query must be a non-empty string and limit must be 1–50",
          },
        });
        return;
      }
      const userId = req.authUserId!;
      const embedding = await embedMediaText(userId, parsed.data.query);
      const ranked =
        (await searchMediaVectors(userId, embedding, parsed.data.limit)) ??
        semanticRankLocal(
          userId,
          embedding,
          listSearchDocuments(userId),
          parsed.data.limit,
        );
      const assets = new Map(
        listMediaAssets(userId).map((asset) => [asset.assetId, asset]),
      );
      res.json({
        results: ranked.map((result) => ({
          asset: {
            id: result.assetId,
            filename: assets.get(result.assetId)?.filename ?? "unknown",
          },
          start: result.start,
          end: result.end,
          score: result.score,
          snippet: result.snippet,
          kind: result.kind,
        })),
      });
    }),
  );

  return router;
}

function publicAsset(asset: MediaAssetRecord): Record<string, unknown> {
  return {
    id: asset.assetId,
    sourceUrl: `/api/media/assets/${asset.assetId}/original`,
    filename: asset.filename,
    contentType: asset.contentType,
    contentHash: asset.contentHash,
    duration: asset.duration,
    status: asset.status,
    metadata: asset.metadata,
    error: asset.error,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function resolveOwnedPath(relativePath: string): string {
  const root = path.resolve(env.UPLOAD_DIR);
  const candidate = path.resolve(root, relativePath);
  if (!candidate.startsWith(`${root}${path.sep}`))
    throw Object.assign(new Error("invalid media path"), { status: 400 });
  return candidate;
}
