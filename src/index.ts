/**
 * Alpha API — Entry Point
 *
 * Boot sequence:
 *   1. Run DB migration (creates all tables if not exists)
 *   2. Seed DB defaults (alert_flows, trader_config, etc.)
 *   3. Register market-bus subscribers (positionTracker, liveSellTracker)
 *   4. Start simulation engine (subscribes to alertBus)
 *   5. Start MINTLINE bridge (disabled unless explicitly enabled)
 *   6. Start DexScreener poller
 *   7. Start HTTP server
 */

import { runMigration } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { startPoller } from "./dexscreener/poller.js";
import { startMintlineBridge } from "./trader/mintlineBridge.js";

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  logger.info("Alpha API booting…");

  // 1. Schema
  runMigration();

  // 2. Seed
  seedDatabase();

  // 3. Start simulation engine (subscribes to alertBus)
  const { startSimulationEngine } = await import("./trader/simulationEngine.js");
  startSimulationEngine();

  // 4. Market bus subscribers
  const { startPositionTracker } = await import("./trader/positionTracker.js");
  startPositionTracker();

  const { startLiveSellTracker } = await import("./trader/liveSellTracker.js");
  startLiveSellTracker();

  // 5. Start MINTLINE bridge (disabled unless explicitly enabled)
  startMintlineBridge();

  // 6. DexScreener poller
  startPoller();

  // 7. HTTP server
  const app  = createApp();
  const port = parseInt(process.env.PORT ?? "3001", 10);

  app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Alpha API listening");
  });
}

boot().catch((err) => {
  logger.error({ err }, "Alpha API boot failed");
  process.exit(1);
});
