/**
 * Simulation Analytics Engine — Phase 4B
 *
 * Computes the full suite of performance metrics from simulation history.
 * All metrics are derived from existing tables — no new data collection.
 *
 * Metrics:
 *   Win Rate, ROI (avg/median/p25/p75), Average Hold Time, Average Drawdown,
 *   Largest Winner, Largest Loser, Profit Factor, Expectancy,
 *   Max Consecutive Wins/Losses, Per-Tier breakdown.
 */

import { sqlite } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResolvedPosition {
  id:                   number;
  alert_tier:           string | null;
  status:               string;
  roi_pct:              number | null;
  realized_profit_usd:  number;
  cost_basis_usd:       number;
  entry_price_usd:      number;
  min_price_usd:        number | null;
  peak_price_usd:       number | null;
  opened_at:            number;
  closed_at:            number | null;
}

export interface TierAnalytics {
  tier:               string;
  count:              number;
  wins:               number;
  losses:             number;
  stopped:            number;
  expired:            number;
  win_rate_pct:       number | null;
  avg_roi_pct:        number | null;
  total_realized_usd: number;
}

export interface ConsecutiveStreaks {
  max_wins:       number;
  max_losses:     number;
  current_streak: number;
  streak_type:    "WIN" | "LOSS" | "NONE";
}

export interface SimulationAnalytics {
  // Counts
  total_positions:  number;
  total_resolved:   number;
  wins:             number;
  losses:           number;
  stopped:          number;
  expired:          number;
  total_open:       number;

  // Win rate (EXPIRED excluded — no clear outcome signal)
  win_rate_pct: number | null;

  // ROI distribution
  avg_roi_pct:    number | null;
  median_roi_pct: number | null;
  p25_roi_pct:    number | null;
  p75_roi_pct:    number | null;

  // Hold time
  avg_hold_hours:    number | null;
  median_hold_hours: number | null;

  // Drawdown
  avg_drawdown_pct: number | null;
  max_drawdown_pct: number | null;

  // Individual extremes
  largest_winner_pct: number | null;
  largest_loser_pct:  number | null;

  // Capital
  total_realized_usd:     number;
  total_capital_deployed: number;
  total_roi_pct:          number | null;

  // Advanced
  profit_factor:  number | null; // gross_profit / abs(gross_loss); null if no losses yet
  expectancy_usd: number | null; // expected $ per trade (avg_win × win_rate − avg_loss × loss_rate)

  // Streaks
  streaks: ConsecutiveStreaks;

  // Per-tier
  tier_breakdown: TierAnalytics[];

  generated_at: number;
}

// ── Pure math helpers ─────────────────────────────────────────────────────────

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[m - 1]! + sorted[m]!) / 2
    : sorted[m]!;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function avg(arr: number[]): number | null {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function r2(v: number | null): number | null {
  return v != null ? Math.round(v * 100) / 100 : null;
}

function computeStreaks(positions: ResolvedPosition[]): ConsecutiveStreaks {
  // Walk ascending (oldest first) to find historical max streaks
  let maxWins = 0, maxLosses = 0;
  let curWins = 0, curLosses = 0;

  for (const p of positions) {
    if (p.status === "CLOSED_WIN") {
      curWins++; curLosses = 0;
      if (curWins > maxWins) maxWins = curWins;
    } else if (p.status === "CLOSED_LOSS" || p.status === "STOPPED") {
      curLosses++; curWins = 0;
      if (curLosses > maxLosses) maxLosses = curLosses;
    }
    // EXPIRED: resets neither streak
  }

  // Current streak = walk from tail (most recent) until streak breaks
  let current = 0;
  let streakType: "WIN" | "LOSS" | "NONE" = "NONE";
  for (let i = positions.length - 1; i >= 0; i--) {
    const s = positions[i]!.status;
    if (s === "EXPIRED") continue; // skip EXPIRED when calculating current streak
    if (s === "CLOSED_WIN") {
      if (streakType === "LOSS") break;
      streakType = "WIN"; current++;
    } else if (s === "CLOSED_LOSS" || s === "STOPPED") {
      if (streakType === "WIN") break;
      streakType = "LOSS"; current++;
    }
  }

  return { max_wins: maxWins, max_losses: maxLosses, current_streak: current, streak_type: streakType };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeSimulationAnalytics(): SimulationAnalytics {
  const allPositions = sqlite
    .prepare(`
      SELECT id, alert_tier, status, roi_pct, realized_profit_usd, cost_basis_usd,
             entry_price_usd, min_price_usd, peak_price_usd, opened_at, closed_at
        FROM trader_sim_positions
       ORDER BY COALESCE(closed_at, opened_at) ASC
    `)
    .all() as ResolvedPosition[];

  const openCount = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM trader_sim_positions WHERE status = 'OPEN'").get() as { n: number }
  ).n;

  const nonOpen  = allPositions.filter(p => p.status !== "OPEN");
  const wins     = nonOpen.filter(p => p.status === "CLOSED_WIN");
  const losses   = nonOpen.filter(p => p.status === "CLOSED_LOSS");
  const stopped  = nonOpen.filter(p => p.status === "STOPPED");
  const expired  = nonOpen.filter(p => p.status === "EXPIRED");
  const resolved = wins.length + losses.length + stopped.length; // EXPIRED excluded from rate

  // Win rate
  const winRate = resolved > 0 ? r2(wins.length / resolved * 100) : null;

  // ROI array (sorted)
  const roisAsc = nonOpen
    .map(p => p.roi_pct)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  // Hold times in hours (closed positions only)
  const holdHrs = nonOpen
    .filter(p => p.closed_at != null)
    .map(p => (p.closed_at! - p.opened_at) / 3_600_000)
    .sort((a, b) => a - b);

  // Drawdown % = (entry − min) / entry × 100
  const drawdownPcts = nonOpen
    .filter(p => p.min_price_usd != null && p.entry_price_usd > 0)
    .map(p => (p.entry_price_usd - p.min_price_usd!) / p.entry_price_usd * 100)
    .sort((a, b) => a - b);

  // Gross profit / loss
  const grossProfit = nonOpen
    .filter(p => p.realized_profit_usd > 0)
    .reduce((s, p) => s + p.realized_profit_usd, 0);
  const grossLoss = Math.abs(
    nonOpen
      .filter(p => p.realized_profit_usd < 0)
      .reduce((s, p) => s + p.realized_profit_usd, 0)
  );
  const profitFactor = grossLoss > 0 ? r2(grossProfit / grossLoss) : null;

  // Expectancy = winRate × avgWin − lossRate × avgLoss (per trade, in USD)
  const avgWinUsd = wins.length > 0
    ? wins.reduce((s, p) => s + p.realized_profit_usd, 0) / wins.length
    : 0;
  const losers = [...losses, ...stopped];
  const avgLossUsd = losers.length > 0
    ? Math.abs(losers.reduce((s, p) => s + p.realized_profit_usd, 0) / losers.length)
    : 0;
  const expectancyUsd = resolved > 0
    ? r2((wins.length / resolved) * avgWinUsd - (losers.length / resolved) * avgLossUsd)
    : null;

  // Capital
  const totalDeployed = nonOpen.reduce((s, p) => s + p.cost_basis_usd, 0);
  const totalRealized = nonOpen.reduce((s, p) => s + p.realized_profit_usd, 0);
  const totalRoi      = totalDeployed > 0 ? r2(totalRealized / totalDeployed * 100) : null;

  // Per-tier breakdown
  const tierMap = new Map<string, ResolvedPosition[]>();
  for (const p of nonOpen) {
    const t = p.alert_tier ?? "UNKNOWN";
    if (!tierMap.has(t)) tierMap.set(t, []);
    tierMap.get(t)!.push(p);
  }
  const tierBreakdown: TierAnalytics[] = [];
  for (const [tier, rows] of tierMap) {
    const tw  = rows.filter(r => r.status === "CLOSED_WIN").length;
    const tl  = rows.filter(r => r.status === "CLOSED_LOSS").length;
    const ts_ = rows.filter(r => r.status === "STOPPED").length;
    const te  = rows.filter(r => r.status === "EXPIRED").length;
    const tr  = tw + tl + ts_;
    const trois = rows.map(r => r.roi_pct).filter((v): v is number => v != null);
    tierBreakdown.push({
      tier, count: rows.length,
      wins: tw, losses: tl, stopped: ts_, expired: te,
      win_rate_pct: tr > 0 ? r2(tw / tr * 100) : null,
      avg_roi_pct:  trois.length > 0 ? r2(trois.reduce((s, v) => s + v, 0) / trois.length) : null,
      total_realized_usd: rows.reduce((s, r) => s + r.realized_profit_usd, 0),
    });
  }
  tierBreakdown.sort((a, b) => b.count - a.count);

  return {
    total_positions: allPositions.length,
    total_resolved:  nonOpen.length,
    wins:            wins.length,
    losses:          losses.length,
    stopped:         stopped.length,
    expired:         expired.length,
    total_open:      openCount,
    win_rate_pct:    winRate,
    avg_roi_pct:     roisAsc.length > 0 ? r2(roisAsc.reduce((s, v) => s + v, 0) / roisAsc.length) : null,
    median_roi_pct:  r2(median(roisAsc)),
    p25_roi_pct:     r2(percentile(roisAsc, 25)),
    p75_roi_pct:     r2(percentile(roisAsc, 75)),
    avg_hold_hours:  r2(avg(holdHrs)),
    median_hold_hours: r2(median([...holdHrs].sort((a, b) => a - b))),
    avg_drawdown_pct:  r2(avg(drawdownPcts)),
    max_drawdown_pct:  drawdownPcts.length > 0 ? r2(drawdownPcts[drawdownPcts.length - 1]!) : null,
    largest_winner_pct: roisAsc.length > 0 ? r2(roisAsc[roisAsc.length - 1]!) : null,
    largest_loser_pct:  roisAsc.length > 0 ? r2(roisAsc[0]!) : null,
    total_realized_usd:     r2(totalRealized) ?? 0,
    total_capital_deployed: r2(totalDeployed) ?? 0,
    total_roi_pct:          totalRoi,
    profit_factor:          profitFactor,
    expectancy_usd:         expectancyUsd,
    streaks: computeStreaks(allPositions),
    tier_breakdown: tierBreakdown,
    generated_at: Date.now(),
  };
}
