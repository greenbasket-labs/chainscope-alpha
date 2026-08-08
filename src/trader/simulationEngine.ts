/**
 * Simulation Engine v2
 *
 * Subscribes to the alert bus. For every incoming alert, runs the full
 * gating sequence — same logic Live Mode will use, just without the
 * blockchain execution step at the end.
 *
 * Architecture (Phase 4G):
 *   evaluateGates() is a PURE function: no DB, no async.
 *   handleNewAlert() supplies the context (DB reads) and calls evaluateGates().
 *   Live Mode replaces openSimPosition() with sendSwapTransaction() — no other
 *   changes required.  All business logic lives in evaluateGates().
 *
 * Gates (in order):
 *  1.  Alert within entry window
 *  2.  Tier present in enabled_entry_filters (null tier → SKIP)
 *  3.  Buy setting exists and is enabled for this tier
 *  4.  Buy amount > 0
 *  5.  Max active trades not exceeded
 *  6.  Wallet exposure (invested + buy) / capital within limit
 *  7.  Consecutive losses below limit
 *  8.  Daily loss below limit
 *
 * Pre-conditions checked before evaluateGates() (not gates — no log entry):
 *  A.  Simulation mode ON
 *  B.  No emergency stop
 *
 * Post-gate (async, after all gates pass):
 *  9.  Entry price resolved (from alert profile or DexScreener fallback)
 *
 * NEVER:
 *   - connects a wallet
 *   - signs or sends a transaction
 *   - calls Jupiter swap
 *   - buys or sells real tokens
 */

import { sqlite } from "../db/index.js";
import { alertBus, type NewAlertEvent } from "./alertBus.js";
import { computePrivateLabel, parseProfileForLabel } from "./privateLabel.js";
import { fetchMarketData } from "../market/client.js";
import { logger } from "../lib/logger.js";
import { openLivePosition } from "./liveEngine.js";
import { getProfileForFlow } from "../eliteFilter/db.js";
import type { EliteFilterProfile } from "../eliteFilter/types.js";

// ── IGNITION Telegram notification ────────────────────────────────────────────
// Fire-and-forget: sends a Telegram message to the IGNITION flow when the
// engine opens a BUY position. Never throws — errors are swallowed silently
// so a Telegram failure cannot block or crash the execution path.

function sendIgnitionTelegram(params: {
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenAddress: string;
  tier: string | null;
  buyAmountUsd: number;
  entryPriceUsd: number;
  privateLabel: string;
  execMode: string;
}): void {
  try {
    const row = sqlite
      .prepare("SELECT telegram_bot_token, telegram_chat_id FROM alert_flows WHERE id = 'IGNITION'")
      .get() as { telegram_bot_token: string | null; telegram_chat_id: string | null } | undefined;

    if (!row?.telegram_bot_token?.trim() || !row?.telegram_chat_id?.trim()) return; // not configured

    const { tokenSymbol, tokenName, tokenAddress, tier, buyAmountUsd, entryPriceUsd, execMode } = params;
    const sym    = tokenSymbol ? `$${tokenSymbol}` : "?";
    const name   = tokenName   ?? "Unknown";
    const price  = entryPriceUsd < 0.0001
      ? entryPriceUsd.toExponential(4)
      : `$${entryPriceUsd.toFixed(8)}`;
    const modeTag = execMode === "LIVE" ? "🔴 LIVE" : "🟡 SIM";
    const shortAddr = `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;

    const text = [
      `🔥 *IGNITION — BUY* ${modeTag}`,
      ``,
      `*${sym}* ${name}`,
      `\`${tokenAddress}\``,
      ``,
      `Tier:   ${tier ?? "UNKNOWN"}`,
      `Buy:    $${buyAmountUsd.toFixed(2)}`,
      `Entry:  ${price}`,
      `Addr:   ${shortAddr}`,
    ].join("\n");

    const botToken = row.telegram_bot_token;
    const chatId   = row.telegram_chat_id;

    // Fire-and-forget — do not await
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    }).then((r) => {
      if (!r.ok) logger.warn({ status: r.status }, "[ignition-tg] sendMessage failed");
    }).catch((err: unknown) => {
      logger.warn({ err }, "[ignition-tg] sendMessage error — non-fatal");
    });
  } catch (err) {
    logger.warn({ err }, "[ignition-tg] setup error — non-fatal");
  }
}

// ── Types (exported for stress tests and readiness checks) ────────────────────

export interface TraderConfig {
  simulation_mode:            number;  // legacy; use execution_mode instead
  execution_mode:             string;  // 'OFF' | 'SIMULATION' | 'LIVE'
  auto_trading_enabled:       number;  // master on/off switch — 0 halts all execution
  emergency_stop_enabled:     number;
  max_active_trades:          number;
  max_buy_amount_usd:         number;
  default_slippage_pct:       number;
  max_slippage_pct:           number;
  auto_slippage_enabled:      number;
  min_priority_fee_lamports:  number;
  max_priority_fee_lamports:  number;
  max_wallet_exposure_pct:    number;
  min_sol_reserve:            number;
  max_consecutive_losses:     number;
  max_daily_loss_usd:         number | null;
  simulation_capital_usd:     number;
  enabled_entry_filters:      string;  // JSON TEXT: e.g. '["ELITE","PRO"]'
  entry_window_minutes:       number;
  stop_loss_pct:              number;
  max_position_age_hours:     number;
}

/** All inputs evaluateGates() needs — no DB, no async. */
export interface GateContext {
  alertAgeMs:             number;
  tier:                   string | null;
  enabledFilters:         string[];
  /**
   * Result of the configuration-driven Elite Filter (non-null for alerts
   * created after the elite filter system was deployed).
   * null  → no elite filter data; fall back to tier-in-enabledFilters check.
   * true  → elite filter passed; Gate 2 passes regardless of tier.
   * false → elite filter blocked this alert; Gate 2 fails.
   */
  eliteFilterPasses:      boolean | null;
  buySetting:             { enabled: number; buy_amount_usd: number } | null;
  openPositionCount:      number;
  totalOpenInvestmentUsd: number;
  consecutiveLossStreak:  number;
  todayRealizedLossUsd:   number;
}

export type GateDecision =
  | { decision: "BUY";  gate: 0; reason: string; buyAmountUsd: number; slippagePct: number; priorityFeeLamports: number }
  | { decision: "SKIP"; gate: number; reason: string };

interface BuySetting {
  tier:           string;
  enabled:        number;
  buy_amount_usd: number;
}

// ── Pure gate evaluation (no side-effects) ────────────────────────────────────

/**
 * Evaluates all gates in order.
 * Returns immediately on the first failing gate.
 * If all gates pass, returns a BUY decision.
 *
 * This function is pure: it has no DB access, no async calls, and no side
 * effects. Live Mode and Simulation Mode share this function unchanged.
 * The only difference between modes is what the caller does with a BUY decision.
 */
export function evaluateGates(cfg: TraderConfig, ctx: GateContext): GateDecision {
  const windowMs = (cfg.entry_window_minutes ?? 60) * 60_000;

  // ── Gate 1: Entry window ────────────────────────────────────────────────────
  if (windowMs <= 0 || ctx.alertAgeMs > windowMs) {
    return {
      decision: "SKIP", gate: 1,
      reason: `Alert age ${Math.round(ctx.alertAgeMs / 60_000)}min > entry window ${cfg.entry_window_minutes}min`,
    };
  }

  // ── Gate 2: Elite filter (new) or tier check (legacy) ──────────────────────
  // • New alerts (created after elite filter deployment) carry
  //   alertProfile.eliteFilter.passes.  If that field is present, we trust it.
  // • Old alerts (no eliteFilter field) fall back to the tier-in-enabledFilters
  //   check so pre-existing behaviour is fully preserved.
  if (ctx.eliteFilterPasses !== null) {
    if (!ctx.eliteFilterPasses) {
      return {
        decision: "SKIP", gate: 2,
        reason: "Elite filter: blocked by active profile (see alert profile eliteFilter.blocked)",
      };
    }
    // Elite filter passes — no additional tier gating needed; continue.
  } else {
    // Legacy path: tier must be in enabled_entry_filters
    if (!ctx.tier || !ctx.enabledFilters.includes(ctx.tier)) {
      return {
        decision: "SKIP", gate: 2,
        reason: ctx.tier
          ? `Tier ${ctx.tier} not in enabled_entry_filters [${ctx.enabledFilters.join(",")}]`
          : "Unknown tier (flow not found)",
      };
    }
  }

  // ── Gate 3: Buy setting present and enabled ─────────────────────────────────
  if (!ctx.buySetting || !ctx.buySetting.enabled) {
    return {
      decision: "SKIP", gate: 3,
      reason: ctx.buySetting
        ? `Buy setting for ${ctx.tier} is disabled`
        : `No buy setting configured for tier ${ctx.tier}`,
    };
  }

  // ── Gate 4: Buy amount > 0 ──────────────────────────────────────────────────
  const buyAmountUsd = Math.min(ctx.buySetting.buy_amount_usd, cfg.max_buy_amount_usd);
  if (buyAmountUsd <= 0) {
    return { decision: "SKIP", gate: 4, reason: "Buy amount resolves to zero (buy_amount_usd or max_buy_amount_usd is 0)" };
  }

  // ── Gate 5: Max active trades ───────────────────────────────────────────────
  if (ctx.openPositionCount >= cfg.max_active_trades) {
    return {
      decision: "SKIP", gate: 5,
      reason: `Max active trades (${cfg.max_active_trades}) reached — ${ctx.openPositionCount} open`,
    };
  }

  // ── Gate 6: Wallet exposure ─────────────────────────────────────────────────
  const capital    = cfg.simulation_capital_usd ?? 500;
  const maxExposed = capital * ((cfg.max_wallet_exposure_pct ?? 20) / 100);
  if (ctx.totalOpenInvestmentUsd + buyAmountUsd > maxExposed) {
    return {
      decision: "SKIP", gate: 6,
      reason: `Wallet exposure limit — $${ctx.totalOpenInvestmentUsd.toFixed(2)} invested + $${buyAmountUsd.toFixed(2)} buy > $${maxExposed.toFixed(2)} limit`,
    };
  }

  // ── Gate 7: Consecutive losses ──────────────────────────────────────────────
  if (cfg.max_consecutive_losses > 0 && ctx.consecutiveLossStreak >= cfg.max_consecutive_losses) {
    return {
      decision: "SKIP", gate: 7,
      reason: `Max consecutive losses (${cfg.max_consecutive_losses}) reached — ${ctx.consecutiveLossStreak} in a row`,
    };
  }

  // ── Gate 8: Daily loss ──────────────────────────────────────────────────────
  if (cfg.max_daily_loss_usd != null && cfg.max_daily_loss_usd > 0) {
    if (ctx.todayRealizedLossUsd >= cfg.max_daily_loss_usd) {
      return {
        decision: "SKIP", gate: 8,
        reason: `Daily loss limit ($${cfg.max_daily_loss_usd}) reached — $${ctx.todayRealizedLossUsd.toFixed(2)} lost today`,
      };
    }
  }

  // ── All gates pass → BUY ────────────────────────────────────────────────────
  const priceStr = "TBD"; // price resolved after gates (async)
  const reason = [
    `${ctx.tier} alert`,
    `${ctx.openPositionCount + 1}/${cfg.max_active_trades} trades`,
    `exposure $${(ctx.totalOpenInvestmentUsd + buyAmountUsd).toFixed(0)}/$${maxExposed.toFixed(0)}`,
    `streak ${ctx.consecutiveLossStreak}/${cfg.max_consecutive_losses} losses`,
    priceStr,
  ].join(" · ");

  return {
    decision: "BUY", gate: 0, reason,
    buyAmountUsd,
    slippagePct:          cfg.default_slippage_pct,
    priorityFeeLamports:  cfg.min_priority_fee_lamports,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function getFlowName(flowId: string | null): string | null {
  // alert_flows.id IS the tier name (ELITE, PRO, WATCH, DEFAULT).
  // There is no separate 'name' column — just normalise the id directly.
  return flowId ? flowId.toUpperCase() : null;
}

/**
 * Merge per-profile trading config over the global trader_config.
 *
 * System-level switches (execution_mode, emergency_stop, wallet, fees, etc.)
 * always come from the global config.  Position-risk settings are overridden
 * by the profile when the profile has a non-null value.  This lets each flow's
 * profile own its position sizing while a single master switch controls whether
 * the engine runs at all.
 */
function mergeProfileConfig(
  global:  TraderConfig,
  profile: EliteFilterProfile | null,
): TraderConfig {
  if (!profile) return global;
  return {
    ...global,
    ...(profile.max_active_trades       != null && { max_active_trades:      profile.max_active_trades }),
    ...(profile.max_buy_usd             != null && { max_buy_amount_usd:     profile.max_buy_usd }),
    ...(profile.stop_loss_pct           != null && { stop_loss_pct:          profile.stop_loss_pct }),
    ...(profile.max_position_age_hours  != null && { max_position_age_hours: profile.max_position_age_hours }),
    ...(profile.entry_window_minutes    != null && { entry_window_minutes:   profile.entry_window_minutes }),
    ...(profile.max_wallet_exposure_pct != null && { max_wallet_exposure_pct: profile.max_wallet_exposure_pct }),
  };
}

function parseEnabledFilters(raw: string | null | undefined): string[] {
  if (!raw) return ["ELITE"];
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed.map((s) => s.toUpperCase()) : ["ELITE"];
  } catch {
    return ["ELITE"];
  }
}

async function resolveEntryPrice(
  tokenAddress: string,
  alertProfile: Record<string, unknown> | null,
): Promise<number | null> {
  if (alertProfile) {
    const p = alertProfile["priceUsd"];
    if (typeof p === "string" && parseFloat(p) > 0) return parseFloat(p);
    if (typeof p === "number" && p > 0) return p;
    const mc     = alertProfile["marketCap"];
    const supply = alertProfile["circulatingSupply"];
    if (typeof mc === "number" && typeof supply === "number" && supply > 0) return mc / supply;
  }
  try {
    const data = await fetchMarketData(tokenAddress);
    if (data?.priceUsd) {
      const p = parseFloat(data.priceUsd);
      if (p > 0) return p;
    }
  } catch (err) {
    logger.debug({ err, tokenAddress }, "[sim-engine] price fetch fallback error — non-fatal");
  }
  return null;
}

function countOpenPositions(execMode: string): number {
  if (execMode === "LIVE") {
    // In LIVE mode, real open trades are in trader_trades (OPEN or WAITING = not yet confirmed)
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM trader_trades WHERE status IN ('OPEN', 'WAITING')")
      .get() as { n: number };
    return row.n;
  }
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM trader_sim_positions WHERE status = 'OPEN'")
    .get() as { n: number };
  return row.n;
}

function getTotalOpenInvestment(execMode: string): number {
  if (execMode === "LIVE") {
    // In LIVE mode, open exposure is the sum of actual buy amounts in trader_trades
    const row = sqlite
      .prepare("SELECT COALESCE(SUM(entry_amount_usd), 0) AS total FROM trader_trades WHERE status IN ('OPEN', 'WAITING')")
      .get() as { total: number };
    return row.total;
  }
  const row = sqlite
    .prepare("SELECT COALESCE(SUM(cost_basis_usd), 0) AS total FROM trader_sim_positions WHERE status = 'OPEN'")
    .get() as { total: number };
  return row.total;
}

function getConsecutiveLosses(): number {
  const rows = sqlite
    .prepare(
      `SELECT status FROM trader_sim_positions
        WHERE status IN ('CLOSED_WIN', 'CLOSED_LOSS', 'STOPPED')
        ORDER BY COALESCE(closed_at, opened_at) DESC
        LIMIT 50`
    )
    .all() as { status: string }[];
  let count = 0;
  for (const r of rows) {
    if (r.status === "CLOSED_WIN") break;
    count++;
  }
  return count;
}

function getTodayRealizedLoss(execMode: string): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (execMode === "LIVE") {
    // In LIVE mode, realized losses are in trader_trades (CLOSED with negative profit_usd)
    const row = sqlite
      .prepare(
        `SELECT COALESCE(SUM(profit_usd), 0) AS total_loss
           FROM trader_trades
          WHERE profit_usd < 0
            AND sold_at >= ?
            AND status = 'CLOSED'`
      )
      .get(midnight.getTime()) as { total_loss: number };
    return Math.abs(row.total_loss);
  }
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(realized_profit_usd), 0) AS total_loss
         FROM trader_sim_positions
        WHERE realized_profit_usd < 0
          AND closed_at >= ?
          AND status IN ('CLOSED_LOSS', 'STOPPED')`
    )
    .get(midnight.getTime()) as { total_loss: number };
  return Math.abs(row.total_loss);
}

function recordSimDecision(params: {
  alertId:              number;
  investigationId:      number | null;
  tokenAddress:         string;
  tokenSymbol:          string | null;
  tokenName:            string | null;
  alertTier:            string;
  decision:             "BUY" | "SKIP";
  decisionReason:       string;
  entryPriceUsd:        number | null;
  buyAmountUsd:         number | null;
  slippagePct:          number | null;
  priorityFeeLamports:  number | null;
  expectedCostUsd:      number | null;
  expectedTokens:       number | null;
}): number {
  const now    = Date.now();
  const status = params.decision === "BUY" ? "OPEN" : "SKIP";
  const result = sqlite
    .prepare(
      `INSERT INTO trader_simulation_log (
         alert_id, investigation_id,
         token_address, token_symbol, token_name,
         alert_level, alert_tier,
         decision, decision_reason,
         entry_price_usd,
         buy_amount_usd, slippage_pct, priority_fee_lamports,
         expected_cost_usd, expected_tokens,
         status, is_simulation, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      params.alertId,
      params.investigationId,
      params.tokenAddress,
      params.tokenSymbol,
      params.tokenName,
      params.alertTier,
      params.alertTier,
      params.decision,
      params.decisionReason,
      params.entryPriceUsd,
      params.buyAmountUsd,
      params.slippagePct,
      params.priorityFeeLamports,
      params.expectedCostUsd,
      params.expectedTokens,
      status,
      now,
    );
  return result.lastInsertRowid as number;
}

function openSimPosition(params: {
  simLogId:            number;
  alertId:             number;
  investigationId:     number | null;
  tokenAddress:        string;
  tokenSymbol:         string | null;
  tokenName:           string | null;
  alertTier:           string;
  entryPriceUsd:       number;
  buyAmountUsd:        number;
  tokensAfterSlippage: number;
  evidenceScore:       number | null;
  marketCapUsd:        number | null;
  liquidityUsd:        number | null;
  filterProfileId?:    string | null; // v53 — profile that owns this position's TP ladder
}): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO trader_sim_positions (
         sim_log_id, alert_id, investigation_id,
         token_address, token_symbol, token_name, alert_tier,
         entry_price_usd, buy_amount_usd,
         tokens_purchased, tokens_remaining,
         cost_basis_usd, realized_profit_usd,
         peak_price_usd, last_price_usd, min_price_usd,
         evidence_score, market_cap_usd, liquidity_usd,
         filter_profile_id,
         status, milestones_hit,
         opened_at, last_updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, 0, ?, ?, ?,
         ?, ?, ?,
         ?,
         'OPEN', '[]', ?, ?
       )`
    )
    .run(
      params.simLogId,
      params.alertId,
      params.investigationId,
      params.tokenAddress,
      params.tokenSymbol,
      params.tokenName,
      params.alertTier,
      params.entryPriceUsd,
      params.buyAmountUsd,
      params.tokensAfterSlippage,   // tokens_purchased
      params.tokensAfterSlippage,   // tokens_remaining
      params.buyAmountUsd,          // cost_basis_usd
      params.entryPriceUsd,         // peak_price_usd (start = entry)
      params.entryPriceUsd,         // last_price_usd
      params.entryPriceUsd,         // min_price_usd (start = entry)
      params.evidenceScore,
      params.marketCapUsd,
      params.liquidityUsd,
      params.filterProfileId ?? null,
      now,
      now,
    );
}

// ── Main alert handler ────────────────────────────────────────────────────────

async function handleNewAlert(event: NewAlertEvent): Promise<void> {
  try {
    // ── Pre-condition A: read global config then merge per-profile overrides ──
    const globalCfg = sqlite
      .prepare("SELECT * FROM trader_config WHERE id = 1")
      .get() as TraderConfig | undefined;
    if (!globalCfg) return;

    // Load the elite filter profile linked to this alert's flow (v53+).
    // If no profile is linked, null → mergeProfileConfig is a no-op.
    const flowProfile = event.flowId ? getProfileForFlow(event.flowId) : null;
    const cfg = mergeProfileConfig(globalCfg, flowProfile);

    // ── Pre-condition B: execution mode + safety switches ────────────────────
    // execution_mode is the authoritative switch (v39+).
    // Fall back to legacy simulation_mode for pre-v39 DBs.
    const execMode = cfg.execution_mode ?? (cfg.simulation_mode ? "SIMULATION" : "OFF");
    if (execMode === "OFF") return; // silent — no log entry for disabled mode
    if (cfg.emergency_stop_enabled) {
      logger.info({ alertId: event.alertId }, "[sim-engine] emergency stop — skip");
      return;
    }
    // auto_trading_enabled is a master kill-switch independent of execution_mode.
    // Operators expect turning this OFF to immediately halt all trade execution.
    if (!cfg.auto_trading_enabled) {
      logger.info({ alertId: event.alertId }, "[sim-engine] auto_trading_enabled = false — halted at pre-condition, gate evaluation skipped");
      return;
    }

    // ── Pre-condition C: duplicate alert dedup ────────────────────────────────
    // Guard against the same alertId being processed twice (e.g. EventEmitter
    // re-registration on restart, or double-emit from createAlert).
    const dupTable  = execMode === "LIVE" ? "trader_trades" : "trader_simulation_log";
    const dupColumn = execMode === "LIVE" ? "alert_id"      : "alert_id";
    const dupExists = sqlite
      .prepare(`SELECT 1 AS found FROM ${dupTable} WHERE ${dupColumn} = ? LIMIT 1`)
      .get(event.alertId) as { found: number } | undefined;
    if (dupExists) {
      logger.debug({ alertId: event.alertId, table: dupTable }, "[sim-engine] duplicate alert — skip");
      return;
    }

    // ── Build gate context (all DB reads happen here, not in evaluateGates) ───
    const alertAgeMs      = Date.now() - event.createdAt;
    const windowMs        = (cfg.entry_window_minutes ?? 60) * 60_000;

    // Early-exit for stale alerts without recording (expected on startup replay)
    if (alertAgeMs > windowMs) {
      logger.debug(
        { alertId: event.alertId, alertAgeMin: Math.round(alertAgeMs / 60_000), limitMin: cfg.entry_window_minutes },
        "[sim-engine] SKIP — outside entry window (not recorded)"
      );
      return;
    }

    const flowTier       = getFlowName(event.flowId);  // original research flow tier
    const enabledFilters = parseEnabledFilters(cfg.enabled_entry_filters);

    const tokenRow = sqlite
      .prepare("SELECT name, symbol, launch_time FROM tokens WHERE contract_address = ? LIMIT 1")
      .get(event.tokenAddress) as { name: string | null; symbol: string | null; launch_time: number | null } | undefined;
    const tokenSymbol = tokenRow?.symbol ?? null;
    const tokenName   = tokenRow?.name   ?? null;

    // ── Private desk label — computed from existing evidence fields ───────────
    const pairCreatedAt     = tokenRow?.launch_time ?? null;
    const deskAgeSec        = pairCreatedAt != null
      ? Math.max(0, (event.createdAt - pairCreatedAt) / 1_000)
      : alertAgeMs / 1_000; // fallback: time since alert was created
    const deskInput         = parseProfileForLabel(event.alertProfile, deskAgeSec);
    const deskResult        = computePrivateLabel(deskInput);
    const deskPrefix        = `[${deskResult.label}] `;

    // ── Action-based effective queue resolution ───────────────────────────────
    // The engine thinks in trading queues, not research tiers.
    // Four independent queues (one alert → one queue → one buy):
    //   1. ELITE             — flowTier === "ELITE" AND action === "BUY"
    //   2. PRO               — flowTier === "PRO"   AND action === "BUY"
    //   3. IGNITION          — action === "BUY" AND flowTier is neither ELITE nor PRO
    //   4. WATCH_FOR_UPGRADE — action === "WATCH FOR UPGRADE" (any tier)
    //   All other actions (WATCH ONLY, IGNORE, REJECT) are never traded.
    const privateAction = deskResult.action;
    let   effectiveQueue: string;

    if (privateAction === "BUY") {
      if      (flowTier === "ELITE") effectiveQueue = "ELITE";
      else if (flowTier === "PRO")   effectiveQueue = "PRO";
      else                           effectiveQueue = "IGNITION";
    } else if (privateAction === "WATCH FOR UPGRADE") {
      effectiveQueue = "WATCH_FOR_UPGRADE";
    } else {
      // WATCH ONLY, IGNORE, REJECT — record a SKIP and exit
      recordSimDecision({
        alertId: event.alertId, investigationId: event.investigationId,
        tokenAddress: event.tokenAddress, tokenSymbol, tokenName,
        alertTier: flowTier ?? "UNKNOWN",
        decision: "SKIP",
        decisionReason: `${deskPrefix}Action '${privateAction}' — not a trading queue`,
        entryPriceUsd: null, buyAmountUsd: null,
        slippagePct: cfg.default_slippage_pct, priorityFeeLamports: cfg.min_priority_fee_lamports,
        expectedCostUsd: null, expectedTokens: null,
      });
      logger.info(
        { alertId: event.alertId, action: privateAction, label: deskResult.label },
        "[sim-engine] action not a trading queue — SKIP (recorded)",
      );
      return;
    }

    // ── PRO queue guard — explicit rejection of desk-rejected labels/actions ──
    // GHOST (IGNORE) and FLUSH (REJECT) must never enter the PRO queue.
    // This guard is defensive: the action routing above already prevents it,
    // but we state the rule explicitly at the PRO boundary so it is
    // self-documenting and survives any future changes to privateLabel.ts.
    const PRO_BLOCKED_LABELS  = new Set(["GHOST", "FLUSH"]);
    const PRO_BLOCKED_ACTIONS = new Set(["REJECT"]);
    if (
      effectiveQueue === "PRO" &&
      (PRO_BLOCKED_LABELS.has(deskResult.label) || PRO_BLOCKED_ACTIONS.has(privateAction))
    ) {
      recordSimDecision({
        alertId: event.alertId, investigationId: event.investigationId,
        tokenAddress: event.tokenAddress, tokenSymbol, tokenName,
        alertTier: "PRO",
        decision: "SKIP",
        decisionReason: `${deskPrefix}Label '${deskResult.label}' / action '${privateAction}' — blocked from PRO queue`,
        entryPriceUsd: null, buyAmountUsd: null,
        slippagePct: cfg.default_slippage_pct, priorityFeeLamports: cfg.min_priority_fee_lamports,
        expectedCostUsd: null, expectedTokens: null,
      });
      logger.info(
        { alertId: event.alertId, label: deskResult.label, action: privateAction },
        "[sim-engine] PRO queue — label/action blocked — SKIP (recorded)",
      );
      return;
    }

    const buySetting = sqlite
      .prepare("SELECT * FROM trader_buy_settings WHERE tier = ? LIMIT 1")
      .get(effectiveQueue) as BuySetting | undefined;

    // Extract elite filter result from alert profile (null if not present = legacy alert).
    const eliteFilterData = (event.alertProfile as Record<string, unknown> | null)?.eliteFilter as
      | { passes: boolean } | null
      | undefined;
    const eliteFilterPasses: boolean | null =
      eliteFilterData != null && "passes" in eliteFilterData
        ? eliteFilterData.passes
        : null;

    const ctx: GateContext = {
      alertAgeMs,
      tier: effectiveQueue,
      enabledFilters,
      eliteFilterPasses,
      buySetting: buySetting
        ? { enabled: buySetting.enabled, buy_amount_usd: buySetting.buy_amount_usd }
        : null,
      openPositionCount:      countOpenPositions(execMode),
      totalOpenInvestmentUsd: getTotalOpenInvestment(execMode),
      consecutiveLossStreak:  getConsecutiveLosses(),
      todayRealizedLossUsd:   getTodayRealizedLoss(execMode),
    };

    // ── Run pure gate evaluation ───────────────────────────────────────────────
    logger.info(
      { alertId: event.alertId, effectiveQueue, execMode, openPositions: ctx.openPositionCount, openInvestmentUsd: ctx.totalOpenInvestmentUsd.toFixed(2) },
      "[sim-engine] pre-conditions passed — entering gate evaluation"
    );
    const decision = evaluateGates(cfg, ctx);

    if (decision.decision === "SKIP") {
      recordSimDecision({
        alertId: event.alertId, investigationId: event.investigationId,
        tokenAddress: event.tokenAddress, tokenSymbol, tokenName,
        alertTier: effectiveQueue,
        decision: "SKIP", decisionReason: deskPrefix + decision.reason,
        entryPriceUsd: null, buyAmountUsd: ctx.buySetting?.buy_amount_usd ?? null,
        slippagePct: cfg.default_slippage_pct, priorityFeeLamports: cfg.min_priority_fee_lamports,
        expectedCostUsd: null, expectedTokens: null,
      });
      logger.info({ alertId: event.alertId, gate: decision.gate, reason: decision.reason }, "[sim-engine] gate evaluation complete — SKIP");
      return;
    }

    // ── Gate 9 (async): Resolve entry price ───────────────────────────────────
    const { buyAmountUsd, slippagePct, priorityFeeLamports } = decision;
    const entryPrice = await resolveEntryPrice(event.tokenAddress, event.alertProfile);
    if (!entryPrice || entryPrice <= 0) {
      recordSimDecision({
        alertId: event.alertId, investigationId: event.investigationId,
        tokenAddress: event.tokenAddress, tokenSymbol, tokenName,
        alertTier: effectiveQueue,
        decision: "SKIP", decisionReason: "Could not resolve entry price",
        entryPriceUsd: null, buyAmountUsd, slippagePct, priorityFeeLamports,
        expectedCostUsd: null, expectedTokens: null,
      });
      return;
    }

    // ── Shared pre-execution metadata ─────────────────────────────────────────
    const slippageFactor      = 1 - slippagePct / 100;
    const tokensAfterSlippage = (buyAmountUsd / entryPrice) * slippageFactor;

    const profile      = event.alertProfile ?? {};
    const marketCapUsd = typeof profile["marketCap"] === "number" ? profile["marketCap"] : null;
    const liquidityUsd = typeof profile["liquidity"]  === "number" ? profile["liquidity"]  : null;

    const capital    = cfg.simulation_capital_usd ?? 500;
    const maxExposed = capital * ((cfg.max_wallet_exposure_pct ?? 20) / 100);
    const invested   = ctx.totalOpenInvestmentUsd;
    const priceStr   = entryPrice < 0.0001 ? entryPrice.toExponential(4) : entryPrice.toFixed(8);
    const finalReason = deskPrefix + [
      `${effectiveQueue} alert`,
      `entry $${priceStr}`,
      `slippage ${slippagePct}%`,
      `capital $${(invested + buyAmountUsd).toFixed(0)}/$${maxExposed.toFixed(0)}`,
      `score ${(event.evidenceScore * 100).toFixed(0)}%`,
    ].join(" · ");

    // ── LIVE MODE — real on-chain execution ───────────────────────────────────
    if (execMode === "LIVE") {
      const tokenRow2 = sqlite
        .prepare("SELECT name, symbol FROM tokens WHERE contract_address = ? LIMIT 1")
        .get(event.tokenAddress) as { name: string | null; symbol: string | null } | undefined;

      logger.info(
        { alertId: event.alertId, effectiveQueue, tokenAddress: event.tokenAddress, buyAmountUsd, slippagePct },
        "[sim-engine] BUY → LIVE execution"
      );

      await openLivePosition({
        alertId:             event.alertId,
        investigationId:     event.investigationId ?? null,
        tokenAddress:        event.tokenAddress,
        tokenSymbol:         tokenRow2?.symbol ?? tokenSymbol,
        tokenName:           tokenRow2?.name   ?? tokenName,
        alertTier:           effectiveQueue,
        buyAmountUsd,
        slippagePct,
        priorityFeeLamports,
        evidenceScore:       event.evidenceScore ?? null,
        marketCapUsd,
        liquidityUsd,
        // Alert snapshot extras
        alertTime:           event.createdAt,   // Unix ms timestamp of the alert
        alertAgeSec:         deskAgeSec,        // token age in seconds at alert time
      });
      return; // live engine handles all further logging
    }

    // ── SIMULATION MODE ───────────────────────────────────────────────────────
    const simLogId = recordSimDecision({
      alertId: event.alertId, investigationId: event.investigationId,
      tokenAddress: event.tokenAddress, tokenSymbol, tokenName,
      alertTier: effectiveQueue,
      decision: "BUY", decisionReason: finalReason,
      entryPriceUsd: entryPrice, buyAmountUsd, slippagePct, priorityFeeLamports,
      expectedCostUsd: buyAmountUsd, expectedTokens: tokensAfterSlippage,
    });

    openSimPosition({
      simLogId,
      alertId:             event.alertId,
      investigationId:     event.investigationId,
      tokenAddress:        event.tokenAddress,
      tokenSymbol,
      tokenName,
      alertTier:           effectiveQueue,
      entryPriceUsd:       entryPrice,
      buyAmountUsd,
      tokensAfterSlippage,
      evidenceScore:       event.evidenceScore,
      marketCapUsd,
      liquidityUsd,
      filterProfileId:     flowProfile?.id ?? null,
    });

    logger.info(
      {
        alertId: event.alertId, effectiveQueue,
        tokenAddress: event.tokenAddress, tokenSymbol,
        entryPrice, buyAmountUsd,
        tokensAfterSlippage: Math.round(tokensAfterSlippage),
        evidenceScore: event.evidenceScore, simLogId,
      },
      "[sim-engine] BUY — sim position opened"
    );

    // ── IGNITION Telegram notification (fire-and-forget) ─────────────────────
    // IGNITION is a BUY queue, not a routing flow.  Only send when the private
    // desk classifier returns action === "BUY".  Every other action (WATCH FOR
    // UPGRADE, WATCH ONLY, IGNORE, REJECT) is silently skipped here — the sim
    // position is still recorded above regardless of private label.
    const igInput  = parseProfileForLabel(event.alertProfile, deskAgeSec);
    const igResult = computePrivateLabel(igInput);
    if (igResult.action === "BUY") {
      sendIgnitionTelegram({
        tokenSymbol,
        tokenName,
        tokenAddress: event.tokenAddress,
        tier: effectiveQueue,
        buyAmountUsd,
        entryPriceUsd: entryPrice,
        privateLabel:  igResult.label,
        execMode,
      });
    }
  } catch (err) {
    logger.error({ err, alertId: event.alertId }, "[sim-engine] unhandled error");
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export function startSimulationEngine(): void {
  alertBus.subscribe((event) => {
    void handleNewAlert(event);
  });
  logger.info("[sim-engine] Simulation engine v2 started — full gating, all tiers");
}
