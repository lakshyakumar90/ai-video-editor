CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS media_vector_documents (
  document_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transcript', 'frame')),
  start_seconds DOUBLE PRECISION NOT NULL,
  end_seconds DOUBLE PRECISION NOT NULL,
  snippet TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_vector_user_asset
  ON media_vector_documents(user_id, asset_id);

CREATE INDEX IF NOT EXISTS media_vector_embedding_hnsw
  ON media_vector_documents USING hnsw (embedding vector_cosine_ops);
