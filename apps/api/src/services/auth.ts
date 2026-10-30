import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { env } from "../config/env.js";

const defaultDatabasePath =
  env.NODE_ENV === "test"
    ? path.join(
        os.tmpdir(),
        `invideo-test-${process.env.VITEST_WORKER_ID ?? process.pid}.sqlite`,
      )
    : path.resolve(process.cwd(), "data", "invideo.sqlite");
const databasePath = env.LLM_DATABASE_PATH ?? defaultDatabasePath;
mkdirSync(path.dirname(databasePath), { recursive: true });
export const authDatabase = new DatabaseSync(databasePath);

const authOptions = {
  database: authDatabase,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN],
  emailAndPassword: { enabled: true, requireEmailVerification: false },
};
export const auth = betterAuth(authOptions);
export const authReady = getMigrations(authOptions).then(({ runMigrations }) =>
  runMigrations(),
);
