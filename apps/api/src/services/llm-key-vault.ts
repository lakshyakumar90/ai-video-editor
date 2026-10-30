import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { authDatabase } from "./auth.js";
import { env } from "../config/env.js";

const key = Buffer.from(env.MASTER_KEY, "hex");
authDatabase.exec(`
  CREATE TABLE IF NOT EXISTS llm_provider_keys (
    user_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    last_four TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider_id)
  )
`);

export interface StoredKeySummary {
  providerId: string;
  lastFour: string;
  updatedAt: string;
}

/** AES-256-GCM vault. The user/provider tuple is authenticated as AAD. */
export const llmKeyVault = {
  set(userId: string, providerId: string, secret: string): StoredKeySummary {
    assertIdentity(userId, providerId);
    if (!secret.trim()) throw new Error("API key must not be empty");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(userId, providerId));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const timestamp = new Date().toISOString();
    authDatabase
      .prepare(
        `INSERT INTO llm_provider_keys (user_id, provider_id, iv, auth_tag, ciphertext, last_four, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider_id) DO UPDATE SET iv=excluded.iv, auth_tag=excluded.auth_tag,
      ciphertext=excluded.ciphertext, last_four=excluded.last_four, updated_at=excluded.updated_at`,
      )
      .run(
        userId,
        providerId,
        iv,
        authTag,
        ciphertext,
        secret.slice(-4),
        timestamp,
        timestamp,
      );
    return { providerId, lastFour: secret.slice(-4), updatedAt: timestamp };
  },

  get(userId: string, providerId: string): string | undefined {
    assertIdentity(userId, providerId);
    const row = authDatabase
      .prepare(
        "SELECT iv, auth_tag, ciphertext FROM llm_provider_keys WHERE user_id=? AND provider_id=?",
      )
      .get(userId, providerId) as
      | { iv: Uint8Array; auth_tag: Uint8Array; ciphertext: Uint8Array }
      | undefined;
    if (!row) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, row.iv);
    decipher.setAAD(aad(userId, providerId));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  },

  list(userId: string): StoredKeySummary[] {
    if (!userId) throw new Error("user id is required");
    return authDatabase
      .prepare(
        "SELECT provider_id, last_four, updated_at FROM llm_provider_keys WHERE user_id=? ORDER BY provider_id",
      )
      .all(userId)
      .map((row) => {
        const item = row as {
          provider_id: string;
          last_four: string;
          updated_at: string;
        };
        return {
          providerId: item.provider_id,
          lastFour: item.last_four,
          updatedAt: item.updated_at,
        };
      });
  },

  delete(userId: string, providerId: string): void {
    assertIdentity(userId, providerId);
    authDatabase
      .prepare(
        "DELETE FROM llm_provider_keys WHERE user_id=? AND provider_id=?",
      )
      .run(userId, providerId);
  },
};

function aad(userId: string, providerId: string): Buffer {
  return Buffer.from(`llm-key-v1\0${userId}\0${providerId}`, "utf8");
}
function assertIdentity(userId: string, providerId: string): void {
  if (!userId.trim() || !providerId.trim())
    throw new Error("user id and provider id are required");
}
