/**
 * Alpha DB Seed
 *
 * Idempotent startup seed:
 *   - alert_flows (ELITE, PRO, WATCH, IGNITION, WATCH_FOR_UPGRADE)
 *   - trader_config defaults (id=1)
 *   - trader_wallet defaults (id=1)
 *   - trader_buy_settings (ELITE, PRO, STANDARD, LOW)
 *   - trader_sell_strategy (2x, 3x, 5x, 10x)
 *
 * Uses INSERT OR IGNORE so existing rows are never overwritten.
 */

import { sqlite } from "./index.js";
import { logger } from "../lib/logger.js";

export function seedDatabase(): void {
  const now = Date.now();

  // ── Alert Flows ──────────────────────────────────────────────────────────────
  const flows: Array<{
    id: string;
    enabled: number;
    priority: number;
    fallback: number;
    minScore: number;
  }> = [
    { id: "ELITE",              enabled: 1, priority: 10,  fallback: 0, minScore: 0 },
    { id: "PRO",                enabled: 1, priority: 20,  fallback: 0, minScore: 0 },
    { id: "WATCH",              enabled: 1, priority: 30,  fallback: 0, minScore: 0 },
    { id: "IGNITION",           enabled: 0, priority: 5,   fallback: 0, minScore: 0 },
    { id: "WATCH_FOR_UPGRADE",  enabled: 1, priority: 97,  fallback: 0, minScore: 0 },
  ];

  const insertFlow = sqlite.prepare(
    `INSERT OR IGNORE INTO alert_flows
       (id, enabled, priority, fallback, min_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const f of flows) {
    insertFlow.run(f.id, f.enabled, f.priority, f.fallback, f.minScore, now);
  }

  // ── Trader Config ────────────────────────────────────────────────────────────
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO trader_config
         (id, auto_trading_enabled, max_active_trades, execution_mode, created_at, updated_at)
       VALUES (1, 0, 10, 'OFF', ?, ?)`
    )
    .run(now, now);

  // ── Trader Wallet ────────────────────────────────────────────────────────────
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO trader_wallet
         (id, rpc_endpoint, mev_protection, connected, created_at, updated_at)
       VALUES (1, 'https://api.mainnet-beta.solana.com', 0, 0, ?, ?)`
    )
    .run(now, now);

  // ── Trader Buy Settings ───────────────────────────────────────────────────────
  for (const [tier, amount, enabled] of [
    ["ELITE",    50.0, 1],
    ["PRO",      25.0, 0],
    ["STANDARD", 10.0, 0],
    ["LOW",       5.0, 0],
  ] as [string, number, number][]) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO trader_buy_settings
           (tier, enabled, buy_amount_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(tier, enabled, amount, now, now);
  }

  // ── Trader Sell Strategy ──────────────────────────────────────────────────────
  for (const [multiplier, sell_pct, is_moon_bag, sort_order] of [
    [2,  30, 0, 1],
    [3,  30, 0, 2],
    [5,  20, 0, 3],
    [10,  0, 1, 4],
  ] as [number, number, number, number][]) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO trader_sell_strategy
           (multiplier, sell_pct, is_moon_bag, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run(multiplier, sell_pct, is_moon_bag, sort_order, now, now);
  }

  logger.info("Alpha DB seed complete");
}
