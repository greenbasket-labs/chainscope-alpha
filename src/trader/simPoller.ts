/**
 * Simulation Position Poller
 *
 * Runs every 5 minutes:
 *  1. Fetches current market prices for all OPEN positions.
 *     fetchMarketData() publishes to the market bus, which triggers
 *     positionTracker's stop-loss + milestone checks automatically.
 *  2. Expires positions that have been OPEN longer than max_position_age_hours.
 *     Force-sells remaining tokens at the last known price, marks EXPIRED.
 *
 * NEVER submits any blockchain transaction.
 */

import { sqlite } from "../db/index.js";
import { fetchMarketData } from "../market/client.js";
import { logger } from "../lib/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS    = 5 * 60_000;  // 5 minutes
const INTER_REQUEST_MS    = 300;          // 300 ms between DexScreener calls
const MAX_POSITIONS_BATCH = 20;           // max tokens per tick

let timer: ReturnType<typeof setInterval> | null = null;

// ── Types ─────────────────────────────────────────────────────────────────────

interface StalePosition {
  id:                   number;
  sim_log_id:           number;
  token_symbol:         string | null;
  token_address:        string;
  tokens_purchased:     number;
  tokens_remaining:     number;
  cost_basis_usd:       number;
  realized_profit_usd:  number;
  last_price_usd:       number | null;
  entry_price_usd:      number;
  opened_at:            number;
}

// ── EXPIRED cleanup ───────────────────────────────────────────────────────────

function expireStalePositions(cutoffMs: number): void {
  const stale = sqlite
    .prepare(
      `SELECT id, sim_log_id, token_symbol, token_address,
              tokens_purchased, tokens_remaining,
              cost_basis_usd, realized_profit_usd,
              last_price_usd, entry_price_usd, opened_at
         FROM trader_sim_positions
        WHERE status = 'OPEN' AND opened_at < ?`
    )
    .all(cutoffMs) as StalePosition[];

  if (stale.length === 0) return;

  const now = Date.now();

  for (const pos of stale) {
    try {
      // Use last known price; fall back to entry price if never updated
      const exitPrice = pos.last_price_usd ?? pos.entry_price_usd;
      // Cost basis proportional to remaining tokens
      const remainingCostBasis = (pos.tokens_remaining / pos.tokens_purchased) * pos.cost_basis_usd;
      const proceedsUsd        = pos.tokens_remaining * exitPrice;
      const profitUsd          = proceedsUsd - remainingCostBasis;
      // Include any already-realized profit from earlier partial sells
      const totalRealized      = pos.realized_profit_usd + profitUsd;
      const roiPct             = (totalRealized / pos.cost_basis_usd) * 100;
      const ageHours           = (now - pos.opened_at) / 3_600_000;

      // Record a forced exit in trader_sim_exits (milestone_x = 0 = forced)
      if (pos.tokens_remaining > 0) {
        sqlite
          .prepare(
            `INSERT INTO trader_sim_exits
               (position_id, milestone_x, exit_price_usd, tokens_sold, proceeds_usd,
                cost_basis_usd, profit_usd, is_moon_bag, executed_at)
             VALUES (?, 0, ?, ?, ?, ?, ?, 0, ?)`
          )
          .run(pos.id, exitPrice, pos.tokens_remaining, proceedsUsd, remainingCostBasis, profitUsd, now);
      }

      // Close position as EXPIRED
      sqlite
        .prepare(
          `UPDATE trader_sim_positions
              SET tokens_remaining    = 0,
                  realized_profit_usd = ?,
                  unrealized_pnl_usd  = 0,
                  roi_pct             = ?,
                  status              = 'EXPIRED',
                  closed_at           = ?,
                  last_updated_at     = ?
            WHERE id = ?`
        )
        .run(totalRealized, roiPct, now, now, pos.id);

      sqlite
        .prepare("UPDATE trader_simulation_log SET status = 'EXPIRED' WHERE id = ?")
        .run(pos.sim_log_id);

      logger.info(
        {
          positionId:  pos.id,
          tokenSymbol: pos.token_symbol,
          ageHours:    ageHours.toFixed(1),
          exitPrice,
          profitUsd:   profitUsd.toFixed(2),
          totalRealized: totalRealized.toFixed(2),
        },
        "[sim-poller] EXPIRED — position exceeded max age"
      );
    } catch (err) {
      logger.error({ err, positionId: pos.id }, "[sim-poller] expiry error — non-fatal");
    }
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  // ── 1. Price fetch for open positions ─────────────────────────────────────
  const openPositions = sqlite
    .prepare(
      `SELECT DISTINCT token_address
         FROM trader_sim_positions
        WHERE status = 'OPEN'
        LIMIT ?`
    )
    .all(MAX_POSITIONS_BATCH) as { token_address: string }[];

  if (openPositions.length > 0) {
    logger.debug(
      { count: openPositions.length },
      "[sim-poller] fetching prices for open sim positions"
    );
    for (const { token_address } of openPositions) {
      try {
        await fetchMarketData(token_address);
      } catch (err) {
        logger.debug({ err, token_address }, "[sim-poller] price fetch error — non-fatal");
      }
      await new Promise<void>((r) => setTimeout(r, INTER_REQUEST_MS));
    }
  }

  // ── 2. Expire stale positions ─────────────────────────────────────────────
  const cfgRow = sqlite
    .prepare("SELECT max_position_age_hours FROM trader_config WHERE id = 1")
    .get() as { max_position_age_hours: number } | undefined;
  const maxAgeMs = ((cfgRow?.max_position_age_hours ?? 24)) * 3_600_000;
  expireStalePositions(Date.now() - maxAgeMs);
}

// ── Startup / shutdown ────────────────────────────────────────────────────────

export function startSimPoller(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  logger.info("[sim-poller] started (5-min interval, max 20 positions/tick, expiry active)");
}

export function stopSimPoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
