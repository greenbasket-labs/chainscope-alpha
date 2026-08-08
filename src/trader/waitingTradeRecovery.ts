/**
 * WAITING Trade Startup Recovery
 *
 * If the server crashes after inserting a WAITING row (pre-BUY) but before
 * the transaction confirms (OPEN update), the trade is permanently orphaned —
 * invisible to the sell tracker and queue pages.
 *
 * On every startup this function scans for stale WAITING trades and marks them
 * FAILED so they appear correctly in trade history.
 *
 * Threshold: 5 minutes (300,000 ms).  The full confirm loop is ≤ 90 s, so any
 * WAITING trade older than 5 minutes was definitely abandoned.
 *
 * Idempotent — only operates on rows WHERE status = 'WAITING'.
 * OPEN and CLOSED rows are never touched.
 */

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";

const WAITING_EXPIRY_MS = 5 * 60 * 1_000; // 5 minutes

export function recoverWaitingTrades(): void {
  const threshold = Date.now() - WAITING_EXPIRY_MS;

  const stale = sqlite
    .prepare(
      `SELECT id, created_at, token_address
         FROM trader_trades
        WHERE status = 'WAITING'
          AND created_at < ?`
    )
    .all(threshold) as { id: number; created_at: number; token_address: string }[];

  if (stale.length === 0) {
    logger.info("[startup] WAITING trade recovery: no stale trades found.");
    return;
  }

  const now = Date.now();

  const updateStmt = sqlite.prepare(
    `UPDATE trader_trades
        SET status     = 'FAILED',
            last_error = ?,
            updated_at = ?
      WHERE id = ?
        AND status = 'WAITING'`   // double-guard: idempotent even on concurrent call
  );

  const recover = sqlite.transaction(() => {
    for (const row of stale) {
      const ageMinutes = ((now - row.created_at) / 60_000).toFixed(1);
      const changes = updateStmt.run(
        `Recovered on startup — WAITING trade expired after ${ageMinutes}m without confirmation`,
        now,
        row.id,
      ).changes;
      if (changes > 0) {
        logger.warn(
          { tradeId: row.id, tokenAddress: row.token_address, ageMinutes },
          "[startup] WAITING trade recovered → FAILED",
        );
      }
    }
  });

  recover();
  logger.info({ recovered: stale.length }, "[startup] WAITING trade recovery complete.");
}
