import OpenAI from "openai";
import { Pool } from "pg";
import { env } from "../config/env.js";
import { resolveLlmCredential } from "./llm-credentials.js";
import type { SearchDocument } from "./media-store.js";

const dimensions = 1536;
let pool: Pool | undefined;
let initialized: Promise<void> | undefined;

function getPool(): Pool | undefined {
  if (!env.MEDIA_DATABASE_URL) return undefined;
  return (pool ??= new Pool({ connectionString: env.MEDIA_DATABASE_URL }));
}

async function ensureIndex(): Promise<Pool | undefined> {
  const connection = getPool();
  if (!connection) return undefined;
  initialized ??= connection
    .query(
      `CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS media_vector_documents (
        document_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_seconds DOUBLE PRECISION NOT NULL,
        end_seconds DOUBLE PRECISION NOT NULL,
        snippet TEXT NOT NULL,
        embedding vector(${dimensions}) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS media_vector_user_asset ON media_vector_documents(user_id, asset_id);
      CREATE INDEX IF NOT EXISTS media_vector_embedding_hnsw ON media_vector_documents USING hnsw (embedding vector_cosine_ops);`,
    )
    .then(() => undefined);
  await initialized;
  return connection;
}

/** Embeddings are request-scoped and use the authenticated user's OpenAI key. */
export async function embedMediaText(
  userId: string,
  input: string,
): Promise<number[]> {
  return (await embedMediaTexts(userId, [input]))[0]!;
}

export async function embedMediaTexts(
  userId: string,
  input: string[],
): Promise<number[][]> {
  if (input.length === 0) return [];
  const credential = resolveLlmCredential({ userId, providerId: "openai" });
  const client = new OpenAI({ apiKey: credential.apiKey });
  const result = await client.embeddings.create({
    model: env.MEDIA_EMBEDDING_MODEL,
    input,
    dimensions,
  });
  const vectors = result.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (
    vectors.length !== input.length ||
    vectors.some((vector) => vector.length !== dimensions)
  ) {
    throw new Error(
      `embedding provider returned ${vectors.length} vector(s); expected ${input.length} vectors of ${dimensions} dimensions`,
    );
  }
  return vectors;
}

export async function indexMediaVectors(
  documents: SearchDocument[],
): Promise<void> {
  const connection = await ensureIndex();
  if (!connection || documents.length === 0) return;
  const client = await connection.connect();
  try {
    await client.query("BEGIN");
    for (const document of documents) {
      await client.query(
        `INSERT INTO media_vector_documents(document_id,user_id,asset_id,kind,start_seconds,end_seconds,snippet,embedding)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector)
         ON CONFLICT(document_id) DO UPDATE SET snippet=EXCLUDED.snippet, embedding=EXCLUDED.embedding,
           start_seconds=EXCLUDED.start_seconds, end_seconds=EXCLUDED.end_seconds`,
        [
          document.documentId,
          document.userId,
          document.assetId,
          document.kind,
          document.start,
          document.end,
          document.snippet,
          toVector(document.embedding),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function searchMediaVectors(
  userId: string,
  embedding: number[],
  limit: number,
): Promise<Array<SearchDocument & { score: number }> | undefined> {
  const connection = await ensureIndex();
  if (!connection) return undefined;
  const result = await connection.query<{
    document_id: string;
    user_id: string;
    asset_id: string;
    kind: "transcript" | "frame";
    start_seconds: number;
    end_seconds: number;
    snippet: string;
    score: number;
  }>(
    `SELECT document_id,user_id,asset_id,kind,start_seconds,end_seconds,snippet,
       1 - (embedding <=> $2::vector) AS score
     FROM media_vector_documents WHERE user_id=$1
     ORDER BY embedding <=> $2::vector LIMIT $3`,
    [userId, toVector(embedding), limit],
  );
  return result.rows.map((row) => ({
    documentId: row.document_id,
    userId: row.user_id,
    assetId: row.asset_id,
    kind: row.kind,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    snippet: row.snippet,
    embedding: [],
    score: Number(row.score),
  }));
}

function toVector(value: number[]): string {
  return `[${value
    .map((number) => {
      if (!Number.isFinite(number))
        throw new Error("embedding contains a non-finite value");
      return number;
    })
    .join(",")}]`;
}
