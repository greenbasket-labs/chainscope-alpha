/**
 * Alpha API — Express Application
 *
 * Configures middleware and mounts all API routes.
 * Served by index.ts (local dev) or process-manager.ts (production).
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { registerRoutes } from "./routes/index.js";
import { logger } from "./lib/logger.js";

export function createApp(): express.Express {
  const app = express();

  // ── Middleware ───────────────────────────────────────────────────────────────
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  // CORS — allow all origins in dev; restrict in production via Render env
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const origin = process.env.ALLOWED_ORIGIN ?? "*";
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request logging (dev only)
  if (process.env.NODE_ENV !== "production") {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug({ method: req.method, path: req.path }, "→");
      next();
    });
  }

  // ── Routes ───────────────────────────────────────────────────────────────────
  registerRoutes(app);

  // ── 404 ───────────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // ── Error handler ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  return app;
}
