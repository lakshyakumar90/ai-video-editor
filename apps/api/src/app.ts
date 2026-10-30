import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { env } from "./config/env.js";

export function createApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN }));
  // All request/response logging flows through the redacted logger; a
  // header or body carrying a secret can never be written to the logs.
  app.use(pinoHttp({ logger }));
  app.use(express.json());

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
