import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";

export function createApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

export const app: Express = createApp();
