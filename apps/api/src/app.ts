import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { uploadsRouter } from "./routes/uploads.js";
import { logger } from "./lib/logger.js";
import { env } from "./config/env.js";
import { toNodeHandler } from "better-auth/node";
import { auth, authReady } from "./services/auth.js";
import { providersRouter } from "./routes/providers.js";
import { llmRouter } from "./routes/llm.js";

/**
 * JSON payloads are small by design (prompts, edit instructions,
 * preferences). Large uploads must use the dedicated `/api/uploads`
 * route instead; the small limit keeps a large body from ever
 * reaching the JSON parser.
 */
const JSON_BODY_LIMIT = "100kb";

export function createApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN }));
  // All request/response logging flows through the redacted logger; a
  // header or body carrying a secret can never be written to the logs.
  app.use(pinoHttp({ logger }));
  const authHandler = toNodeHandler(auth);
  app.all("/api/auth/*splat", async (req, res, next) => {
    try {
      await authReady;
      authHandler(req, res);
    } catch (error) {
      next(error);
    }
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use("/api/providers", providersRouter());
  app.use("/api/llm", llmRouter());

  // Large uploads (raw footage, audio) stream straight to disk with
  // their own byte cap (UPLOAD_MAX_BYTES), not through express.json.
  app.use("/api/uploads", uploadsRouter());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // 404 handler for unmatched routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { message: "Not Found" } });
  });

  // Central error middleware
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: unknown }).status) || 500
        : 500;
    const message =
      err instanceof Error ? err.message : "Internal Server Error";
    res.status(status).json({ error: { message } });
  });

  return app;
}

export const app: Express = createApp();
