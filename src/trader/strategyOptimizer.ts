/**
 * Strategy Optimizer — Phase 4E
 *
 * Analyses existing simulation positions to recommend parameter improvements.
 * Parameters evaluated:
 *   - stop_loss_pct       : what would P/L look like at different stop thresholds?
 *   - entry_window_minutes: are later entries performing better or worse?
 *   - sell_ladder         : would a different exit structure have improved returns?
 *   - buy_amount_usd      : is position sizing optimal relative to outcomes?
 *   - wallet_exposure_pct : does higher concurrent exposure improve or hurt returns?
 *
 * NEVER modifies settings automatically. Recommendations only.
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
  min_price_usd:       number | null;
  peak_price_usd:      number | null;
  buy_amount_usd:      number;
  opened_at:           number;
  closed_at:           number | null;
  sim_log_id:          number;
}

interface LogRow {
  id:         number;
  created_at: number;
  alert_id:   number | null;
}

interface ExitRow {
  position_id: number;
  milestone_x: number;
  exit_price_usd: number;
  tokens_sold: number;
  proceeds_usd: number;
  cost_basis_usd: number;
  profit_usd: number;
  is_moon_bag: number;
  executed_at: number;
}

export interface ParameterAlternative {
  value:         number | string;
  label:         string;
  simulated_roi: number | null;  // estimated avg ROI if this value had been used
  positions_affected: number;    // how many historical positions would behave differently
  net_change_usd: number;        // estimated P/L change vs current
}

export interface OptimizerParameter {
  parameter:       string;
  description:     string;
  current_value:   number | string;
  current_avg_roi: number | null;
  alternatives:    ParameterAlternative[];
  recommendation:  string | null;
  data_points:     number;
}

export interface OptimizerReport {
  parameters:    OptimizerParameter[];
  summary:       string;
  generated_at:  number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr: number[]): number | null {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function r2(v: number | null): number | null {
  return v != null ? Math.round(v * 100) / 100 : null;
}

// ── Stop loss sensitivity ──────────────────────────────────────────────────────
// For each STOPPED position, the exit price = entry × (1 − stop_loss_pct/100).
// We can retroactively ask: if stop was at X%, would this position have survived?
// We use min_price_usd to determine the lowest the position reached.
// For non-STOPPED positions, min_price_usd tells us how far it dipped before recovering.

function analyzeStopLoss(positions: PositionRow[], cfg: { stop_loss_pct: number }): OptimizerParameter {
  const candidates = positions.filter(p => p.min_price_usd != null && p.entry_price_usd > 0);
  const current    = cfg.stop_loss_pct;
  const alternatives: ParameterAlternative[] = [];

  for (const pct of [50, 60, 70, 80, 85, 90, 95]) {
    if (pct === current) continue;

    let netChange = 0;
    let affected  = 0;

    for (const p of candidates) {
      const actualStopPrice = p.entry_price_usd * (1 - current / 100);
      const altStopPrice    = p.entry_price_usd * (1 - pct / 100);
      const minPrice        = p.min_price_usd!;

      const wasStoppedByActual = minPrice <= actualStopPrice;
      const wouldBeStoppedByAlt = minPrice <= altStopPrice;

      if (wasStoppedByActual === wouldBeStoppedByAlt) continue;
      affected++;

      if (wasStoppedByActual && !wouldBeStoppedByAlt) {
        // Actual stop fires; alt would NOT have stopped it.
        // If position recovered (status CLOSED_WIN), alt would have earned more.
        // If status is STOPPED, peak > actual_exit, so alt MIGHT have done better.
        // Estimate: if minPrice recovered to peak, net gain = (peak - actualStopExit) * tokens_remaining
        // Simplified: use realized_profit_usd of nearest comparable
        if (p.peak_price_usd != null && p.peak_price_usd > actualStopPrice) {
          const actualExitValue  = actualStopPrice;
          const altFinalValue    = p.peak_price_usd; // optimistic: hit peak
          const tokens           = p.cost_basis_usd / p.entry_price_usd;
          netChange += (altFinalValue - actualExitValue) * tokens * 0.5; // 50% certainty discount
        }
      } else if (!wasStoppedByActual && wouldBeStoppedByAlt) {
        // Tighter alt stop would have cut this position early.
        // If position ended as CLOSED_LOSS, alt stop saves some capital.
        if (p.status === "CLOSED_LOSS" || p.status === "EXPIRED") {
          const altExitValue    = altStopPrice;
          const actualFinal     = (p.peak_price_usd ?? p.entry_price_usd) * 0.5; // pessimistic
          const tokens          = p.cost_basis_usd / p.entry_price_usd;
          netChange += (altExitValue - actualFinal) * tokens * 0.5;
        }
      }
    }

    const allRois = positions.map(p => p.roi_pct).filter((v): v is number => v != null);
    const estRoi  = allRois.length > 0
      ? r2(allRois.reduce((s, v) => s + v, 0) / allRois.length + (netChange / Math.max(positions.length, 1)))
      : null;

    alternatives.push({
      value: pct,
      label: `${pct}% stop loss`,
      simulated_roi: estRoi,
      positions_affected: affected,
      net_change_usd: Math.round(netChange * 100) / 100,
    });
  }

  // Best alternative by net_change_usd
  const best = alternatives.sort((a, b) => b.net_change_usd - a.net_change_usd)[0];
  const recommendation = best && best.net_change_usd > 0
    ? `Based on ${candidates.length} positions, a ${String(best.value)}% stop loss would have improved P/L by ~$${best.net_change_usd} (estimated).`
    : candidates.length < 10
    ? "Insufficient data for a reliable stop loss recommendation. Run more simulations first."
    : "Current stop loss setting appears close to optimal based on available data.";

  const currentAvgRoi = r2(avg(positions.map(p => p.roi_pct).filter((v): v is number => v != null)));

  return {
    parameter:       "stop_loss_pct",
    description:     "Exit position when price falls this % below entry",
    current_value:   current,
    current_avg_roi: currentAvgRoi,
    alternatives:    alternatives.sort((a, b) => (a.value as number) - (b.value as number)),
    recommendation,
    data_points: candidates.length,
  };
}

// ── Entry window analysis ──────────────────────────────────────────────────────
// Correlate entry latency (opened_at − alert_created_at) with ROI.

function analyzeEntryWindow(positions: PositionRow[], logMap: Map<number, LogRow>): OptimizerParameter {
  // Build (entry_delay_minutes, roi_pct) pairs
  const pairs: { delayMin: number; roi: number }[] = [];

  for (const p of positions) {
    const logRow = logMap.get(p.sim_log_id);
    if (!logRow || p.roi_pct == null) continue;
    const delayMin = (p.opened_at - logRow.created_at) / 60_000;
    if (delayMin >= 0 && delayMin < 120) {
      pairs.push({ delayMin, roi: p.roi_pct });
    }
  }

  // Bucket into windows
  const buckets: Record<string, number[]> = {
    "0–5 min":   [],
    "5–15 min":  [],
    "15–30 min": [],
    "30–60 min": [],
    "60+ min":   [],
  };
  for (const { delayMin, roi } of pairs) {
    if      (delayMin < 5)  buckets["0–5 min"]!.push(roi);
    else if (delayMin < 15) buckets["5–15 min"]!.push(roi);
    else if (delayMin < 30) buckets["15–30 min"]!.push(roi);
    else if (delayMin < 60) buckets["30–60 min"]!.push(roi);
    else                    buckets["60+ min"]!.push(roi);
  }

  const alternatives: ParameterAlternative[] = Object.entries(buckets)
    .filter(([, rois]) => rois.length >= 3)
    .map(([label, rois]) => ({
      value: label,
      label: `Entry window: ${label}`,
      simulated_roi: r2(avg(rois)),
      positions_affected: rois.length,
      net_change_usd: 0, // not applicable for this dimension
    }));

  const sorted = alternatives.filter(a => a.simulated_roi != null).sort((a, b) => (b.simulated_roi ?? 0) - (a.simulated_roi ?? 0));
  const best = sorted[0];
  const cfg = sqlite.prepare("SELECT entry_window_minutes FROM trader_config WHERE id = 1").get() as { entry_window_minutes: number } | undefined;

  const recommendation = best && pairs.length >= 10
    ? `Entries in the "${best.label.replace("Entry window: ", "")}" bucket achieved the highest avg ROI (${best.simulated_roi}%). Consider tightening the entry window to prioritise fresher alerts.`
    : "Not enough entry latency data to make a window recommendation.";

  return {
    parameter:       "entry_window_minutes",
    description:     "How old an alert can be when the engine decides to enter",
    current_value:   cfg?.entry_window_minutes ?? 60,
    current_avg_roi: r2(avg(pairs.map(p => p.roi))),
    alternatives,
    recommendation,
    data_points: pairs.length,
  };
}

// ── Sell ladder analysis ───────────────────────────────────────────────────────
// For each closed position, compute what the ROI would have been at different
// exit fractions (sell 20% vs 30% vs 50% at first milestone).

function analyzeSellLadder(positions: PositionRow[], exits: ExitRow[]): OptimizerParameter {
  // Group exits by position
  const exitMap = new Map<number, ExitRow[]>();
  for (const e of exits) {
    if (!exitMap.has(e.position_id)) exitMap.set(e.position_id, []);
    exitMap.get(e.position_id)!.push(e);
  }

  const posWithExits = positions.filter(p => exitMap.has(p.id) && (exitMap.get(p.id)?.length ?? 0) > 0);

  // For each position compute: what if first exit sold a different fraction?
  const alternatives: ParameterAlternative[] = [];
  for (const fraction of [0.1, 0.2, 0.3, 0.4, 0.5, 0.75]) {
    let totalAltProfit = 0;
    let totalActualProfit = 0;
    let affected = 0;

    for (const p of posWithExits) {
      const posExits = exitMap.get(p.id)!.filter(e => e.is_moon_bag === 0).sort((a, b) => a.executed_at - b.executed_at);
      if (posExits.length === 0) continue;

      const firstExit = posExits[0]!;
      const tokensAtFirst = p.cost_basis_usd / p.entry_price_usd; // approx
      const actualFraction = firstExit.tokens_sold / tokensAtFirst;
      if (Math.abs(actualFraction - fraction) < 0.02) continue; // same — skip

      affected++;
      const altProceedsFirst = tokensAtFirst * fraction * firstExit.exit_price_usd;
      const altCostFirst     = fraction * p.cost_basis_usd;
      const altProfitFirst   = altProceedsFirst - altCostFirst;
      totalAltProfit    += altProfitFirst + (p.realized_profit_usd - firstExit.profit_usd);
      totalActualProfit += p.realized_profit_usd;
    }

    if (posWithExits.length === 0) continue;
    const netChange = totalAltProfit - totalActualProfit;
    const altAvgRoi = posWithExits.length > 0
      ? r2((totalAltProfit / posWithExits.reduce((s, p) => s + p.cost_basis_usd, 0)) * 100)
      : null;

    alternatives.push({
      value: fraction * 100,
      label: `Sell ${Math.round(fraction * 100)}% at first milestone`,
      simulated_roi: altAvgRoi,
      positions_affected: affected,
      net_change_usd: Math.round(netChange * 100) / 100,
    });
  }

  const best = alternatives.sort((a, b) => b.net_change_usd - a.net_change_usd)[0];
  const recommendation = best && best.net_change_usd > 5 && posWithExits.length >= 10
    ? `Selling ${String(best.value)}% at the first milestone would have improved total P/L by ~$${best.net_change_usd}.`
    : posWithExits.length < 10
    ? "Not enough exit data for a sell ladder recommendation yet."
    : "Current sell ladder is performing close to the tested alternatives.";

  const currentRoi = r2(avg(positions.filter(p => p.roi_pct != null).map(p => p.roi_pct as number)));

  return {
    parameter:       "sell_ladder_first_exit_pct",
    description:     "What % of tokens to sell at the first milestone",
    current_value:   "configured in sell strategy",
    current_avg_roi: currentRoi,
    alternatives:    alternatives.sort((a, b) => (a.value as number) - (b.value as number)),
    recommendation,
    data_points: posWithExits.length,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeOptimizerReport(): OptimizerReport {
  const positions = sqlite
    .prepare(`
      SELECT id, alert_tier, status, roi_pct, realized_profit_usd, cost_basis_usd,
             entry_price_usd, min_price_usd, peak_price_usd, buy_amount_usd,
             opened_at, closed_at, sim_log_id
        FROM trader_sim_positions
    `)
    .all() as PositionRow[];

  const logRows = sqlite
    .prepare(`SELECT id, created_at, alert_id FROM trader_simulation_log WHERE decision = 'BUY'`)
    .all() as LogRow[];
  const logMap = new Map<number, LogRow>(logRows.map(r => [r.id, r]));

  const exits = sqlite
    .prepare(`
      SELECT position_id, milestone_x, exit_price_usd, tokens_sold, proceeds_usd,
             cost_basis_usd, profit_usd, is_moon_bag, executed_at
        FROM trader_sim_exits
    `)
    .all() as ExitRow[];

  const cfg = sqlite
    .prepare(`SELECT stop_loss_pct, entry_window_minutes, max_wallet_exposure_pct, simulation_capital_usd FROM trader_config WHERE id = 1`)
    .get() as { stop_loss_pct: number; entry_window_minutes: number; max_wallet_exposure_pct: number; simulation_capital_usd: number } | undefined;

  const params: OptimizerParameter[] = [];

  if (positions.length > 0 && cfg) {
    params.push(analyzeStopLoss(positions, cfg));
    params.push(analyzeEntryWindow(positions, logMap));
    params.push(analyzeSellLadder(positions, exits));
  }

  const summary = positions.length < 20
    ? `Only ${positions.length} positions in history. Run the simulation longer for reliable recommendations (target ≥ 50).`
    : `Optimizer analysed ${positions.length} positions across ${params.length} parameters. See each parameter for recommendations.`;

  return { parameters: params, summary, generated_at: Date.now() };
}
