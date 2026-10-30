import { randomUUID } from "node:crypto";
import { authDatabase } from "./auth.js";

authDatabase.exec(`
  CREATE TABLE IF NOT EXISTS media_assets (
    asset_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    original_path TEXT NOT NULL,
    duration REAL,
    status TEXT NOT NULL CHECK(status IN ('queued','processing','complete','failed')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, content_hash)
  );
  CREATE INDEX IF NOT EXISTS media_assets_user_created ON media_assets(user_id, created_at);
  CREATE TABLE IF NOT EXISTS media_ingestion_jobs (
    job_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','processing','complete','failed')),
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_jobs_user_created ON media_ingestion_jobs(user_id, created_at);
  CREATE TABLE IF NOT EXISTS media_search_documents (
    document_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    snippet TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_docs_user_asset ON media_search_documents(user_id, asset_id);
  CREATE TABLE IF NOT EXISTS media_upload_sessions (
    upload_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_chunks INTEGER NOT NULL,
    expected_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

export type MediaStatus = "queued" | "processing" | "complete" | "failed";
export type MediaAssetRecord = {
  assetId: string;
  userId: string;
  uploadId: string;
  filename: string;
  contentType: string;
  contentHash: string;
  originalPath: string;
  duration: number | null;
  status: MediaStatus;
  metadata: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MediaJobRecord = {
  jobId: string;
  assetId: string;
  userId: string;
  status: MediaStatus;
  progress: number;
  stage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SearchDocument = {
  documentId: string;
  userId: string;
  assetId: string;
  kind: "transcript" | "frame";
  start: number;
  end: number;
  snippet: string;
  embedding: number[];
};

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createMediaAsset(
  record: Omit<MediaAssetRecord, "createdAt" | "updatedAt">,
): MediaAssetRecord {
  const now = new Date().toISOString();
  authDatabase
    .prepare(
      `INSERT INTO media_assets
      (asset_id,user_id,upload_id,filename,content_type,content_hash,original_path,duration,status,metadata_json,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      record.assetId,
      record.userId,
      record.uploadId,
      record.filename,
      record.contentType,
      record.contentHash,
      record.originalPath,
      record.duration,
      record.status,
      JSON.stringify(record.metadata),
      record.error,
      now,
      now,
    );
  return getMediaAsset(record.userId, record.assetId)!;
}

export function findMediaAssetByHash(
  userId: string,
  contentHash: string,
): MediaAssetRecord | undefined {
  const row = authDatabase
    .prepare("SELECT * FROM media_assets WHERE user_id=? AND content_hash=?")
    .get(userId, contentHash);
  return row ? decodeAsset(row) : undefined;
}

export function getMediaAsset(
  userId: string,
  assetId: string,
): MediaAssetRecord | undefined {
  const row = authDatabase
    .prepare("SELECT * FROM media_assets WHERE user_id=? AND asset_id=?")
    .get(userId, assetId);
  return row ? decodeAsset(row) : undefined;
}

export function listMediaAssets(userId: string): MediaAssetRecord[] {
  return authDatabase
    .prepare(
      "SELECT * FROM media_assets WHERE user_id=? ORDER BY created_at DESC",
    )
    .all(userId)
    .map(decodeAsset);
}

export function updateMediaAsset(
  userId: string,
  assetId: string,
  patch: Partial<
    Pick<MediaAssetRecord, "duration" | "status" | "metadata" | "error">
  >,
): void {
  const current = getMediaAsset(userId, assetId);
  if (!current) throw new Error("media asset not found");
  authDatabase
    .prepare(
      `UPDATE media_assets SET duration=?, status=?, metadata_json=?, error=?, updated_at=?
      WHERE user_id=? AND asset_id=?`,
    )
    .run(
      patch.duration ?? current.duration,
      patch.status ?? current.status,
      JSON.stringify(patch.metadata ?? current.metadata),
      patch.error === undefined ? current.error : patch.error,
      new Date().toISOString(),
      userId,
      assetId,
    );
}

export function createMediaJob(
  userId: string,
  assetId: string,
): MediaJobRecord {
  const record = {
    jobId: newId("job"),
    assetId,
    userId,
    status: "queued" as const,
    progress: 0,
    stage: "queued",
    error: null,
  };
  const now = new Date().toISOString();
  authDatabase
    .prepare(
      `INSERT INTO media_ingestion_jobs
      (job_id,asset_id,user_id,status,progress,stage,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      record.jobId,
      assetId,
      userId,
      record.status,
      0,
      "queued",
      null,
      now,
      now,
    );
  return { ...record, createdAt: now, updatedAt: now };
}

export function getMediaJob(
  userId: string,
  jobId: string,
): MediaJobRecord | undefined {
  const row = authDatabase
    .prepare("SELECT * FROM media_ingestion_jobs WHERE user_id=? AND job_id=?")
    .get(userId, jobId);
  if (!row) return undefined;
  const value = row as Record<string, unknown>;
  return {
    jobId: String(value.job_id),
    assetId: String(value.asset_id),
    userId: String(value.user_id),
    status: value.status as MediaStatus,
    progress: Number(value.progress),
    stage: String(value.stage),
    error: value.error ? String(value.error) : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

export function getLatestMediaJob(
  userId: string,
  assetId: string,
): MediaJobRecord | undefined {
  const row = authDatabase
    .prepare(
      "SELECT * FROM media_ingestion_jobs WHERE user_id=? AND asset_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(userId, assetId);
  if (!row) return undefined;
  const value = row as Record<string, unknown>;
  return {
    jobId: String(value.job_id),
    assetId: String(value.asset_id),
    userId: String(value.user_id),
    status: value.status as MediaStatus,
    progress: Number(value.progress),
    stage: String(value.stage),
    error: value.error ? String(value.error) : null,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

export function listPendingMediaJobs(): MediaJobRecord[] {
  return authDatabase
    .prepare(
      "SELECT * FROM media_ingestion_jobs WHERE status IN ('queued','processing') ORDER BY created_at",
    )
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        jobId: String(value.job_id),
        assetId: String(value.asset_id),
        userId: String(value.user_id),
        status: value.status as MediaStatus,
        progress: Number(value.progress),
        stage: String(value.stage),
        error: value.error ? String(value.error) : null,
        createdAt: String(value.created_at),
        updatedAt: String(value.updated_at),
      };
    });
}

export function updateMediaJob(
  userId: string,
  jobId: string,
  patch: Partial<
    Pick<MediaJobRecord, "status" | "progress" | "stage" | "error">
  >,
): void {
  const current = getMediaJob(userId, jobId);
  if (!current) throw new Error("media ingestion job not found");
  authDatabase
    .prepare(
      `UPDATE media_ingestion_jobs SET status=?,progress=?,stage=?,error=?,updated_at=?
      WHERE user_id=? AND job_id=?`,
    )
    .run(
      patch.status ?? current.status,
      patch.progress ?? current.progress,
      patch.stage ?? current.stage,
      patch.error === undefined ? current.error : patch.error,
      new Date().toISOString(),
      userId,
      jobId,
    );
}

export function saveSearchDocuments(documents: SearchDocument[]): void {
  if (!documents.length) return;
  const insert = authDatabase.prepare(`INSERT INTO media_search_documents
    (document_id,user_id,asset_id,kind,start,end,snippet,embedding_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(document_id) DO UPDATE SET snippet=excluded.snippet, embedding_json=excluded.embedding_json,
      start=excluded.start, end=excluded.end, created_at=excluded.created_at`);
  const now = new Date().toISOString();
  authDatabase.exec("BEGIN IMMEDIATE");
  try {
    for (const item of documents) {
      insert.run(
        item.documentId,
        item.userId,
        item.assetId,
        item.kind,
        item.start,
        item.end,
        item.snippet,
        JSON.stringify(item.embedding),
        now,
      );
    }
    authDatabase.exec("COMMIT");
  } catch (error) {
    authDatabase.exec("ROLLBACK");
    throw error;
  }
}

export function listSearchDocuments(userId: string): SearchDocument[] {
  return authDatabase
    .prepare("SELECT * FROM media_search_documents WHERE user_id=?")
    .all(userId)
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        documentId: String(value.document_id),
        userId: String(value.user_id),
        assetId: String(value.asset_id),
        kind: value.kind as SearchDocument["kind"],
        start: Number(value.start),
        end: Number(value.end),
        snippet: String(value.snippet),
        embedding: JSON.parse(String(value.embedding_json)) as number[],
      };
    });
}

export function insertUploadSession(input: {
  uploadId: string;
  userId: string;
  filename: string;
  contentType: string;
  expectedChunks: number;
  expectedBytes: number;
}): void {
  authDatabase
    .prepare(
      `INSERT INTO media_upload_sessions(upload_id,user_id,filename,content_type,expected_chunks,expected_bytes,created_at)
      VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      input.uploadId,
      input.userId,
      input.filename,
      input.contentType,
      input.expectedChunks,
      input.expectedBytes,
      new Date().toISOString(),
    );
}

export function getUploadSession(
  uploadId: string,
  userId: string,
): Record<string, unknown> | undefined {
  return authDatabase
    .prepare(
      "SELECT * FROM media_upload_sessions WHERE upload_id=? AND user_id=?",
    )
    .get(uploadId, userId) as Record<string, unknown> | undefined;
}

export function deleteUploadSession(uploadId: string, userId: string): void {
  authDatabase
    .prepare(
      "DELETE FROM media_upload_sessions WHERE upload_id=? AND user_id=?",
    )
    .run(uploadId, userId);
}

function decodeAsset(row: unknown): MediaAssetRecord {
  const value = row as Record<string, unknown>;
  return {
    assetId: String(value.asset_id),
    userId: String(value.user_id),
    uploadId: String(value.upload_id),
    filename: String(value.filename),
    contentType: String(value.content_type),
    contentHash: String(value.content_hash),
    originalPath: String(value.original_path),
    duration: value.duration == null ? null : Number(value.duration),
    status: value.status as MediaStatus,
    metadata: JSON.parse(String(value.metadata_json)) as Record<
      string,
      unknown
    >,
    error: value.error == null ? null : String(value.error),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}
