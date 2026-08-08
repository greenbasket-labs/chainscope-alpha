/**
 * Simulation Position Tracker
 *
 * Subscribes to the Market Observation Bus. On every price update:
 *
 *   1. Update last_price_usd / peak_price_usd / min_price_usd / unrealized_pnl
 *   2. Stop loss check — if price ≤ entry × (1 − stop_loss_pct%), force-exit STOPPED
 *   3. Sell strategy milestones — if price ≥ entry × multiplier, execute partial sell
 *      (or moon-bag hold for the final milestone)
 *   4. Close position when all tokens sold or moon-bag milestone hit
 *
 * NEVER submits any blockchain transaction.
 * NEVER modifies real wallet balances.
 */

import { sqlite } from "../db/index.js";
import { marketBus, type MarketObservation } from "../marketBus/index.js";
import { logger } from "../lib/logger.js";
import { getTpLadderForProfile } from "../eliteFilter/db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SimPosition {
  id:                   number;
  sim_log_id:           number;
  token_address:        string;
  token_symbol:         string | null;
  alert_tier:           string | null;
  entry_price_usd:      number;
  buy_amount_usd:       number;
  tokens_purchased:     number;
  tokens_remaining:     number;
  cost_basis_usd:       number;
  realized_profit_usd:  number;
  peak_price_usd:       number | null;
  last_price_usd:       number | null;
  min_price_usd:        number | null;
  milestones_hit:       string; // JSON array of multipliers
  opened_at:            number;
  filter_profile_id:    string | null; // v53 — profile that owns this position's TP ladder
}

interface SellMilestone {
  id:          number;
  multiplier:  number;
  sell_pct:    number;
  is_moon_bag: number; // 0/1
  enabled:     number;
  sort_order:  number;
}

// ── Stop loss ─────────────────────────────────────────────────────────────────

/**
 * Apply stop loss. Returns true if the position was closed.
 * stop_loss_pct = 90 means "exit if price drops 90% from entry".
 */
function applyStopLoss(position: SimPosition, currentPrice: number, stopLossPct: number): boolean {
  if (stopLossPct <= 0 || stopLossPct >= 100) return false;

  const stopTrigger = position.entry_price_usd * (1 - stopLossPct / 100);
  if (currentPrice > stopTrigger) return false;

  const now              = Date.now();
  const tokensSold       = position.tokens_remaining;
  const proceedsUsd      = tokensSold * currentPrice;
  const costBasisSold    = position.cost_basis_usd; // exiting all remaining
  const profitUsd        = proceedsUsd - costBasisSold;
  // Add any previously realized profit from partial sells
  const totalRealized    = position.realized_profit_usd + profitUsd;
  const roiPct           = (totalRealized / position.cost_basis_usd) * 100;

  // Record exit
  sqlite
    .prepare(
      `INSERT INTO trader_sim_exits
         (position_id, milestone_x, exit_price_usd, tokens_sold, proceeds_usd,
          cost_basis_usd, profit_usd, is_moon_bag, executed_at)
       VALUES (?, 0, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(position.id, currentPrice, tokensSold, proceedsUsd, costBasisSold, profitUsd, now);

  // Close position
  sqlite
    .prepare(
      `UPDATE trader_sim_positions
          SET tokens_remaining    = 0,
              realized_profit_usd = ?,
              unrealized_pnl_usd  = 0,
              last_price_usd      = ?,
              roi_pct             = ?,
              status              = 'STOPPED',
              closed_at           = ?,
              last_updated_at     = ?
        WHERE id = ?`
    )
    .run(totalRealized, currentPrice, roiPct, now, now, position.id);

  sqlite
    .prepare("UPDATE trader_simulation_log SET status = 'STOPPED' WHERE id = ?")
    .run(position.sim_log_id);

  logger.info(
    {
      positionId:   position.id,
      tokenSymbol:  position.token_symbol,
      currentPrice,
      stopTrigger,
      entryPrice:   position.entry_price_usd,
      profitUsd:    profitUsd.toFixed(2),
    },
    "[position-tracker] STOPPED — stop loss triggered"
  );
  return true;
}

// ── Sell milestone logic ──────────────────────────────────────────────────────

function applyMilestones(position: SimPosition, currentPrice: number): void {
  let milestonesHit: number[];
  try {
    milestonesHit = JSON.parse(position.milestones_hit ?? "[]") as number[];
    if (!Array.isArray(milestonesHit)) milestonesHit = [];
  } catch {
    logger.warn({ positionId: position.id }, "[position-tracker] milestones_hit parse failed — treating as empty");
    milestonesHit = [];
  }

  // v53: use the per-profile TP ladder when the position has a profile attached.
  // Fall back to the global trader_sell_strategy table for legacy positions.
  const milestones: SellMilestone[] = position.filter_profile_id
    ? (getTpLadderForProfile(position.filter_profile_id) as SellMilestone[])
    : (sqlite
        .prepare(
          `SELECT id, multiplier, sell_pct, is_moon_bag, enabled, sort_order
             FROM trader_sell_strategy
            WHERE enabled = 1
            ORDER BY sort_order ASC, multiplier ASC`
        )
        .all() as SellMilestone[]);

  if (milestones.length === 0) return;

  let tokensRemaining = position.tokens_remaining;
  let realizedProfit  = position.realized_profit_usd;
  let dirty           = false;
  let closePosition   = false;
  let closedAt: number | null = null;

  const now = Date.now();

  for (const ms of milestones) {
    if (milestonesHit.includes(ms.multiplier)) continue;

    const triggerPrice = position.entry_price_usd * ms.multiplier;
    if (currentPrice < triggerPrice) continue;

    // ── Moon bag ────────────────────────────────────────────────────────────
    if (ms.is_moon_bag) {
      milestonesHit.push(ms.multiplier);
      dirty         = true;
      closePosition = true;
      closedAt      = now;

      sqlite
        .prepare(
          `INSERT INTO trader_sim_exits
             (position_id, milestone_x, exit_price_usd, tokens_sold, proceeds_usd,
              cost_basis_usd, profit_usd, is_moon_bag, executed_at)
           VALUES (?, ?, ?, 0, 0, 0, 0, 1, ?)`
        )
        .run(position.id, ms.multiplier, currentPrice, now);

      logger.info(
        { positionId: position.id, tokenSymbol: position.token_symbol, multiplier: ms.multiplier, tokensRemaining },
        "[position-tracker] MOON BAG — holding remaining tokens"
      );
      break;
    }

    // ── Partial sell ─────────────────────────────────────────────────────────
    const sellFraction  = ms.sell_pct / 100;
    const tokensSold    = tokensRemaining * sellFraction;
    if (tokensSold <= 0) continue;

    const proceedsUsd   = tokensSold * currentPrice;
    const costBasisSold = (tokensSold / position.tokens_purchased) * position.cost_basis_usd;
    const profitUsd     = proceedsUsd - costBasisSold;

    tokensRemaining -= tokensSold;
    realizedProfit  += profitUsd;
    milestonesHit.push(ms.multiplier);
    dirty = true;

    sqlite
      .prepare(
        `INSERT INTO trader_sim_exits
           (position_id, milestone_x, exit_price_usd, tokens_sold, proceeds_usd,
            cost_basis_usd, profit_usd, is_moon_bag, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(position.id, ms.multiplier, currentPrice, tokensSold, proceedsUsd, costBasisSold, profitUsd, now);

    logger.info(
      {
        positionId:   position.id,
        tokenSymbol:  position.token_symbol,
        multiplier:   ms.multiplier,
        currentPrice,
        tokensSold:   Math.round(tokensSold),
        proceedsUsd:  proceedsUsd.toFixed(2),
        profitUsd:    profitUsd.toFixed(2),
        tokensRemaining: Math.round(tokensRemaining),
      },
      "[position-tracker] milestone hit — simulated partial sell"
    );

    // All tokens sold?
    if (tokensRemaining < position.tokens_purchased * 0.00001) {
      closePosition = true;
      closedAt      = now;
      break;
    }
  }

  if (!dirty) return;

  const roiPct = (realizedProfit / position.cost_basis_usd) * 100;

  if (closePosition) {
    const status = realizedProfit >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
    sqlite
      .prepare(
        `UPDATE trader_sim_positions
            SET tokens_remaining    = ?,
                realized_profit_usd = ?,
                unrealized_pnl_usd  = 0,
                last_price_usd      = ?,
                peak_price_usd      = MAX(COALESCE(peak_price_usd, 0), ?),
                roi_pct             = ?,
                status              = ?,
                milestones_hit      = ?,
                closed_at           = ?,
                last_updated_at     = ?
          WHERE id = ?`
      )
      .run(tokensRemaining, realizedProfit, currentPrice, currentPrice, roiPct, status,
           JSON.stringify(milestonesHit), closedAt, now, position.id);

    sqlite
      .prepare("UPDATE trader_simulation_log SET status = 'CLOSED' WHERE id = ?")
      .run(position.sim_log_id);

    logger.info(
      { positionId: position.id, tokenSymbol: position.token_symbol, status, realizedProfit, roiPct },
      "[position-tracker] position closed"
    );
  } else {
    const unrealizedPnl = tokensRemaining * currentPrice
      - (tokensRemaining / position.tokens_purchased) * position.cost_basis_usd;

    sqlite
      .prepare(
        `UPDATE trader_sim_positions
            SET tokens_remaining    = ?,
                realized_profit_usd = ?,
                unrealized_pnl_usd  = ?,
                last_price_usd      = ?,
                peak_price_usd      = MAX(COALESCE(peak_price_usd, 0), ?),
                roi_pct             = ?,
                milestones_hit      = ?,
                last_updated_at     = ?
          WHERE id = ?`
      )
      .run(tokensRemaining, realizedProfit, unrealizedPnl, currentPrice, currentPrice,
           roiPct, JSON.stringify(milestonesHit), now, position.id);
  }
}

// ── Market observation handler ────────────────────────────────────────────────

function handleObservation(obs: MarketObservation): void {
  if (!obs.price_usd) return;
  const price = parseFloat(obs.price_usd);
  if (!isFinite(price) || price <= 0) return;

  const positions = sqlite
    .prepare(
      `SELECT * FROM trader_sim_positions
        WHERE token_address = ? AND status = 'OPEN'`
    )
    .all(obs.token_address) as SimPosition[];

  if (positions.length === 0) return;

  // Read stop loss config once per observation (SQLite is synchronous + fast)
  const cfgRow = sqlite
    .prepare("SELECT stop_loss_pct FROM trader_config WHERE id = 1")
    .get() as { stop_loss_pct: number } | undefined;
  const stopLossPct = cfgRow?.stop_loss_pct ?? 90;

  const now = Date.now();

  for (const pos of positions) {
    try {
      // 1. Update price tracking (always, even if no milestone fires)
      sqlite
        .prepare(
          `UPDATE trader_sim_positions
              SET last_price_usd     = ?,
                  peak_price_usd     = MAX(COALESCE(peak_price_usd, 0), ?),
                  min_price_usd      = MIN(COALESCE(min_price_usd, ?), ?),
                  unrealized_pnl_usd = (? - entry_price_usd) / entry_price_usd * cost_basis_usd,
                  last_updated_at    = ?
            WHERE id = ?`
        )
        .run(price, price, price, price, price, now, pos.id);

      // 1b. Record price history snapshot (Phase 4C — Trade Replay)
      try {
        sqlite
          .prepare(
            `INSERT INTO trader_sim_price_history (position_id, price_usd, market_cap_usd, observed_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(pos.id, price, obs.market_cap ?? null, now);
      } catch {
        // Non-fatal: history may be missing if migration hasn't run yet
      }

      // Reload with updated peak/min for accurate milestone calc
      const fresh = sqlite
        .prepare("SELECT * FROM trader_sim_positions WHERE id = ?")
        .get(pos.id) as SimPosition;

      // 2. Stop loss check (before milestones)
      if (applyStopLoss(fresh, price, stopLossPct)) continue;

      // 3. Milestone check
      applyMilestones(fresh, price);
    } catch (err) {
      logger.error({ err, positionId: pos.id }, "[position-tracker] error — non-fatal");
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startPositionTracker(): void {
  marketBus.subscribe(handleObservation);
  logger.info("[position-tracker] subscribed to market bus — stop loss + milestones active");
}
