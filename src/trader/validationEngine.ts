/**
 * Simulation Validation Engine — Phase 4D
 *
 * Per-tier continuous evaluation. Computes: win rate, average ROI, failure rate,
 * time to ATH, time to 2×, time to stop. Produces prioritised recommendations
 * for threshold improvements.
 *
 * Pure computation from existing tables. NEVER modifies settings automatically.
 */

import { sqlite } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PositionRow {
  id:                  number;
  alert_tier:          string | null;
  status:              string;
  roi_pct:             number | null;
  realized_profit_usd: number;
  cost_basis_usd:      number;
  entry_price_usd:     number;
  peak_price_usd:      number | null;
  min_price_usd:       number | null;
  opened_at:           number;
  closed_at:           number | null;
}

interface ExitRow {
  position_id: number;
  milestone_x: number;
  executed_at: number;
  is_moon_bag: number;
}

export interface TierValidationMetrics {
  tier:                    string;
  total:                   number;
  wins:                    number;
  losses:                  number;
  stopped:                 number;
  expired:                 number;
  win_rate_pct:            number | null;
  failure_rate_pct:        number | null; // (losses + stopped) / total
  avg_roi_pct:             number | null;
  median_roi_pct:          number | null;
  avg_time_to_2x_hours:    number | null; // time from open → first exit at milestone ≥ 2×
  median_time_to_2x_hours: number | null;
  avg_time_to_stop_hours:  number | null; // duration for STOPPED positions
  avg_time_to_ath_hours:   number | null; // approx time open → peak (winning positions)
  avg_hold_hours:          number | null;
}

export interface ValidationRecommendation {
  tier:          string;
  metric:        string;
  current_value: string;
  suggestion:    string;
  impact:        "HIGH" | "MEDIUM" | "LOW";
}

export interface ValidationReport {
  tiers:                 TierValidationMetrics[];
  recommendations:       ValidationRecommendation[];
  overall_win_rate_pct:  number | null;
  best_tier:             string | null;
  worst_tier:            string | null;
  total_positions:       number;
  generated_at:          number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr: number[]): number | null {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function medianOf(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

function r2(v: number | null): number | null {
  return v != null ? Math.round(v * 100) / 100 : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeValidationReport(): ValidationReport {
  const positions = sqlite
    .prepare(`
      SELECT id, alert_tier, status, roi_pct, realized_profit_usd, cost_basis_usd,
             entry_price_usd, peak_price_usd, min_price_usd, opened_at, closed_at
        FROM trader_sim_positions
       ORDER BY COALESCE(closed_at, opened_at) ASC
    `)
    .all() as PositionRow[];

  // Build first-2× exit map: position_id → executed_at
  const allExits = sqlite
    .prepare(`
      SELECT position_id, milestone_x, executed_at, is_moon_bag
        FROM trader_sim_exits
       WHERE is_moon_bag = 0 AND milestone_x >= 2
       ORDER BY executed_at ASC
    `)
    .all() as ExitRow[];

  const first2xAt = new Map<number, number>();
  for (const e of allExits) {
    if (!first2xAt.has(e.position_id)) first2xAt.set(e.position_id, e.executed_at);
  }

  // Group by tier
  const tierMap = new Map<string, PositionRow[]>();
  for (const p of positions) {
    const t = p.alert_tier ?? "UNKNOWN";
    if (!tierMap.has(t)) tierMap.set(t, []);
    tierMap.get(t)!.push(p);
  }

  const tierMetrics: TierValidationMetrics[] = [];

  for (const [tier, rows] of tierMap) {
    const wins    = rows.filter(r => r.status === "CLOSED_WIN");
    const losses  = rows.filter(r => r.status === "CLOSED_LOSS");
    const stopped = rows.filter(r => r.status === "STOPPED");
    const expired = rows.filter(r => r.status === "EXPIRED");
    const resolved = wins.length + losses.length + stopped.length;

    const rois     = rows.map(r => r.roi_pct).filter((v): v is number => v != null).sort((a, b) => a - b);
    const holdHrs  = rows.filter(r => r.closed_at != null).map(r => (r.closed_at! - r.opened_at) / 3_600_000);

    // Time to 2×
    const t2x = rows
      .filter(r => first2xAt.has(r.id))
      .map(r => (first2xAt.get(r.id)! - r.opened_at) / 3_600_000)
      .filter(v => v > 0);

    // Time to stop
    const tStop = stopped
      .filter(r => r.closed_at != null)
      .map(r => (r.closed_at! - r.opened_at) / 3_600_000);

    // Time to ATH (approx): for winning positions that closed, time from open → close.
    // With price history this would be exact; without it we use the close time of
    // winners as an upper bound (ATH was hit at or before close).
    const tAth = wins
      .filter(r => r.closed_at != null && r.peak_price_usd != null && r.peak_price_usd > r.entry_price_usd)
      .map(r => (r.closed_at! - r.opened_at) / 3_600_000);

    tierMetrics.push({
      tier,
      total:    rows.length,
      wins:     wins.length,
      losses:   losses.length,
      stopped:  stopped.length,
      expired:  expired.length,
      win_rate_pct:            resolved > 0 ? r2(wins.length / resolved * 100) : null,
      failure_rate_pct:        rows.length > 0 ? r2((losses.length + stopped.length) / rows.length * 100) : null,
      avg_roi_pct:             r2(avg(rois)),
      median_roi_pct:          r2(medianOf(rois)),
      avg_time_to_2x_hours:    r2(avg(t2x)),
      median_time_to_2x_hours: r2(medianOf(t2x)),
      avg_time_to_stop_hours:  r2(avg(tStop)),
      avg_time_to_ath_hours:   r2(avg(tAth)),
      avg_hold_hours:          r2(avg(holdHrs)),
    });
  }

  tierMetrics.sort((a, b) => b.total - a.total);

  // Overall win rate
  const allResolved = positions.filter(p => ["CLOSED_WIN","CLOSED_LOSS","STOPPED"].includes(p.status));
  const allWins     = positions.filter(p => p.status === "CLOSED_WIN");
  const overallWR   = allResolved.length > 0 ? r2(allWins.length / allResolved.length * 100) : null;

  // Best/worst by win rate (minimum 5 resolved for statistical validity)
  const ranked = tierMetrics
    .filter(t => (t.wins + t.losses + t.stopped) >= 5 && t.win_rate_pct != null)
    .sort((a, b) => (b.win_rate_pct ?? 0) - (a.win_rate_pct ?? 0));
  const bestTier  = ranked[0]?.tier  ?? null;
  const worstTier = ranked[ranked.length - 1]?.tier ?? null;

  // ── Recommendations ────────────────────────────────────────────────────────
  const recs: ValidationRecommendation[] = [];

  for (const t of tierMetrics) {
    if (t.total < 5) continue; // too few samples for reliable recommendations

    const stopRate   = t.stopped / t.total;
    const expiryRate = t.expired / t.total;
    const wr         = t.win_rate_pct;
    const avgRoi     = t.avg_roi_pct;

    if (wr != null && wr < 25) {
      recs.push({
        tier: t.tier, metric: "win_rate",
        current_value: `${wr}%`,
        suggestion: `Win rate is critically low (${wr}%). Raise evidence score threshold or add an additional entry condition. Consider pausing ${t.tier} entries until the signal quality is validated.`,
        impact: "HIGH",
      });
    } else if (wr != null && wr < 40) {
      recs.push({
        tier: t.tier, metric: "win_rate",
        current_value: `${wr}%`,
        suggestion: `Win rate of ${wr}% is below target. Review discovery criteria for ${t.tier} tier — signals may be arriving too late in the price cycle.`,
        impact: "MEDIUM",
      });
    }

    if (stopRate > 0.4) {
      recs.push({
        tier: t.tier, metric: "stop_loss_rate",
        current_value: `${Math.round(stopRate * 100)}%`,
        suggestion: `${Math.round(stopRate * 100)}% of ${t.tier} positions are stopped out. The current stop loss % may be too tight for this tier's volatility profile. Consider widening it by 10–20 percentage points or using a time-delayed stop.`,
        impact: "HIGH",
      });
    } else if (stopRate > 0.25) {
      recs.push({
        tier: t.tier, metric: "stop_loss_rate",
        current_value: `${Math.round(stopRate * 100)}%`,
        suggestion: `${Math.round(stopRate * 100)}% stop rate for ${t.tier}. Moderate. Monitor whether widening the stop loss improves net ROI.`,
        impact: "MEDIUM",
      });
    }

    if (expiryRate > 0.3) {
      recs.push({
        tier: t.tier, metric: "expiry_rate",
        current_value: `${Math.round(expiryRate * 100)}%`,
        suggestion: `${Math.round(expiryRate * 100)}% of ${t.tier} positions expire without hitting any milestone. Reduce max position age or add a trailing stop to recapture capital faster.`,
        impact: "MEDIUM",
      });
    }

    if (avgRoi != null && avgRoi < -30) {
      recs.push({
        tier: t.tier, metric: "avg_roi",
        current_value: `${avgRoi}%`,
        suggestion: `Average ROI of ${avgRoi}% for ${t.tier} is deeply negative. This tier may be generating signals after the primary move has already occurred. Evaluate discovery timing relative to ATH.`,
        impact: "HIGH",
      });
    }

    if (t.avg_time_to_2x_hours != null && t.avg_time_to_2x_hours > 8) {
      recs.push({
        tier: t.tier, metric: "time_to_2x",
        current_value: `${t.avg_time_to_2x_hours}h`,
        suggestion: `${t.tier} positions take an average of ${t.avg_time_to_2x_hours}h to reach 2×. These are slow movers — consider reducing position age limit to free capital for fresher signals.`,
        impact: "LOW",
      });
    }
  }

  // Sort: HIGH → MEDIUM → LOW, then alphabetically by tier
  const impactOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  recs.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact] || a.tier.localeCompare(b.tier));

  return {
    tiers:                tierMetrics,
    recommendations:      recs,
    overall_win_rate_pct: overallWR,
    best_tier:            bestTier,
    worst_tier:           worstTier,
    total_positions:      positions.length,
    generated_at:         Date.now(),
  };
}
