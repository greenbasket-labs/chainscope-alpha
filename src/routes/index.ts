/**
 * Alpha API — Route registry
 *
 * All routes are mounted at /api (handled in app.ts).
 * Route files use paths without the /api prefix.
 */

import { type Express } from "express";

import healthRouter      from "./health.js";
import alphaRouter       from "./alpha.js";
import settingsRouter    from "./settings.js";
import traderRouter      from "./trader.js";
import eliteFilterRouter from "./eliteFilter.js";

export function registerRoutes(app: Express): void {
  // Health (no /api prefix — for Render health checks)
  app.use("/", healthRouter);

  // All API routes under /api
  app.use("/api", alphaRouter);
  app.use("/api", settingsRouter);
  app.use("/api", traderRouter);
  app.use("/api", eliteFilterRouter);
}
