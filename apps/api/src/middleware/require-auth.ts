import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth, authReady } from "../services/auth.js";

declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

/** Establish identity only from a verified Better Auth session cookie. */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await authReady;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user?.id) {
      res.status(401).json({ error: { message: "Authentication required" } });
      return;
    }
    req.authUserId = session.user.id;
    next();
  } catch (error) {
    next(error);
  }
}
