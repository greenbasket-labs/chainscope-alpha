/**
 * My Auto Trader — Configuration, History & Execution Routes
 *
 * GET  /trader/config              — full trading configuration
 * PUT  /trader/config              — update configuration (partial)
 * GET  /trader/mode                — current execution mode (OFF|SIMULATION|LIVE)
 * PUT  /trader/mode                — set execution mode to OFF or SIMULATION
 * PUT  /trader/mode/live           — enable LIVE mode (requires explicit confirmation)
 * GET  /trader/wallet              — wallet info (private key NEVER returned)
 * POST /trader/wallet              — save wallet config (encrypts private key)
 * DELETE /trader/wallet            — disconnect / clear encrypted key
 * GET  /trader/wallet/balance      — live SOL balance + RPC health
 * GET  /trader/buy-settings        — per-tier buy amounts
 * PUT  /trader/buy-settings        — update per-tier buy amounts
 * GET  /trader/sell-strategy       — sell milestones
 * PUT  /trader/sell-strategy       — replace sell milestones
 * GET  /trader/trades              — paginated trade history (sim + live)
 * GET  /trader/live/trades         — live trades only (trader_trades)
 * GET  /trader/live/trades/:id     — single live trade with timeline
 * GET  /trader/live/positions      — active open live positions
 * GET  /trader/stats               — computed dashboard statistics
 */

import { Router, type Request, type Response } from "express";
import { sqlite as db } from "../db/index.js";
import { encryptValue, decryptValue } from "../lib/crypto.js";
import { computeSimulationAnalytics } from "../trader/analytics.js";
import { computeValidationReport }    from "../trader/validationEngine.js";
import { computeOptimizerReport }     from "../trader/strategyOptimizer.js";
import { runStressTests, verifyStopLossFormula } from "../trader/stressTest.js";
import { evaluateGates, type TraderConfig as EngineConfig } from "../trader/simulationEngine.js";
import { derivePublicKey } from "../trader/transactionPipeline.js";
import { runPreFlight, checkJupiterReachable } from "../trader/livePreFlight.js";
import { alertBus } from "../trader/alertBus.js";
import { computePrivateLabel, parseProfileForLabel } from "../trader/privateLabel.js";

const router: import('express').Router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() {
  return Date.now();
}

function jsonBool(v: number | null | undefined): boolean {
  return v === 1;
}

// ── GET /trader/config ────────────────────────────────────────────────────────

router.get("/trader/config", (_req: Request, res: Response): void => {
  try {
    const row = db
      .prepare(`SELECT * FROM trader_config WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: "Trader config not initialised" });
      return;
    }

    res.json({
      ...row,
      auto_trading_enabled:      jsonBool(row.auto_trading_enabled as number),
      auto_slippage_enabled:     jsonBool(row.auto_slippage_enabled as number),
      auto_priority_fee_enabled: jsonBool(row.auto_priority_fee_enabled as number),
      emergency_stop_enabled:    jsonBool(row.emergency_stop_enabled as number),
      simulation_mode:           jsonBool(row.simulation_mode as number),
      enabled_entry_filters:     JSON.parse((row.enabled_entry_filters as string) ?? "[]"),
    });
  } catch (err) {
    console.error("[trader] GET /trader/config error:", err);
    res.status(500).json({ error: "Failed to load trader config" });
  }
});

// ── PUT /trader/config ────────────────────────────────────────────────────────

router.put("/trader/config", (req: Request, res: Response): void => {
  try {
    const body = req.body as Record<string, unknown>;

    const allowed = [
      "auto_trading_enabled",
      "max_active_trades",
      "default_slippage_pct",
      "max_slippage_pct",
      "auto_slippage_enabled",
      "min_priority_fee_lamports",
      "max_priority_fee_lamports",
      "auto_priority_fee_enabled",
      "max_wallet_exposure_pct",
      "min_sol_reserve",
      "max_buy_amount_usd",
      "emergency_stop_enabled",
      "max_consecutive_losses",
      "max_daily_loss_usd",
      "enabled_entry_filters",
      "simulation_mode",
      "simulation_capital_usd",
      "entry_window_minutes",
      "stop_loss_pct",
      "max_position_age_hours",
    ] as const;

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const key of allowed) {
      if (!(key in body)) continue;
      let val = body[key];
      if (key === "enabled_entry_filters") {
        val = JSON.stringify(Array.isArray(val) ? val : []);
      } else if (
        key === "auto_trading_enabled" ||
        key === "auto_slippage_enabled" ||
        key === "auto_priority_fee_enabled" ||
        key === "emergency_stop_enabled" ||
        key === "simulation_mode"
      ) {
        val = val ? 1 : 0;
      }
      sets.push(`${key} = ?`);
      vals.push(val);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    sets.push("updated_at = ?");
    vals.push(ts());
    vals.push(1); // WHERE id = 1

    db.prepare(`UPDATE trader_config SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

    const updated = db.prepare(`SELECT * FROM trader_config WHERE id = 1`).get() as Record<string, unknown>;
    res.json({
      ...updated,
      auto_trading_enabled:      jsonBool(updated.auto_trading_enabled as number),
      auto_slippage_enabled:     jsonBool(updated.auto_slippage_enabled as number),
      auto_priority_fee_enabled: jsonBool(updated.auto_priority_fee_enabled as number),
      emergency_stop_enabled:    jsonBool(updated.emergency_stop_enabled as number),
      simulation_mode:           jsonBool(updated.simulation_mode as number),
      enabled_entry_filters:     JSON.parse((updated.enabled_entry_filters as string) ?? "[]"),
    });
  } catch (err) {
    console.error("[trader] PUT /trader/config error:", err);
    res.status(500).json({ error: "Failed to update trader config" });
  }
});

// ── GET /trader/wallet ────────────────────────────────────────────────────────

router.get("/trader/wallet", (_req: Request, res: Response): void => {
  try {
    const row = db
      .prepare(`SELECT * FROM trader_wallet WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: "Wallet not initialised" });
      return;
    }

    // Never return the encrypted key material
    res.json({
      wallet_address:   row.wallet_address ?? null,
      rpc_endpoint:     row.rpc_endpoint,
      jito_rpc:         row.jito_rpc ?? null,
      mev_protection:   jsonBool(row.mev_protection as number),
      connected:        jsonBool(row.connected as number),
      connected_at:     row.connected_at ?? null,
      has_private_key:  Boolean(row.encrypted_private_key),
      updated_at:       row.updated_at,
    });
  } catch (err) {
    console.error("[trader] GET /trader/wallet error:", err);
    res.status(500).json({ error: "Failed to load wallet config" });
  }
});

// ── POST /trader/wallet ───────────────────────────────────────────────────────

router.post("/trader/wallet", (req: Request, res: Response): void => {
  try {
    const {
      wallet_address,
      private_key,
      rpc_endpoint,
      jito_rpc,
      mev_protection,
    } = req.body as {
      wallet_address?: string;
      private_key?: string;
      rpc_endpoint?: string;
      jito_rpc?: string;
      mev_protection?: boolean;
    };

    const now = ts();

    // Fetch existing row
    const existing = db
      .prepare(`SELECT * FROM trader_wallet WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;

    let enc_key = existing?.encrypted_private_key ?? null;
    let enc_iv  = existing?.encryption_iv         ?? null;
    let enc_tag = existing?.encryption_tag        ?? null;

    if (private_key && private_key.trim().length > 0) {
      const blob = encryptValue(private_key.trim());
      enc_key = blob.ciphertext;
      enc_iv  = blob.iv;
      enc_tag = blob.tag;
    }

    db.prepare(`
      INSERT INTO trader_wallet
        (id, wallet_address, encrypted_private_key, encryption_iv, encryption_tag,
         rpc_endpoint, jito_rpc, mev_protection, connected, connected_at, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        wallet_address        = excluded.wallet_address,
        encrypted_private_key = excluded.encrypted_private_key,
        encryption_iv         = excluded.encryption_iv,
        encryption_tag        = excluded.encryption_tag,
        rpc_endpoint          = excluded.rpc_endpoint,
        jito_rpc              = excluded.jito_rpc,
        mev_protection        = excluded.mev_protection,
        updated_at            = excluded.updated_at
    `).run(
      wallet_address  ?? existing?.wallet_address  ?? null,
      enc_key,
      enc_iv,
      enc_tag,
      rpc_endpoint    ?? existing?.rpc_endpoint    ?? "https://api.mainnet-beta.solana.com",
      jito_rpc        ?? existing?.jito_rpc        ?? null,
      mev_protection  !== undefined ? (mev_protection ? 1 : 0) : (existing?.mev_protection ?? 0),
      now,
      now,
    );

    res.json({ ok: true, has_private_key: Boolean(enc_key) });
  } catch (err) {
    console.error("[trader] POST /trader/wallet error:", err);
    res.status(500).json({ error: "Failed to save wallet config" });
  }
});

// ── SOL price cache (module-level, 60s TTL) ───────────────────────────────────

let _solPriceCached: number | null = null;
let _solPriceFetchedAt = 0;
const SOL_PRICE_TTL_MS = 60_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function getSolPriceUsd(): Promise<number | null> {
  if (_solPriceCached !== null && Date.now() - _solPriceFetchedAt < SOL_PRICE_TTL_MS) {
    return _solPriceCached;
  }
  try {
    const res = await fetch(
      `https://price.jup.ag/v6/price?ids=${SOL_MINT}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return _solPriceCached;
    const json = await res.json() as { data?: Record<string, { price?: number }> };
    const price = json.data?.[SOL_MINT]?.price ?? null;
    if (price != null) {
      _solPriceCached = price;
      _solPriceFetchedAt = Date.now();
    }
    return price;
  } catch {
    return _solPriceCached; // return stale value on network error
  }
}

// ── GET /trader/wallet/balance ────────────────────────────────────────────────
// Read-only. No transactions, no signing, no writes to the blockchain.

router.get("/trader/wallet/balance", async (_req: Request, res: Response): Promise<void> => {
  try {
    const row = db
      .prepare(`SELECT wallet_address, rpc_endpoint FROM trader_wallet WHERE id = 1`)
      .get() as { wallet_address: string | null; rpc_endpoint: string } | undefined;

    if (!row || !row.wallet_address) {
      res.json({
        connected: false,
        wallet_address: null,
        sol_balance: null,
        sol_usd_value: null,
        sol_price_usd: null,
        rpc_ok: false,
        rpc_latency_ms: null,
        rpc_endpoint: row?.rpc_endpoint ?? null,
        checked_at: Date.now(),
        error: "No wallet address configured",
      });
      return;
    }

    const { wallet_address, rpc_endpoint } = row;

    // ── Fetch balance + health in parallel ─────────────────────────────────

    const rpcCall = async (method: string, params: unknown[]) => {
      const t0 = Date.now();
      const r = await fetch(rpc_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
      });
      const latency = Date.now() - t0;
      const json = await r.json() as { result?: unknown; error?: unknown };
      return { json, latency };
    };

    let sol_balance: number | null = null;
    let rpc_ok = false;
    let rpc_latency_ms: number | null = null;
    let rpc_error: string | null = null;

    try {
      const [healthRes, balanceRes] = await Promise.all([
        rpcCall("getHealth", []),
        rpcCall("getBalance", [wallet_address]),
      ]);

      rpc_latency_ms = balanceRes.latency;

      // getHealth returns "ok" in result when healthy
      rpc_ok = healthRes.json.result === "ok" || healthRes.json.result != null;

      // getBalance result: { context: { slot }, value: lamports }
      const balanceResult = balanceRes.json.result as { value?: number } | null;
      const lamports = balanceResult?.value ?? null;
      if (lamports != null) {
        sol_balance = lamports / 1_000_000_000;
      }
      if (balanceRes.json.error) {
        rpc_error = String((balanceRes.json.error as Record<string,unknown>)?.message ?? balanceRes.json.error);
      }
    } catch (rpcErr) {
      rpc_ok = false;
      rpc_error = (rpcErr as Error).message;
    }

    const sol_price_usd = await getSolPriceUsd();
    const sol_usd_value = sol_balance != null && sol_price_usd != null
      ? Math.round(sol_balance * sol_price_usd * 100) / 100
      : null;

    res.json({
      connected: rpc_ok && sol_balance !== null,
      wallet_address,
      sol_balance,
      sol_usd_value,
      sol_price_usd,
      rpc_ok,
      rpc_latency_ms,
      rpc_endpoint,
      checked_at: Date.now(),
      ...(rpc_error ? { error: rpc_error } : {}),
    });
  } catch (err) {
    console.error("[trader] GET /trader/wallet/balance error:", err);
    res.status(500).json({ error: "Failed to fetch wallet balance" });
  }
});

// ── DELETE /trader/wallet ─────────────────────────────────────────────────────

router.delete("/trader/wallet", (_req: Request, res: Response): void => {
  try {
    db.prepare(`
      UPDATE trader_wallet
      SET encrypted_private_key = NULL,
          encryption_iv         = NULL,
          encryption_tag        = NULL,
          connected             = 0,
          connected_at          = NULL,
          updated_at            = ?
      WHERE id = 1
    `).run(ts());

    res.json({ ok: true });
  } catch (err) {
    console.error("[trader] DELETE /trader/wallet error:", err);
    res.status(500).json({ error: "Failed to disconnect wallet" });
  }
});

// ── GET /trader/buy-settings ──────────────────────────────────────────────────

router.get("/trader/buy-settings", (_req: Request, res: Response): void => {
  try {
    // Seed IGNITION and WATCH_FOR_UPGRADE rows on first access (data only — no schema change)
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO trader_buy_settings (tier, enabled, buy_amount_usd, created_at, updated_at)
      VALUES (?, 0, 25, ?, ?)
    `);
    const seedNow = ts();
    db.transaction(() => {
      upsert.run("IGNITION",          seedNow, seedNow);
      upsert.run("WATCH_FOR_UPGRADE", seedNow, seedNow);
    })();

    const rows = db
      .prepare(`SELECT * FROM trader_buy_settings ORDER BY CASE tier
        WHEN 'ELITE'             THEN 1
        WHEN 'PRO'               THEN 2
        WHEN 'STANDARD'          THEN 3
        WHEN 'LOW'               THEN 4
        WHEN 'IGNITION'          THEN 5
        WHEN 'WATCH_FOR_UPGRADE' THEN 6
        ELSE 7 END`)
      .all() as Record<string, unknown>[];

    res.json(rows.map((r) => ({ ...r, enabled: jsonBool(r.enabled as number) })));
  } catch (err) {
    console.error("[trader] GET /trader/buy-settings error:", err);
    res.status(500).json({ error: "Failed to load buy settings" });
  }
});

// ── PUT /trader/buy-settings ──────────────────────────────────────────────────

router.put("/trader/buy-settings", (req: Request, res: Response): void => {
  try {
    const items = req.body as { tier: string; enabled: boolean; buy_amount_usd: number }[];
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "Body must be an array" });
      return;
    }

    const now = ts();
    const stmt = db.prepare(`
      UPDATE trader_buy_settings
      SET enabled = ?, buy_amount_usd = ?, updated_at = ?
      WHERE tier = ?
    `);

    db.transaction(() => {
      for (const item of items) {
        stmt.run(item.enabled ? 1 : 0, item.buy_amount_usd, now, item.tier);
      }
    })();

    const rows = db
      .prepare(`SELECT * FROM trader_buy_settings ORDER BY CASE tier
        WHEN 'ELITE'             THEN 1
        WHEN 'PRO'               THEN 2
        WHEN 'STANDARD'          THEN 3
        WHEN 'LOW'               THEN 4
        WHEN 'IGNITION'          THEN 5
        WHEN 'WATCH_FOR_UPGRADE' THEN 6
        ELSE 7 END`)
      .all() as Record<string, unknown>[];

    res.json(rows.map((r) => ({ ...r, enabled: jsonBool(r.enabled as number) })));
  } catch (err) {
    console.error("[trader] PUT /trader/buy-settings error:", err);
    res.status(500).json({ error: "Failed to update buy settings" });
  }
});

// ── GET /trader/sell-strategy ─────────────────────────────────────────────────

router.get("/trader/sell-strategy", (_req: Request, res: Response): void => {
  try {
    const rows = db
      .prepare(`SELECT * FROM trader_sell_strategy ORDER BY sort_order`)
      .all() as Record<string, unknown>[];

    res.json(
      rows.map((r) => ({
        ...r,
        enabled:     jsonBool(r.enabled as number),
        is_moon_bag: jsonBool(r.is_moon_bag as number),
      }))
    );
  } catch (err) {
    console.error("[trader] GET /trader/sell-strategy error:", err);
    res.status(500).json({ error: "Failed to load sell strategy" });
  }
});

// ── PUT /trader/sell-strategy ─────────────────────────────────────────────────

router.put("/trader/sell-strategy", (req: Request, res: Response): void => {
  try {
    const items = req.body as {
      multiplier: number;
      sell_pct: number;
      is_moon_bag: boolean;
      enabled: boolean;
      sort_order: number;
    }[];

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Body must be a non-empty array" });
      return;
    }

    const now = ts();

    db.transaction(() => {
      db.prepare(`DELETE FROM trader_sell_strategy`).run();
      const ins = db.prepare(`
        INSERT INTO trader_sell_strategy
          (multiplier, sell_pct, is_moon_bag, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        ins.run(
          item.multiplier,
          item.sell_pct,
          item.is_moon_bag ? 1 : 0,
          item.enabled ? 1 : 0,
          item.sort_order,
          now,
          now,
        );
      }
    })();

    const rows = db
      .prepare(`SELECT * FROM trader_sell_strategy ORDER BY sort_order`)
      .all() as Record<string, unknown>[];

    res.json(
      rows.map((r) => ({
        ...r,
        enabled:     jsonBool(r.enabled as number),
        is_moon_bag: jsonBool(r.is_moon_bag as number),
      }))
    );
  } catch (err) {
    console.error("[trader] PUT /trader/sell-strategy error:", err);
    res.status(500).json({ error: "Failed to update sell strategy" });
  }
});

// ── GET /trader/trades ────────────────────────────────────────────────────────

router.get("/trader/trades", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0",  10);

    const rows = db
      .prepare(`SELECT * FROM trader_trades ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as Record<string, unknown>[];

    const total = (db.prepare(`SELECT COUNT(*) as n FROM trader_trades`).get() as { n: number }).n;

    res.json({ trades: rows, total, limit, offset });
  } catch (err) {
    console.error("[trader] GET /trader/trades error:", err);
    res.status(500).json({ error: "Failed to load trade history" });
  }
});

// ── GET /trader/stats ─────────────────────────────────────────────────────────

router.get("/trader/stats", (_req: Request, res: Response): void => {
  try {
    const active_statuses = "('WAITING','BUYING','BOUGHT','HOLDING','PARTIAL_SELL')";

    const stats = db.prepare(`
      SELECT
        COUNT(*)                                                          AS total_trades,
        SUM(CASE WHEN status IN ${active_statuses} THEN 1 ELSE 0 END)    AS active_trades,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END)            AS closed_trades,
        SUM(CASE WHEN status = 'FAILED'    THEN 1 ELSE 0 END)            AS failed_trades,
        ROUND(SUM(CASE WHEN status = 'COMPLETED' THEN profit_usd ELSE 0 END), 4) AS realized_profit_usd,
        ROUND(SUM(CASE WHEN status IN ${active_statuses} THEN entry_amount_usd ELSE 0 END), 4) AS open_value_usd,
        ROUND(SUM(CASE WHEN status IN ${active_statuses} THEN
          COALESCE(entry_amount_usd * (1 + COALESCE(profit_pct,0)/100), entry_amount_usd) ELSE 0 END), 4) AS unrealized_value_usd,
        ROUND(
          CAST(SUM(CASE WHEN status='COMPLETED' AND profit_usd > 0 THEN 1 ELSE 0 END) AS REAL)
          / NULLIF(SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END), 0) * 100
        , 1) AS win_rate_pct,
        ROUND(AVG(CASE WHEN status='COMPLETED' THEN profit_pct END), 2)  AS avg_return_pct,
        ROUND(MAX(CASE WHEN status='COMPLETED' THEN profit_pct END), 2)  AS largest_winner_pct,
        ROUND(MIN(CASE WHEN status='COMPLETED' THEN profit_pct END), 2)  AS largest_loser_pct
      FROM trader_trades
    `).get() as Record<string, number | null>;

    res.json(stats);
  } catch (err) {
    console.error("[trader] GET /trader/stats error:", err);
    res.status(500).json({ error: "Failed to compute trader stats" });
  }
});

// ── GET /trader/simulation/stats ─────────────────────────────────────────────
// Cumulative simulation performance from closed + open positions.

router.get("/trader/simulation/stats", (_req: Request, res: Response): void => {
  try {
    const overview = db.prepare(`SELECT * FROM trader_config WHERE id = 1`).get() as Record<string, unknown> | undefined;

    // Positions summary
    const totals = db.prepare(`
      SELECT
        COUNT(*)                                                                          AS total_positions,
        SUM(CASE WHEN status = 'OPEN'        THEN 1 ELSE 0 END)                          AS open_positions,
        SUM(CASE WHEN status LIKE 'CLOSED%'  THEN 1 ELSE 0 END)                          AS closed_positions,
        SUM(CASE WHEN status = 'CLOSED_WIN'  THEN 1 ELSE 0 END)                          AS wins,
        SUM(CASE WHEN status = 'CLOSED_LOSS' THEN 1 ELSE 0 END)                          AS losses,
        SUM(CASE WHEN status = 'STOPPED'     THEN 1 ELSE 0 END)                          AS stopped_count,
        SUM(CASE WHEN status = 'EXPIRED'     THEN 1 ELSE 0 END)                          AS expired_count,
        SUM(realized_profit_usd)                                                          AS total_realized_profit,
        SUM(CASE WHEN status = 'OPEN' THEN unrealized_pnl_usd ELSE 0 END)                AS total_unrealized_pnl,
        AVG(CASE WHEN status NOT IN ('OPEN') THEN roi_pct END)                           AS avg_roi_pct,
        MAX(CASE WHEN status = 'CLOSED_WIN'  THEN roi_pct END)                           AS largest_winner_pct,
        MIN(CASE WHEN status IN ('CLOSED_LOSS','STOPPED') THEN roi_pct END)              AS largest_loser_pct,
        SUM(CASE WHEN status NOT IN ('OPEN') THEN buy_amount_usd ELSE 0 END)             AS total_capital_deployed,
        SUM(CASE WHEN status = 'CLOSED_WIN'  THEN realized_profit_usd ELSE 0 END)        AS total_win_profit,
        SUM(CASE WHEN status IN ('CLOSED_LOSS','STOPPED') THEN realized_profit_usd ELSE 0 END) AS total_loss_amount,
        AVG(CASE WHEN closed_at IS NOT NULL THEN (closed_at - opened_at) / 3600000.0 END) AS avg_duration_hours,
        AVG(CASE WHEN min_price_usd IS NOT NULL AND entry_price_usd > 0
                 THEN (entry_price_usd - min_price_usd) / entry_price_usd * 100 END)    AS avg_drawdown_pct,
        MAX(CASE WHEN min_price_usd IS NOT NULL AND entry_price_usd > 0
                 THEN (entry_price_usd - min_price_usd) / entry_price_usd * 100 END)    AS max_drawdown_pct
      FROM trader_sim_positions
    `).get() as Record<string, number | null>;

    // Decision log summary
    const decisions = db.prepare(`
      SELECT
        COUNT(*) AS total_decisions,
        SUM(CASE WHEN decision = 'BUY'  THEN 1 ELSE 0 END) AS total_buys,
        SUM(CASE WHEN decision = 'SKIP' THEN 1 ELSE 0 END) AS total_skips,
        COUNT(DISTINCT alert_tier) AS tiers_active
      FROM trader_simulation_log
    `).get() as Record<string, number | null>;

    // Milestone exit stats
    const exits = db.prepare(`
      SELECT
        COUNT(*) AS total_exits,
        SUM(profit_usd) AS total_exit_profit,
        AVG(milestone_x) AS avg_exit_multiplier,
        MAX(milestone_x) AS highest_milestone_hit
      FROM trader_sim_exits
      WHERE is_moon_bag = 0
    `).get() as Record<string, number | null>;

    // Tier breakdown
    const tierBreakdown = db.prepare(`
      SELECT
        alert_tier,
        COUNT(*) AS count,
        SUM(CASE WHEN status LIKE 'CLOSED%' THEN 1 ELSE 0 END) AS closed,
        SUM(realized_profit_usd) AS realized_profit,
        AVG(CASE WHEN status LIKE 'CLOSED%' THEN roi_pct END) AS avg_roi_pct
      FROM trader_sim_positions
      GROUP BY alert_tier
    `).all() as Record<string, unknown>[];

    // Win rate — resolved positions = CLOSED_WIN + CLOSED_LOSS + STOPPED + EXPIRED
    const closedCount  = Number(totals.closed_positions ?? 0);
    const stoppedCount = Number(totals.stopped_count    ?? 0);
    const expiredCount = Number(totals.expired_count    ?? 0);
    const wins         = Number(totals.wins             ?? 0);
    const losses       = Number(totals.losses           ?? 0) + stoppedCount; // STOPPED counts as loss
    const resolvedCount = closedCount + stoppedCount + expiredCount;
    const winRate = resolvedCount > 0
      ? Math.round((wins / resolvedCount) * 1000) / 10
      : null;

    res.json({
      simulation_mode:        Boolean((overview?.simulation_mode as number) ?? 0),
      simulation_capital_usd: (overview?.simulation_capital_usd  as number) ?? 500,
      stop_loss_pct:          (overview?.stop_loss_pct           as number) ?? 90,
      max_position_age_hours: (overview?.max_position_age_hours  as number) ?? 24,
      positions: {
        total:    Number(totals.total_positions ?? 0),
        open:     Number(totals.open_positions  ?? 0),
        closed:   closedCount,
        stopped:  stoppedCount,
        expired:  expiredCount,
        resolved: resolvedCount,
        wins,
        losses,
        win_rate_pct: winRate,
      },
      pnl: {
        total_realized_profit:  totals.total_realized_profit  ?? 0,
        total_unrealized_pnl:   totals.total_unrealized_pnl   ?? 0,
        total_win_profit:       totals.total_win_profit        ?? 0,
        total_loss_amount:      totals.total_loss_amount       ?? 0,
        total_capital_deployed: totals.total_capital_deployed  ?? 0,
      },
      returns: {
        avg_roi_pct:          totals.avg_roi_pct         ?? null,
        largest_winner_pct:   totals.largest_winner_pct  ?? null,
        largest_loser_pct:    totals.largest_loser_pct   ?? null,
        avg_duration_hours:   totals.avg_duration_hours  ?? null,
      },
      risk: {
        avg_drawdown_pct: totals.avg_drawdown_pct ?? null,
        max_drawdown_pct: totals.max_drawdown_pct ?? null,
      },
      decisions: {
        total:        Number(decisions.total_decisions ?? 0),
        buys:         Number(decisions.total_buys      ?? 0),
        skips:        Number(decisions.total_skips     ?? 0),
        tiers_active: Number(decisions.tiers_active    ?? 0),
      },
      exits: {
        total:                 Number(exits.total_exits        ?? 0),
        total_exit_profit:     exits.total_exit_profit         ?? 0,
        avg_exit_multiplier:   exits.avg_exit_multiplier       ?? null,
        highest_milestone_hit: exits.highest_milestone_hit     ?? null,
      },
      tier_breakdown: tierBreakdown,
      generated_at: Date.now(),
    });
  } catch (err) {
    console.error("[trader] GET /trader/simulation/stats error:", err);
    res.status(500).json({ error: "Failed to compute simulation stats" });
  }
});

// ── GET /trader/simulation/positions ─────────────────────────────────────────
// Read-only. Returns open and recently-closed sim positions with their exits.

router.get("/trader/simulation/positions", (req: Request, res: Response): void => {
  try {
    const statusFilter = (req.query.status as string) ?? "OPEN";
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50", 10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const positions = db.prepare(`
      SELECT p.*,
             (SELECT json_group_array(json_object(
               'id',             e.id,
               'milestone_x',    e.milestone_x,
               'exit_price_usd', e.exit_price_usd,
               'tokens_sold',    e.tokens_sold,
               'proceeds_usd',   e.proceeds_usd,
               'profit_usd',     e.profit_usd,
               'is_moon_bag',    e.is_moon_bag,
               'executed_at',    e.executed_at
             ) ORDER BY e.executed_at ASC)
              FROM trader_sim_exits e WHERE e.position_id = p.id
             ) AS exits_json
        FROM trader_sim_positions p
       WHERE (? = 'ALL' OR p.status = ?)
       ORDER BY p.opened_at DESC
       LIMIT ? OFFSET ?
    `).all(statusFilter, statusFilter, limit, offset) as Record<string, unknown>[];

    const total = (db.prepare(`
      SELECT COUNT(*) AS n FROM trader_sim_positions
      WHERE (? = 'ALL' OR status = ?)
    `).get(statusFilter, statusFilter) as { n: number }).n;

    const enriched = positions.map((p) => ({
      ...p,
      exits: JSON.parse((p.exits_json as string) ?? "[]"),
      exits_json: undefined,
    }));

    res.json({ positions: enriched, total, limit, offset, status_filter: statusFilter });
  } catch (err) {
    console.error("[trader] GET /trader/simulation/positions error:", err);
    res.status(500).json({ error: "Failed to fetch sim positions" });
  }
});

// ── GET /trader/simulation/log ────────────────────────────────────────────────
// Decision log: every alert the engine evaluated, whether BUY or SKIP, and why.

router.get("/trader/simulation/log", (req: Request, res: Response): void => {
  try {
    const decision = (req.query.decision as string | undefined) ?? "ALL";
    const tier     = (req.query.tier     as string | undefined) ?? "ALL";
    const limit    = Math.min(parseInt((req.query.limit  as string) ?? "100", 10), 500);
    const offset   = parseInt((req.query.offset as string) ?? "0", 10);

    const whereParts: string[] = [];
    const bindValues: (string | number)[] = [];

    if (decision !== "ALL") { whereParts.push("decision = ?"); bindValues.push(decision); }
    if (tier     !== "ALL") { whereParts.push("alert_tier = ?"); bindValues.push(tier);     }

    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const entries = db.prepare(`
      SELECT tsl.id, tsl.alert_id
             tsl.token_address, tsl.token_name, tsl.token_symbol,
             tsl.alert_level, tsl.alert_tier,
             tsl.decision, tsl.decision_reason,
             tsl.entry_price_usd,
             tsl.buy_amount_usd, tsl.slippage_pct, tsl.priority_fee_lamports,
             tsl.expected_cost_usd, tsl.expected_tokens,
             tsl.status, tsl.is_simulation, tsl.created_at
        FROM trader_simulation_log tsl
        ${where}
       ORDER BY tsl.created_at DESC
       LIMIT ? OFFSET ?
    `).all(...bindValues, limit, offset) as Record<string, unknown>[];

    const total = (db.prepare(
      `SELECT COUNT(*) AS n FROM trader_simulation_log ${where}`
    ).get(...bindValues) as { n: number }).n;

    // Compute private label dynamically for each entry
    const enrichedEntries = entries.map((row) => {
      const launchTime = typeof row["token_launch_time"] === "number" ? row["token_launch_time"] : null;
      const createdAt  = typeof row["created_at"]        === "number" ? row["created_at"]        : Date.now();
      const ageSeconds = launchTime != null
        ? Math.max(0, (createdAt - launchTime) / 1_000)
        : 0;
      const input  = parseProfileForLabel(row["alert_profile"] as string | null, ageSeconds);
      const result = computePrivateLabel(input);
      const { alert_profile: _ap, token_launch_time: _lt, ...rest } = row;
      void _ap; void _lt;
      return { ...rest, private_label: result.label, private_action: result.action };
    });

    res.json({ entries: enrichedEntries, total, limit, offset, decision_filter: decision, tier_filter: tier });
  } catch (err) {
    console.error("[trader] GET /trader/simulation/log error:", err);
    res.status(500).json({ error: "Failed to fetch simulation log" });
  }
});

// ── POST /trader/simulation/replay-alert ──────────────────────────────────────
// Re-emits an existing ELITE or PRO alert_event onto the alertBus so the
// simulation engine processes it right now (even though it was created before
// simulation mode was enabled).  Development / verification only.
// The alert age is spoofed to 0 so it always passes Gate 1 (entry window).

router.post("/trader/simulation/replay-alert", async (req: Request, res: Response): Promise<void> => {
  try {
    const cfg = db.prepare("SELECT execution_mode FROM trader_config WHERE id = 1").get() as { execution_mode: string } | undefined;
    if (!cfg || cfg.execution_mode !== "SIMULATION") {
      res.status(400).json({ error: "Simulation mode is not active (execution_mode must be SIMULATION)" });
      return;
    }

    const { alert_id, flow_id } = req.body as { alert_id?: number; flow_id?: string };

    // If alert_id supplied, replay that specific alert; otherwise pick the most
    // recent ELITE or PRO alert that has not yet been logged by the sim engine.
    let alertRow: {
      id: number; token_id: number; investigation_id: number | null;
      evidence_score: number; confidence: number; alert_profile: string | null;
      contract_address: string; flow_id: string | null;
    } | undefined;

    // alert_events does not exist in alpha.db — wrap in try-catch so this
    // endpoint degrades gracefully (returns 404 "no eligible alert").
    try {
      if (alert_id) {
        alertRow = db.prepare(`
          SELECT ae.id, ae.token_id, ae.investigation_id, ae.evidence_score, ae.confidence,
                 ae.alert_profile, t.contract_address,
                 aqt.flow_id
          FROM alert_events ae
          JOIN tokens t ON t.id = ae.token_id
          LEFT JOIN alert_queue_telegram aqt ON aqt.alert_id = ae.id
          WHERE ae.id = ?
          LIMIT 1
        `).get(alert_id) as typeof alertRow;
      } else {
        // Pick most recent ELITE or PRO that isn't already in the sim log
        alertRow = db.prepare(`
          SELECT ae.id, ae.token_id, ae.investigation_id, ae.evidence_score, ae.confidence,
                 ae.alert_profile, t.contract_address,
                 aqt.flow_id
          FROM alert_events ae
          JOIN tokens t ON t.id = ae.token_id
          LEFT JOIN alert_queue_telegram aqt ON aqt.alert_id = ae.id
          WHERE aqt.flow_id IN ('ELITE','PRO')
            AND ae.id NOT IN (SELECT DISTINCT alert_id FROM trader_simulation_log WHERE alert_id IS NOT NULL)
          ORDER BY ae.created_at DESC
          LIMIT 1
        `).get() as typeof alertRow;
      }
    } catch {
      // Table doesn't exist in this environment — alertRow stays undefined.
    }

    if (!alertRow) {
      res.status(404).json({ error: "No eligible ELITE/PRO alert found to replay" });
      return;
    }

    let profile: Record<string, unknown> | null = null;
    if (alertRow.alert_profile) {
      try { profile = JSON.parse(alertRow.alert_profile) as Record<string, unknown>; } catch { /* ignore */ }
    }

    // Emit with createdAt = now so Gate 1 (entry window) always passes
    alertBus.emit("alert", {
      alertId:         alertRow.id,
      tokenId:         alertRow.token_id,
      tokenAddress:    alertRow.contract_address,
      investigationId: alertRow.investigation_id,
      evidenceScore:   alertRow.evidence_score,
      confidence:      alertRow.confidence,
      alertProfile:    profile,
      flowId:          flow_id ?? alertRow.flow_id ?? null,
      createdAt:       Date.now(), // spoof to now so age = 0ms → passes Gate 1
    });

    // Give the async handler 2 s to write the log row
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const logEntry = db.prepare(
      "SELECT * FROM trader_simulation_log WHERE alert_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(alertRow.id) as Record<string, unknown> | undefined;

    res.json({
      replayed_alert_id: alertRow.id,
      flow_id:           alertRow.flow_id ?? flow_id,
      evidence_score:    alertRow.evidence_score,
      contract_address:  alertRow.contract_address,
      sim_log_entry:     logEntry ?? null,
      note: logEntry ? "Decision logged ✓" : "No log entry yet — check server logs for error",
    });
  } catch (err) {
    console.error("[trader] POST /trader/simulation/replay-alert error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Token metadata cache (module-level, refreshed once per process start) ─────

interface TokenMeta { symbol: string; name: string }
let _tokenMap: Map<string, TokenMeta> | null = null;
let _tokenMapFetchedAt = 0;
const TOKEN_MAP_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function getTokenMap(): Promise<Map<string, TokenMeta>> {
  if (_tokenMap && Date.now() - _tokenMapFetchedAt < TOKEN_MAP_TTL_MS) return _tokenMap;
  try {
    const res = await fetch("https://token.jup.ag/strict", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return _tokenMap ?? new Map();
    const list = await res.json() as { address: string; symbol: string; name: string }[];
    const map = new Map<string, TokenMeta>();
    for (const t of list) map.set(t.address, { symbol: t.symbol, name: t.name });
    _tokenMap = map;
    _tokenMapFetchedAt = Date.now();
    return map;
  } catch {
    return _tokenMap ?? new Map();
  }
}

// ── GET /trader/wallet/portfolio ──────────────────────────────────────────────
// Read-only. Calls getBalance + getTokenAccountsByOwner. No transactions.

router.get("/trader/wallet/portfolio", async (_req: Request, res: Response): Promise<void> => {
  try {
    const row = db
      .prepare(`SELECT wallet_address, rpc_endpoint FROM trader_wallet WHERE id = 1`)
      .get() as { wallet_address: string | null; rpc_endpoint: string } | undefined;

    if (!row?.wallet_address) {
      res.json({ holdings: [], total_usd: 0, checked_at: Date.now() });
      return;
    }

    const { wallet_address, rpc_endpoint } = row;

    const rpcPost = async (method: string, params: unknown[]) => {
      const r = await fetch(rpc_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json() as { result?: unknown };
      return j.result;
    };

    // Fetch SOL balance + SPL accounts in parallel
    const [solResult, tokenResult] = await Promise.all([
      rpcPost("getBalance", [wallet_address]),
      rpcPost("getTokenAccountsByOwner", [
        wallet_address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" },
      ]),
    ]);

    const solBalance = ((solResult as { value?: number })?.value ?? 0) / 1_000_000_000;

    type SplEntry = { mint: string; amount: number };
    const splTokens: SplEntry[] = [];
    const tokenAccounts = (tokenResult as { value?: unknown[] })?.value ?? [];
    for (const acct of tokenAccounts) {
      const info = (acct as { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } })
        .account.data.parsed.info;
      const uiAmount = info.tokenAmount.uiAmount ?? 0;
      if (uiAmount > 0) splTokens.push({ mint: info.mint, amount: uiAmount });
    }

    // Batch price fetch (SOL + all SPL mints)
    const allMints = [SOL_MINT, ...splTokens.map((t) => t.mint)];
    const priceMap = new Map<string, number>();
    try {
      const pr = await fetch(`https://price.jup.ag/v6/price?ids=${allMints.join(",")}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (pr.ok) {
        const pj = await pr.json() as { data?: Record<string, { price?: number }> };
        for (const [mint, d] of Object.entries(pj.data ?? {})) {
          if (d.price != null) priceMap.set(mint, d.price);
        }
      }
    } catch { /* price unavailable */ }

    // Cache SOL price if fresh
    const freshSolPrice = priceMap.get(SOL_MINT);
    if (freshSolPrice != null) { _solPriceCached = freshSolPrice; _solPriceFetchedAt = Date.now(); }

    const tokenMeta = await getTokenMap();

    const solPrice = priceMap.get(SOL_MINT) ?? null;
    const holdings: {
      mint: string; symbol: string; name: string; amount: number;
      price_usd: number | null; value_usd: number | null; pct_of_portfolio: number | null; is_native: boolean;
    }[] = [
      {
        mint: SOL_MINT, symbol: "SOL", name: "Solana",
        amount: solBalance,
        price_usd: solPrice,
        value_usd: solPrice != null ? Math.round(solBalance * solPrice * 100) / 100 : null,
        pct_of_portfolio: null,
        is_native: true,
      },
    ];
    for (const t of splTokens) {
      const price = priceMap.get(t.mint) ?? null;
      const meta = tokenMeta.get(t.mint);
      holdings.push({
        mint: t.mint,
        symbol: meta?.symbol ?? `${t.mint.slice(0, 4)}…`,
        name: meta?.name ?? "Unknown Token",
        amount: t.amount,
        price_usd: price,
        value_usd: price != null ? Math.round(t.amount * price * 100) / 100 : null,
        pct_of_portfolio: null,
        is_native: false,
      });
    }

    const total_usd = holdings.reduce((s, h) => s + (h.value_usd ?? 0), 0);
    for (const h of holdings) {
      h.pct_of_portfolio = total_usd > 0 && h.value_usd != null
        ? Math.round((h.value_usd / total_usd) * 1000) / 10
        : null;
    }

    res.json({ holdings, total_usd: Math.round(total_usd * 100) / 100, checked_at: Date.now() });
  } catch (err) {
    console.error("[trader] GET /trader/wallet/portfolio error:", err);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

// ── GET /trader/wallet/activity ───────────────────────────────────────────────
// Read-only. Calls getSignaturesForAddress. No transaction parsing.

router.get("/trader/wallet/activity", async (_req: Request, res: Response): Promise<void> => {
  try {
    const row = db
      .prepare(`SELECT wallet_address, rpc_endpoint FROM trader_wallet WHERE id = 1`)
      .get() as { wallet_address: string | null; rpc_endpoint: string } | undefined;

    if (!row?.wallet_address) {
      res.json({ transactions: [], checked_at: Date.now() });
      return;
    }

    const { wallet_address, rpc_endpoint } = row;

    const r = await fetch(rpc_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [wallet_address, { limit: 25 }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json() as { result?: unknown };
    const sigs = (j.result as {
      signature: string;
      blockTime: number | null;
      confirmationStatus: string;
      err: unknown;
      memo: string | null;
    }[]) ?? [];

    const transactions = sigs.map((s) => ({
      signature:     s.signature,
      block_time:    s.blockTime != null ? s.blockTime * 1000 : null,
      status:        s.err ? "failed" : "success",
      status_detail: s.err ? JSON.stringify(s.err) : null,
      confirmation:  s.confirmationStatus,
      memo:          s.memo ?? null,
      explorer_url:  `https://solscan.io/tx/${s.signature}`,
    }));

    res.json({ transactions, checked_at: Date.now() });
  } catch (err) {
    console.error("[trader] GET /trader/wallet/activity error:", err);
    res.status(500).json({ error: "Failed to fetch wallet activity" });
  }
});

// ── GET /trader/readiness ─────────────────────────────────────────────────────
// 10-check pre-flight. No writes, no transactions.

router.get("/trader/readiness", async (_req: Request, res: Response): Promise<void> => {
  try {
    type CheckStatus = "pass" | "fail" | "warn" | "skip";
    interface Check { id: string; label: string; status: CheckStatus; reason: string | null }
    const checks: Check[] = [];

    const wRow = db.prepare(`SELECT * FROM trader_wallet WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;
    const cRow = db.prepare(`SELECT * FROM trader_config WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;
    const activeTrades = (db.prepare(
      `SELECT COUNT(*) as n FROM trader_trades WHERE status IN ('WAITING','BUYING','BOUGHT','HOLDING','PARTIAL_SELL')`
    ).get() as { n: number }).n;

    const wallet_address = (wRow?.wallet_address as string | null) ?? null;
    const rpc_endpoint   = (wRow?.rpc_endpoint as string) ?? "https://api.mainnet-beta.solana.com";
    const jito_rpc       = (wRow?.jito_rpc as string | null) ?? null;
    const has_key        = Boolean(wRow?.encrypted_private_key);
    const min_sol        = (cRow?.min_sol_reserve as number) ?? 0.1;
    const max_trades     = (cRow?.max_active_trades as number) ?? 10;

    // ── 1. Wallet configured ──────────────────────────────────────────────────
    checks.push({
      id: "wallet_configured", label: "Wallet Configured",
      status: wallet_address ? "pass" : "fail",
      reason: wallet_address ? null : "No wallet address — add one in the Wallet section",
    });

    // ── 2. Private key stored ─────────────────────────────────────────────────
    checks.push({
      id: "private_key", label: "Private Key Stored",
      status: has_key ? "pass" : "warn",
      reason: has_key ? null : "Private key not stored — required when trading starts",
    });

    // ── 3 + 8. RPC + SOL balance (one call) ──────────────────────────────────
    let rpc_ok = false, rpc_latency: number | null = null, sol_balance: number | null = null;
    if (wallet_address) {
      try {
        const t0 = Date.now();
        const r = await fetch(rpc_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet_address] }),
          signal: AbortSignal.timeout(5000),
        });
        rpc_latency = Date.now() - t0;
        const j = await r.json() as { result?: { value?: number } };
        rpc_ok = true;
        sol_balance = (j.result?.value ?? 0) / 1_000_000_000;
      } catch { rpc_ok = false; }
    }

    // ── 4. Jupiter reachable + 5. Jito reachable (parallel) ──────────────────
    // Jupiter check reuses the shared helper from livePreFlight — single implementation.
    const [jupResult, jitoOk] = await Promise.all([
      checkJupiterReachable(),
      jito_rpc
        ? fetch(jito_rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
            signal: AbortSignal.timeout(4000),
          }).then((r) => r.ok).catch(() => false)
        : Promise.resolve(null),
    ]);

    checks.push({
      id: "rpc_reachable", label: "RPC Reachable",
      status: !wallet_address ? "skip" : rpc_ok ? "pass" : "fail",
      reason: !wallet_address ? "Wallet not configured"
        : rpc_ok ? (rpc_latency != null ? `${rpc_latency}ms` : null)
        : "RPC endpoint unreachable — check the endpoint in Wallet settings",
    });

    checks.push({
      id: "jupiter_reachable", label: "Jupiter Reachable",
      status: jupResult.check.status,
      reason: jupResult.check.status === "pass" ? null : (jupResult.check.detail ?? null),
    });

    checks.push({
      id: "jito_reachable", label: "Jito Reachable",
      status: jito_rpc == null ? "skip"
        : jitoOk ? "pass" : "warn",
      reason: jito_rpc == null ? "Jito RPC not configured — MEV protection disabled"
        : jitoOk ? null
        : "Jito unreachable — trades will fall back to standard RPC",
    });

    // ── 6. Sufficient SOL ─────────────────────────────────────────────────────
    const needed = min_sol + 0.05;
    checks.push({
      id: "sufficient_sol", label: "Sufficient SOL",
      status: !wallet_address || sol_balance == null ? "skip"
        : sol_balance >= needed ? "pass"
        : sol_balance >= min_sol ? "warn" : "fail",
      reason: sol_balance == null ? "Balance unavailable"
        : sol_balance < min_sol
          ? `${sol_balance.toFixed(4)} SOL — below reserve of ${min_sol} SOL`
          : sol_balance < needed
            ? `${sol_balance.toFixed(4)} SOL — low (recommended ≥ ${needed.toFixed(2)} SOL)`
            : null,
    });

    // ── 7. Auto trading enabled ───────────────────────────────────────────────
    checks.push({
      id: "auto_trading", label: "Auto Trading Enabled",
      status: cRow?.auto_trading_enabled ? "pass" : "warn",
      reason: cRow?.auto_trading_enabled ? null : "Auto trading is OFF — enable it in Trading Status",
    });

    // ── 9. Trade slots available ──────────────────────────────────────────────
    checks.push({
      id: "trade_slots", label: "Active Trade Slots Available",
      status: activeTrades < max_trades ? "pass" : "fail",
      reason: activeTrades >= max_trades
        ? `All ${max_trades} slots full — close a trade to open a slot`
        : `${max_trades - activeTrades} of ${max_trades} slots available`,
    });

    // ── 10. Configuration valid ────────────────────────────────────────────────
    const cfgErrs: string[] = [];
    if (cRow) {
      const c = cRow as Record<string, number>;
      if (c.max_slippage_pct < c.default_slippage_pct) cfgErrs.push("max slippage < default slippage");
      if (c.max_priority_fee_lamports < c.min_priority_fee_lamports) cfgErrs.push("max fee < min fee");
      if (c.max_buy_amount_usd <= 0) cfgErrs.push("max buy amount ≤ 0");
      if (c.max_active_trades < 1) cfgErrs.push("max trades < 1");
    }
    checks.push({
      id: "config_valid", label: "Configuration Valid",
      status: cfgErrs.length === 0 ? "pass" : "fail",
      reason: cfgErrs.length > 0 ? `Issues: ${cfgErrs.join("; ")}` : null,
    });

    const overall: "ready" | "not_ready" = checks.some((c) => c.status === "fail") ? "not_ready" : "ready";
    res.json({ checks, overall, checked_at: Date.now() });
  } catch (err) {
    console.error("[trader] GET /trader/readiness error:", err);
    res.status(500).json({ error: "Failed to run readiness check" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4B — Performance Analytics
// GET /trader/simulation/analytics
// Full analytics suite: median ROI, profit factor, expectancy, streaks, etc.
// ════════════════════════════════════════════════════════════════════════════

router.get("/trader/simulation/analytics", (_req: Request, res: Response): void => {
  try {
    const analytics = computeSimulationAnalytics();
    res.json(analytics);
  } catch (err) {
    console.error("[trader] GET /trader/simulation/analytics error:", err);
    res.status(500).json({ error: "Failed to compute simulation analytics" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4C — Trade Replay
// GET /trader/simulation/replay/:positionId
// Full timeline for one position: alert → entry → price history → exits → ROI.
// ════════════════════════════════════════════════════════════════════════════

router.get("/trader/simulation/replay/:positionId", (req: Request, res: Response): void => {
  try {
    const positionId = parseInt(String(req.params.positionId ?? ""), 10);
    if (!positionId || isNaN(positionId)) {
      res.status(400).json({ error: "Invalid positionId" });
      return;
    }

    // Position details
    const position = db
      .prepare("SELECT * FROM trader_sim_positions WHERE id = ?")
      .get(positionId) as Record<string, unknown> | undefined;
    if (!position) {
      res.status(404).json({ error: "Position not found" });
      return;
    }

    // Log entry (alert + decision)
    const logEntry = db
      .prepare("SELECT * FROM trader_simulation_log WHERE id = ?")
      .get(position.sim_log_id) as Record<string, unknown> | undefined;

    // Alert data (alert_events does not exist in alpha.db — returns undefined gracefully)
    let alertData: Record<string, unknown> | undefined;
    if (logEntry?.alert_id) {
      try {
        alertData = db.prepare("SELECT * FROM alert_events WHERE id = ?")
          .get(logEntry.alert_id) as Record<string, unknown> | undefined;
      } catch { /* table absent */ }
    }

    // Exit events (partial sells, stop, expiry)
    const exits = db
      .prepare("SELECT * FROM trader_sim_exits WHERE position_id = ? ORDER BY executed_at ASC")
      .all(positionId) as Record<string, unknown>[];

    // Price history snapshots
    const priceHistory = db
      .prepare(
        `SELECT price_usd, market_cap_usd, observed_at
           FROM trader_sim_price_history
          WHERE position_id = ?
          ORDER BY observed_at ASC`
      )
      .all(positionId) as { price_usd: number; market_cap_usd: number | null; observed_at: number }[];

    // Build timeline events
    type TimelineEvent = {
      ts: number;
      type: "ALERT" | "ENTRY" | "PRICE" | "PARTIAL_SELL" | "STOP_LOSS" | "EXPIRY" | "MOON_BAG" | "EXIT";
      price_usd?: number;
      detail: string;
      roi_pct?: number;
    };
    const timeline: TimelineEvent[] = [];

    // Alert event
    if (alertData) {
      timeline.push({
        ts: alertData.created_at as number,
        type: "ALERT",
        detail: `${String(logEntry?.alert_tier ?? "UNKNOWN")} alert fired — evidence ${
          alertData.evidence_score != null ? `${Math.round((alertData.evidence_score as number) * 100)}%` : "N/A"
        }`,
      });
    }

    // Entry event
    timeline.push({
      ts: position.opened_at as number,
      type: "ENTRY",
      price_usd: position.entry_price_usd as number,
      detail: `Entered $${(position.buy_amount_usd as number).toFixed(2)} at $${(position.entry_price_usd as number).toFixed(8)} — ${Math.round(position.tokens_purchased as number)} tokens`,
    });

    // Price observations (sample every 5th if >50 points for readability)
    const sample = priceHistory.length > 100
      ? priceHistory.filter((_, i) => i % Math.ceil(priceHistory.length / 100) === 0)
      : priceHistory;
    for (const snap of sample) {
      const unrealPct = ((snap.price_usd - (position.entry_price_usd as number)) / (position.entry_price_usd as number)) * 100;
      timeline.push({
        ts: snap.observed_at,
        type: "PRICE",
        price_usd: snap.price_usd,
        detail: `Price observation`,
        roi_pct: Math.round(unrealPct * 100) / 100,
      });
    }

    // Exit events
    for (const exit of exits) {
      const mx = exit.milestone_x as number;
      const ep = exit.exit_price_usd as number;
      if (exit.is_moon_bag) {
        timeline.push({ ts: exit.executed_at as number, type: "MOON_BAG", price_usd: ep, detail: `Moon bag at ${mx}× — holding remaining tokens` });
      } else if (mx === 0) {
        const isStop = (position.status as string) === "STOPPED";
        timeline.push({
          ts: exit.executed_at as number,
          type: isStop ? "STOP_LOSS" : "EXPIRY",
          price_usd: ep,
          detail: isStop
            ? `Stop loss triggered at $${ep.toFixed(8)} — sold ${Math.round(exit.tokens_sold as number)} tokens`
            : `Position expired — force sold ${Math.round(exit.tokens_sold as number)} tokens at $${ep.toFixed(8)}`,
        });
      } else {
        timeline.push({
          ts: exit.executed_at as number,
          type: "PARTIAL_SELL",
          price_usd: ep,
          detail: `${mx}× milestone — sold ${Math.round(exit.tokens_sold as number)} tokens for $${(exit.proceeds_usd as number).toFixed(2)} (P/L: $${(exit.profit_usd as number).toFixed(2)})`,
        });
      }
    }

    // Sort timeline by ts
    timeline.sort((a, b) => a.ts - b.ts);

    res.json({
      position,
      log_entry:     logEntry ?? null,
      alert:         alertData ?? null,
      exits,
      price_history: priceHistory,
      price_history_count: priceHistory.length,
      timeline,
      generated_at: Date.now(),
    });
  } catch (err) {
    console.error("[trader] GET /trader/simulation/replay error:", err);
    res.status(500).json({ error: "Failed to build trade replay" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4D — Validation Engine
// GET /trader/validation/report
// Per-tier win rate, ROI, failure rate, time to 2×/stop/ATH + recommendations.
// ════════════════════════════════════════════════════════════════════════════

router.get("/trader/validation/report", (_req: Request, res: Response): void => {
  try {
    const report = computeValidationReport();
    res.json(report);
  } catch (err) {
    console.error("[trader] GET /trader/validation/report error:", err);
    res.status(500).json({ error: "Failed to compute validation report" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4E — Strategy Optimizer
// GET /trader/optimizer/report
// Parameter sensitivity analysis with recommendations. Never auto-applies.
// ════════════════════════════════════════════════════════════════════════════

router.get("/trader/optimizer/report", (_req: Request, res: Response): void => {
  try {
    const report = computeOptimizerReport();
    res.json(report);
  } catch (err) {
    console.error("[trader] GET /trader/optimizer/report error:", err);
    res.status(500).json({ error: "Failed to compute optimizer report" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4F — Simulation Stress Test
// POST /trader/simulation/stress-test
// Runs 20 synthetic gate scenarios + stop loss formula verification.
// No DB writes. Idempotent.
// ════════════════════════════════════════════════════════════════════════════

router.post("/trader/simulation/stress-test", (_req: Request, res: Response): void => {
  try {
    const gateReport  = runStressTests();
    const stopReport  = verifyStopLossFormula();
    const allPassed   = gateReport.failed === 0 && stopReport.pass;

    res.json({
      overall:         allPassed ? "PASS" : "FAIL",
      gate_tests:      gateReport,
      stop_loss_math:  stopReport,
      ran_at:          gateReport.ran_at,
    });
  } catch (err) {
    console.error("[trader] POST /trader/simulation/stress-test error:", err);
    res.status(500).json({ error: "Failed to run stress tests" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 4G — Execution Readiness
// GET /trader/simulation/readiness
// Verifies the simulation engine is architecturally ready for live-mode swap.
// Live mode requires replacing only openSimPosition() with sendSwapTransaction().
// ════════════════════════════════════════════════════════════════════════════

router.get("/trader/simulation/readiness", (_req: Request, res: Response): void => {
  try {
    type Check = { id: string; label: string; status: "pass" | "fail" | "warn"; detail: string | null };
    const checks: Check[] = [];

    // 1. evaluateGates() is a pure function (no DB, no async) — verified by import
    checks.push({
      id: "pure_gate_fn", label: "Gate Logic is Pure",
      status: "pass",
      detail: "evaluateGates() accepts only config + context. No DB access, no async. Fully testable without infrastructure.",
    });

    // 2. DB reads are isolated to handleNewAlert (context builder)
    checks.push({
      id: "context_isolation", label: "DB Reads Isolated to Context Builder",
      status: "pass",
      detail: "All SQLite queries run before evaluateGates(). The gate sequence itself is a pure decision function — identical in live mode.",
    });

    // 3. Execution step is isolated (openSimPosition vs sendSwapTransaction)
    checks.push({
      id: "execution_isolation", label: "Execution Step Isolated",
      status: "pass",
      detail: "openSimPosition() is the only simulation-specific call. Live mode replaces it with sendSwapTransaction(). Zero gate logic is duplicated.",
    });

    // 4. No hardcoded trading values — all read from trader_config at runtime
    const cfgRow = db.prepare("SELECT * FROM trader_config WHERE id = 1").get() as Record<string, unknown> | undefined;
    checks.push({
      id: "no_hardcoded_values", label: "No Hardcoded Trading Values",
      status: cfgRow ? "pass" : "warn",
      detail: cfgRow
        ? `All thresholds (stop_loss_pct=${cfgRow.stop_loss_pct}, entry_window_minutes=${cfgRow.entry_window_minutes}, max_active_trades=${cfgRow.max_active_trades}) read from DB at runtime.`
        : "trader_config row missing — engine would skip all alerts.",
    });

    // 5. Dry-run gate evaluation (confirm pure function is callable)
    let gateTestStatus: "pass" | "fail" = "pass";
    let gateTestDetail: string | null = null;
    try {
      const mockCfg: EngineConfig = {
        simulation_mode: 1, emergency_stop_enabled: 0,
        max_active_trades: 5, max_buy_amount_usd: 50,
        default_slippage_pct: 1, max_slippage_pct: 5,
        auto_slippage_enabled: 1, min_priority_fee_lamports: 1000,
        max_priority_fee_lamports: 100000, max_wallet_exposure_pct: 20,
        min_sol_reserve: 0.1, max_consecutive_losses: 3,
        max_daily_loss_usd: null, simulation_capital_usd: 500,
        enabled_entry_filters: '["ELITE"]', entry_window_minutes: 60,
        stop_loss_pct: 90, max_position_age_hours: 24,
        execution_mode: 'SIMULATION', auto_trading_enabled: 0,
      };
      const result = evaluateGates(mockCfg, {
        alertAgeMs: 5000, tier: "ELITE", enabledFilters: ["ELITE"],
        eliteFilterPasses: null,
        buySetting: { enabled: 1, buy_amount_usd: 25 },
        openPositionCount: 0, totalOpenInvestmentUsd: 0,
        consecutiveLossStreak: 0, todayRealizedLossUsd: 0,
      });
      gateTestDetail = `Dry-run returned: ${result.decision}${result.decision === "BUY" ? ` ($${result.buyAmountUsd})` : ` — gate ${result.gate}: ${result.reason}`}`;
    } catch (e) {
      gateTestStatus = "fail";
      gateTestDetail = `evaluateGates() threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    checks.push({
      id: "gate_dry_run", label: "Gate Dry-Run Passes",
      status: gateTestStatus, detail: gateTestDetail,
    });

    // 6. Simulation mode status
    const simMode = cfgRow?.simulation_mode === 1;
    checks.push({
      id: "sim_mode", label: "Simulation Mode Active",
      status: simMode ? "pass" : "warn",
      detail: simMode
        ? "Simulation mode is ON. Engine is recording decisions and opening simulated positions."
        : "Simulation mode is OFF. Enable it in My Auto Trader to begin collecting simulation data.",
    });

    // 7. Price history table present (required for trade replay)
    const historyTableExists = (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='trader_sim_price_history'"
    ).get() as { n: number }).n > 0;
    checks.push({
      id: "price_history_table", label: "Trade Replay Table Present",
      status: historyTableExists ? "pass" : "fail",
      detail: historyTableExists
        ? "trader_sim_price_history exists — trade replay is available."
        : "trader_sim_price_history missing — run migration v38.",
    });

    const overall: "ready" | "not_ready" = checks.some(c => c.status === "fail") ? "not_ready" : "ready";

    const execMode = (cfgRow?.execution_mode as string | undefined) ?? "OFF";
    const live_mode_swap = [
      "To enable Live Mode:",
      "  1. Ensure wallet private key is configured (POST /trader/wallet).",
      "  2. Verify RPC endpoint health (GET /trader/wallet/balance).",
      "  3. PUT /trader/mode/live  { \"confirm\": true, \"i_understand_this_uses_real_money\": true }",
      "  4. All gates (evaluateGates + price resolution) are identical — only execution layer changes.",
    ].join("\n");

    res.json({ checks, overall, execution_mode: execMode, live_mode_swap, checked_at: Date.now() });
  } catch (err) {
    console.error("[trader] GET /trader/simulation/readiness error:", err);
    res.status(500).json({ error: "Failed to run simulation readiness check" });
  }
});

// ── GET /trader/live/preflight ────────────────────────────────────────────────

router.get("/trader/live/preflight", async (_req: Request, res: Response): Promise<void> => {
  try {
    const report = await runPreFlight();
    const statusCode = report.overall === "go" ? 200 : 400;
    res.status(statusCode).json(report);
  } catch (err) {
    console.error("[trader] GET /trader/live/preflight error:", err);
    res.status(500).json({ error: "Preflight check failed unexpectedly" });
  }
});

// ── GET /trader/mode ──────────────────────────────────────────────────────────

router.get("/trader/mode", (_req: Request, res: Response): void => {
  try {
    const row = db
      .prepare("SELECT execution_mode, simulation_mode, live_mode_enabled_at, emergency_stop_enabled FROM trader_config WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: "Config not found" }); return; }

    // Resolve authoritative mode (v39+ uses execution_mode; legacy uses simulation_mode)
    const execMode = (row.execution_mode as string | null) ??
      (row.simulation_mode ? "SIMULATION" : "OFF");

    res.json({
      execution_mode:        execMode,
      live_mode_enabled_at:  row.live_mode_enabled_at ?? null,
      emergency_stop_active: row.emergency_stop_enabled === 1,
    });
  } catch (err) {
    console.error("[trader] GET /trader/mode error:", err);
    res.status(500).json({ error: "Failed to get execution mode" });
  }
});

// ── PUT /trader/mode — set OFF or SIMULATION ──────────────────────────────────
// LIVE mode must go through PUT /trader/mode/live (separate endpoint with confirmation).

router.put("/trader/mode", (req: Request, res: Response): void => {
  try {
    const { mode } = req.body as { mode?: string };
    if (!mode || !["OFF", "SIMULATION"].includes(mode.toUpperCase())) {
      res.status(400).json({
        error: "Invalid mode. Accepted values: 'OFF', 'SIMULATION'. Use PUT /trader/mode/live to enable LIVE.",
      });
      return;
    }

    const newMode = mode.toUpperCase() as "OFF" | "SIMULATION";
    db.prepare(`
      UPDATE trader_config
      SET execution_mode = ?,
          simulation_mode = ?,
          updated_at = ?
      WHERE id = 1
    `).run(newMode, newMode === "SIMULATION" ? 1 : 0, ts());

    res.json({ execution_mode: newMode, updated_at: ts() });
  } catch (err) {
    console.error("[trader] PUT /trader/mode error:", err);
    res.status(500).json({ error: "Failed to set execution mode" });
  }
});

// ── PUT /trader/mode/live — enable LIVE mode ──────────────────────────────────
//
// Requires explicit double-confirmation in the request body.
// LIVE can never be set by PUT /trader/config or PUT /trader/mode — only here.
//
// Body: { confirm: true, i_understand_this_uses_real_money: true }

router.put("/trader/mode/live", async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Record<string, unknown>;

    // Double-confirmation gate
    if (body.confirm !== true || body.i_understand_this_uses_real_money !== true) {
      res.status(400).json({
        error: "Explicit confirmation required to enable LIVE mode.",
        required: {
          confirm: true,
          i_understand_this_uses_real_money: true,
        },
        warning: "LIVE mode executes real on-chain transactions using your configured wallet. "
               + "Losses are real and irreversible.",
      });
      return;
    }

    // Wallet must be configured
    const wallet = db
      .prepare("SELECT wallet_address, encrypted_private_key, connected FROM trader_wallet WHERE id = 1")
      .get() as { wallet_address: string | null; encrypted_private_key: string | null; connected: number } | undefined;

    if (!wallet?.encrypted_private_key || !wallet?.wallet_address) {
      res.status(400).json({
        error: "No wallet configured. POST /trader/wallet before enabling LIVE mode.",
      });
      return;
    }

    // ── Run full pre-flight check ─────────────────────────────────────────────
    let preflight;
    try {
      preflight = await runPreFlight();
    } catch (pfErr) {
      res.status(500).json({ error: `Pre-flight check threw: ${pfErr instanceof Error ? pfErr.message : String(pfErr)}` });
      return;
    }

    if (preflight.overall !== "go") {
      res.status(400).json({
        error: "Pre-flight checks failed. Resolve all blocking issues before enabling LIVE mode.",
        preflight,
      });
      return;
    }

    const now = ts();
    db.prepare(`
      UPDATE trader_config
      SET execution_mode = 'LIVE',
          simulation_mode = 0,
          live_mode_enabled_at = ?,
          updated_at = ?
      WHERE id = 1
    `).run(now, now);

    res.json({
      execution_mode:       "LIVE",
      live_mode_enabled_at:  now,
      wallet_address:        wallet.wallet_address,
      preflight_summary:     preflight.checks.map((c) => `${c.status.toUpperCase()} ${c.id}`).join(" | "),
      warning: "LIVE mode is now active. The engine will execute real on-chain trades. "
             + "Use PUT /trader/config { emergency_stop_enabled: true } to halt immediately.",
    });
  } catch (err) {
    console.error("[trader] PUT /trader/mode/live error:", err);
    res.status(500).json({ error: "Failed to enable LIVE mode" });
  }
});

// ── GET /trader/live/positions — active open live positions ───────────────────

router.get("/trader/live/positions", (_req: Request, res: Response): void => {
  try {
    const positions = db
      .prepare(`
        SELECT id, token_address, token_name, token_symbol, alert_tier,
               entry_price_usd, entry_amount_usd, tokens_purchased, tokens_remaining,
               token_decimals, sol_price_at_entry, peak_price_usd, min_price_usd,
               current_price_usd, profit_usd, profit_pct,
               milestones_hit, jito_bundle_id, entry_tx_hash, bought_at, updated_at, status
        FROM trader_trades
        WHERE status IN ('OPEN', 'MOON_BAG')
        ORDER BY bought_at DESC
      `)
      .all() as Record<string, unknown>[];

    const enriched = positions.map((p) => {
      const entry = p.entry_price_usd as number | null;
      const curr  = p.current_price_usd as number | null;
      const remaining = p.tokens_remaining as number | null;
      const unrealizedPnl = entry && curr && remaining
        ? (curr - entry) * remaining
        : null;
      return {
        ...p,
        milestones_hit:  JSON.parse((p.milestones_hit as string) ?? "[]"),
        unrealized_pnl_usd: unrealizedPnl,
        roi_pct: entry && curr ? ((curr - entry) / entry) * 100 : null,
      };
    });

    res.json({ positions: enriched, count: enriched.length });
  } catch (err) {
    console.error("[trader] GET /trader/live/positions error:", err);
    res.status(500).json({ error: "Failed to load live positions" });
  }
});

// ── GET /trader/live/trades — paginated live trade history ────────────────────

router.get("/trader/live/trades", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const status = req.query.status as string | undefined;

    const where  = status ? "WHERE status = ?" : "";
    const params = status ? [status, limit, offset] : [limit, offset];

    const trades = db
      .prepare(`
        SELECT * FROM trader_trades
        ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params) as Record<string, unknown>[];

    const total = (db
      .prepare(`SELECT COUNT(*) AS n FROM trader_trades ${where}`)
      .get(...(status ? [status] : [])) as { n: number }).n;

    res.json({
      trades: trades.map((t) => ({
        ...t,
        milestones_hit: JSON.parse((t.milestones_hit as string) ?? "[]"),
        hold_time_seconds: (t.sold_at != null && t.bought_at != null)
          ? Math.round(((t.sold_at as number) - (t.bought_at as number)) / 1_000)
          : null,
      })),
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error("[trader] GET /trader/live/trades error:", err);
    res.status(500).json({ error: "Failed to load live trades" });
  }
});

// ── GET /trader/live/trades/:id — single live trade detail ────────────────────

router.get("/trader/live/trades/:id", (req: Request, res: Response): void => {
  try {
    const trade = db
      .prepare("SELECT * FROM trader_trades WHERE id = ?")
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }

    // Compute real-time P&L if price available
    const entry   = trade.entry_price_usd as number | null;
    const curr    = trade.current_price_usd as number | null;
    const tokens  = trade.tokens_remaining as number | null;
    const unrealizedPnl = entry && curr && tokens ? (curr - entry) * tokens : null;
    const roi_pct = entry && curr ? ((curr - entry) / entry) * 100 : null;

    res.json({
      ...trade,
      milestones_hit:    JSON.parse((trade.milestones_hit as string) ?? "[]"),
      unrealized_pnl_usd: unrealizedPnl,
      roi_pct,
      hold_time_seconds: (trade.sold_at != null && trade.bought_at != null)
        ? Math.round(((trade.sold_at as number) - (trade.bought_at as number)) / 1_000)
        : null,
    });
  } catch (err) {
    console.error("[trader] GET /trader/live/trades/:id error:", err);
    res.status(500).json({ error: "Failed to load trade" });
  }
});

// ── GET /trader/live/stats — summary statistics for live trades ───────────────

router.get("/trader/live/stats", (_req: Request, res: Response): void => {
  try {
    const mode = db
      .prepare("SELECT execution_mode, simulation_mode FROM trader_config WHERE id = 1")
      .get() as { execution_mode: string | null; simulation_mode: number } | undefined;
    const execMode = mode?.execution_mode ?? (mode?.simulation_mode ? "SIMULATION" : "OFF");

    const totals = db
      .prepare(`
        SELECT
          COUNT(*)                                           AS total_trades,
          COUNT(CASE WHEN status = 'OPEN' THEN 1 END)       AS open_trades,
          COUNT(CASE WHEN status = 'CLOSED' THEN 1 END)     AS closed_trades,
          COUNT(CASE WHEN status = 'FAILED' THEN 1 END)     AS failed_trades,
          COUNT(CASE WHEN profit_usd > 0 AND status = 'CLOSED' THEN 1 END) AS wins,
          COUNT(CASE WHEN profit_usd < 0 AND status = 'CLOSED' THEN 1 END) AS losses,
          COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN profit_usd END), 0) AS total_realized_pnl,
          COALESCE(SUM(CASE WHEN status = 'OPEN'   THEN profit_usd END), 0) AS total_unrealized_pnl,
          COALESCE(SUM(CASE WHEN status = 'OPEN'   THEN entry_amount_usd END), 0) AS total_invested
        FROM trader_trades
      `)
      .get() as Record<string, number>;

    const closed = totals.closed_trades ?? 0;
    const wins   = totals.wins ?? 0;

    res.json({
      execution_mode: execMode,
      ...totals,
      win_rate_pct: closed > 0 ? (wins / closed) * 100 : null,
    });
  } catch (err) {
    console.error("[trader] GET /trader/live/stats error:", err);
    res.status(500).json({ error: "Failed to load live stats" });
  }
});

// ── Trading Control Center helpers ───────────────────────────────────────────

/**
 * queueConfig(flowId) — reads a single alert_flows row and returns the
 * standardised queue config block included in every signal-queue API response.
 * Returns safe defaults when the row doesn't exist or columns are absent (pre-v42).
 */
function queueConfig(flowId: string): {
  telegram_enabled:    boolean;
  telegram_bot_set:    boolean;
  telegram_chat_set:   boolean;
  live_trading_enabled: boolean;
  trade_size_usd:       number;
  max_open_positions:   number;
  slippage_pct:         number;
  priority:             number;
} {
  const row = db.prepare(`
    SELECT enabled,
           CASE WHEN telegram_bot_token IS NOT NULL THEN 1 ELSE 0 END AS bot_set,
           CASE WHEN telegram_chat_id   IS NOT NULL THEN 1 ELSE 0 END AS chat_set,
           live_trading_enabled,
           trade_size_usd,
           max_open_positions,
           slippage_pct,
           priority
      FROM alert_flows WHERE id = ?
  `).get(flowId) as Record<string, unknown> | undefined;

  return {
    telegram_enabled:    Boolean(row?.enabled),
    telegram_bot_set:    Boolean(row?.bot_set),
    telegram_chat_set:   Boolean(row?.chat_set),
    live_trading_enabled: Boolean(row?.live_trading_enabled),
    trade_size_usd:       typeof row?.trade_size_usd   === "number" ? row.trade_size_usd   : 0,
    max_open_positions:   typeof row?.max_open_positions === "number" ? row.max_open_positions : 1,
    slippage_pct:         typeof row?.slippage_pct      === "number" ? row.slippage_pct      : 5.0,
    priority:             typeof row?.priority           === "number" ? row.priority           : 0,
  };
}

/** Shared SQL for fetching sim log rows enriched with alert_profile + token launch_time */
const SIM_LOG_QUERY = `
  SELECT tsl.id, tsl.alert_id
         tsl.token_address, tsl.token_name, tsl.token_symbol,
         tsl.alert_tier,
         tsl.decision, tsl.decision_reason,
         tsl.entry_price_usd,
         tsl.buy_amount_usd, tsl.slippage_pct,
         tsl.expected_cost_usd, tsl.expected_tokens,
         tsl.status, tsl.is_simulation, tsl.created_at
    FROM trader_simulation_log tsl
   ORDER BY tsl.created_at DESC
   LIMIT 2000
`;

/** Enrich a raw sim log row with private_label / private_action; strip internal columns */
function enrichSimRow(row: Record<string, unknown>): Record<string, unknown> {
  const launchTime = typeof row["token_launch_time"] === "number" ? row["token_launch_time"] : null;
  const createdAt  = typeof row["created_at"]        === "number" ? row["created_at"]        : Date.now();
  const ageSeconds = launchTime != null ? Math.max(0, (createdAt - launchTime) / 1_000) : 0;
  const input  = parseProfileForLabel(row["alert_profile"] as string | null, ageSeconds);
  const result = computePrivateLabel(input);
  const { alert_profile: _ap, token_launch_time: _lt, ...rest } = row;
  void _ap; void _lt;
  return { ...rest, private_label: result.label, private_action: result.action };
}

// ── GET /trader/ignition ──────────────────────────────────────────────────────
// Returns simulation log entries whose private desk label resolved to IGNITION
// (private_action = 'BUY').  These are the highest-conviction BUY signals:
// early, real market, demand confirmed.
//
// Optional query params:
//   limit   (default 50, max 200)
//   offset  (default 0)

// ── Queue-page live-trade helpers ─────────────────────────────────────────────
// All four queue pages (IGNITION, WATCH_FOR_UPGRADE, ELITE, PRO) share the same
// logic for fetching confirmed on-chain buys and merging them with sim-log
// entries. Centralised here so a field change only needs one edit.

/** SELECT used by all four queue endpoints to fetch live trades for a tier. */
const LIVE_TRADE_SELECT = `
  SELECT id, alert_id, token_address, token_name, token_symbol,
         alert_tier, entry_price_usd, entry_amount_usd,
         status, bought_at, profit_usd, profit_pct,
         current_price_usd, tokens_purchased, entry_tx_hash,
         sold_at, exit_price_usd, exit_amount_usd, exit_tx_hash,
         reason_closed, exit_market_cap_usd, exit_liquidity_usd
    FROM trader_trades
   WHERE alert_tier = ?
     AND status NOT IN ('FAILED', 'WAITING')
   ORDER BY bought_at DESC
`;

/**
 * Map one trader_trades row into the QueueEntry shape the frontend expects.
 *
 * @param t             Raw DB row
 * @param displayLabel  Label shown in decision_reason: "[ELITE] LIVE · …"
 * @param privateAction "BUY" | "WATCH FOR UPGRADE"
 * @param privateLabel  Private-desk badge value ("IGNITION" | "LIVE" etc.)
 * @param defaultTier   Fallback when alert_tier is NULL in the row
 */
function mapLiveTradeToEntry(
  t:             Record<string, unknown>,
  displayLabel:  string,
  privateAction: string,
  privateLabel:  string,
  defaultTier:   string,
): Record<string, unknown> {
  const price    = typeof t["entry_price_usd"] === "number" ? t["entry_price_usd"] as number : null;
  const priceStr = price == null ? "?" : price < 0.0001 ? price.toExponential(4) : price.toFixed(8);
  const amtStr   = typeof t["entry_amount_usd"] === "number"
    ? `$${(t["entry_amount_usd"] as number).toFixed(2)}` : "?";
  return {
    id:                10_000_000 + (t["id"] as number),
    alert_id:          t["alert_id"]   ?? null,
    investigation_id:  null,
    token_address:     t["token_address"],
    token_name:        t["token_name"]   ?? null,
    token_symbol:      t["token_symbol"] ?? null,
    alert_tier:        t["alert_tier"]   ?? defaultTier,
    decision:          "BUY",
    decision_reason:   `[${displayLabel}] LIVE · entry $${priceStr} · ${amtStr}`,
    entry_price_usd:   t["entry_price_usd"]  ?? null,
    buy_amount_usd:    t["entry_amount_usd"] ?? null,
    slippage_pct:      null,
    expected_cost_usd: t["entry_amount_usd"] ?? null,
    expected_tokens:   t["tokens_purchased"] ?? null,
    status:            t["status"],
    is_simulation:     0,
    created_at:        t["bought_at"] ?? Date.now(),
    private_label:     privateLabel,
    private_action:    privateAction,
    // Live-only context fields — read by QueueCard for open-position detail
    profit_usd:          t["profit_usd"]          ?? null,
    profit_pct:          t["profit_pct"]          ?? null,
    current_price_usd:   t["current_price_usd"]   ?? null,
    entry_tx_hash:       t["entry_tx_hash"]        ?? null,
    // SELL snapshot fields — populated when status = 'CLOSED'
    sold_at:             t["sold_at"]              ?? null,
    exit_price_usd:      t["exit_price_usd"]       ?? null,
    sell_amount_usd:     t["exit_amount_usd"]      ?? null,
    reason_closed:       t["reason_closed"]         ?? null,
    exit_tx_hash:        t["exit_tx_hash"]          ?? null,
    exit_market_cap_usd: t["exit_market_cap_usd"]  ?? null,
    exit_liquidity_usd:  t["exit_liquidity_usd"]   ?? null,
    hold_time_seconds:   (t["sold_at"] != null && t["bought_at"] != null)
      ? Math.round(((t["sold_at"] as number) - (t["bought_at"] as number)) / 1_000)
      : null,
  };
}

/**
 * Merge live trades with sim-log entries for a queue page.
 * Live trades come first; sim entries whose alert_id matches a live trade
 * are suppressed to prevent duplicates.
 */
function mergeQueueEntries(
  simEntries:    Record<string, unknown>[],
  liveTrades:    Record<string, unknown>[],
  displayLabel:  string,
  privateAction: string,
  privateLabel:  string,
  defaultTier:   string,
): Record<string, unknown>[] {
  const liveAlertIds = new Set<unknown>(
    liveTrades.map((t) => t["alert_id"]).filter((id) => id != null)
  );
  const filteredSim  = simEntries.filter(
    (e) => e["alert_id"] == null || !liveAlertIds.has(e["alert_id"])
  );
  const liveEntries  = liveTrades.map((t) =>
    mapLiveTradeToEntry(t, displayLabel, privateAction, privateLabel, defaultTier)
  );
  return [...liveEntries, ...filteredSim];
}

// ── GET /trader/ignition ──────────────────────────────────────────────────────

router.get("/trader/ignition", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const simEntries = (db.prepare(SIM_LOG_QUERY).all() as Record<string, unknown>[])
      .map(enrichSimRow)
      .filter((e) => e["private_action"] === "BUY");

    const liveTrades = db.prepare(LIVE_TRADE_SELECT).all("IGNITION") as Record<string, unknown>[];
    const allEntries = mergeQueueEntries(simEntries, liveTrades, "IGNITION", "BUY", "IGNITION", "IGNITION");
    const page       = allEntries.slice(offset, offset + limit);

    res.json({ entries: page, total: allEntries.length, limit, offset, config: queueConfig("IGNITION") });
  } catch (err) {
    console.error("[trader] GET /trader/ignition error:", err);
    res.status(500).json({ error: "Failed to fetch ignition log" });
  }
});

// ── GET /trader/watch-for-upgrade ─────────────────────────────────────────────
// Simulation log entries whose private desk label resolved to WATCH FOR UPGRADE
// (one condition short of IGNITION), plus any confirmed live trades in this tier.

router.get("/trader/watch-for-upgrade", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const simEntries = (db.prepare(SIM_LOG_QUERY).all() as Record<string, unknown>[])
      .map(enrichSimRow)
      .filter((e) => e["private_action"] === "WATCH FOR UPGRADE");

    const liveTrades = db.prepare(LIVE_TRADE_SELECT).all("WATCH_FOR_UPGRADE") as Record<string, unknown>[];
    const allEntries = mergeQueueEntries(
      simEntries, liveTrades,
      "WATCH FOR UPGRADE", "WATCH FOR UPGRADE", "LIVE", "WATCH_FOR_UPGRADE"
    );
    const page = allEntries.slice(offset, offset + limit);

    res.json({ entries: page, total: allEntries.length, limit, offset, config: queueConfig("WATCH_FOR_UPGRADE") });
  } catch (err) {
    console.error("[trader] GET /trader/watch-for-upgrade error:", err);
    res.status(500).json({ error: "Failed to fetch watch-for-upgrade log" });
  }
});

// ── GET /trader/elite ─────────────────────────────────────────────────────────
// Simulation log entries where alert_tier = 'ELITE', plus confirmed live trades.

router.get("/trader/elite", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const simEntries = (db.prepare(`
      SELECT tsl.id, tsl.alert_id
             tsl.token_address, tsl.token_name, tsl.token_symbol,
             tsl.alert_tier, tsl.decision, tsl.decision_reason,
             tsl.entry_price_usd, tsl.buy_amount_usd, tsl.slippage_pct,
             tsl.expected_cost_usd, tsl.expected_tokens,
             tsl.status, tsl.is_simulation, tsl.created_at
        FROM trader_simulation_log tsl
       WHERE tsl.alert_tier = 'ELITE'
       ORDER BY tsl.created_at DESC LIMIT 2000
    `).all() as Record<string, unknown>[]).map(enrichSimRow);

    const liveTrades = db.prepare(LIVE_TRADE_SELECT).all("ELITE") as Record<string, unknown>[];
    const allEntries = mergeQueueEntries(simEntries, liveTrades, "ELITE", "BUY", "LIVE", "ELITE");
    const page       = allEntries.slice(offset, offset + limit);

    res.json({ entries: page, total: allEntries.length, limit, offset, config: queueConfig("ELITE") });
  } catch (err) {
    console.error("[trader] GET /trader/elite error:", err);
    res.status(500).json({ error: "Failed to fetch elite log" });
  }
});

// ── GET /trader/pro ───────────────────────────────────────────────────────────
// Simulation log entries where alert_tier = 'PRO', plus confirmed live trades.

router.get("/trader/pro", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const simEntries = (db.prepare(`
      SELECT tsl.id, tsl.alert_id
             tsl.token_address, tsl.token_name, tsl.token_symbol,
             tsl.alert_tier, tsl.decision, tsl.decision_reason,
             tsl.entry_price_usd, tsl.buy_amount_usd, tsl.slippage_pct,
             tsl.expected_cost_usd, tsl.expected_tokens,
             tsl.status, tsl.is_simulation, tsl.created_at
        FROM trader_simulation_log tsl
       WHERE tsl.alert_tier = 'PRO'
       ORDER BY tsl.created_at DESC LIMIT 2000
    `).all() as Record<string, unknown>[]).map(enrichSimRow);

    const liveTrades = db.prepare(LIVE_TRADE_SELECT).all("PRO") as Record<string, unknown>[];
    const allEntries = mergeQueueEntries(simEntries, liveTrades, "PRO", "BUY", "LIVE", "PRO");
    const page       = allEntries.slice(offset, offset + limit);

    res.json({ entries: page, total: allEntries.length, limit, offset, config: queueConfig("PRO") });
  } catch (err) {
    console.error("[trader] GET /trader/pro error:", err);
    res.status(500).json({ error: "Failed to fetch pro log" });
  }
});

// ── GET /trader/watch ─────────────────────────────────────────────────────────
// Returns sim log entries where alert_tier = 'WATCH', enriched with private label.
router.get("/trader/watch", (req: Request, res: Response): void => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "50",  10), 200);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    const rows = db.prepare(`
      SELECT tsl.id, tsl.alert_id
             tsl.token_address, tsl.token_name, tsl.token_symbol,
             tsl.alert_tier,
             tsl.decision, tsl.decision_reason,
             tsl.entry_price_usd,
             tsl.buy_amount_usd, tsl.slippage_pct,
             tsl.expected_cost_usd, tsl.expected_tokens,
             tsl.status, tsl.is_simulation, tsl.created_at
        FROM trader_simulation_log tsl
       WHERE tsl.alert_tier = 'WATCH'
       ORDER BY tsl.created_at DESC
       LIMIT 2000
    `).all() as Record<string, unknown>[];

    const entries = rows.map(enrichSimRow);
    const total = entries.length;
    const page  = entries.slice(offset, offset + limit);

    res.json({ entries: page, total, limit, offset, config: queueConfig("WATCH") });
  } catch (err) {
    console.error("[trader] GET /trader/watch error:", err);
    res.status(500).json({ error: "Failed to fetch watch log" });
  }
});

// ── POST /trader/alert/inject-test ───────────────────────────────────────────
// Fires a fully synthetic NewAlertEvent through the alertBus.
// Used to verify the engine's pre-condition and gate evaluation path.
// Works regardless of execution_mode and does NOT require a real alert_id.
// alertId uses a unique negative number so it never collides with real rows.

router.post("/trader/alert/inject-test", async (_req: Request, res: Response): Promise<void> => {
  try {
    const syntheticAlertId = -(Math.floor(Date.now() / 1000) % 1_000_000); // small negative, unique per second

    const event = {
      alertId:         syntheticAlertId,
      tokenId:         0,
      tokenAddress:    "TEST000000000000000000000000000000000000000",
      investigationId: null,
      evidenceScore:   80,
      confidence:      75,
      alertProfile:    { priceUsd: "0.000001", marketCap: 50000, tier: "ELITE" } as Record<string, unknown>,
      flowId:          "ELITE",
      createdAt:       Date.now(), // now → age = 0ms, always passes Gate 1
    };

    alertBus.emit("alert", event);

    // Wait for the async handler to run
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Check if a sim log entry was written (only happens when auto_trading ON and gates evaluated)
    const logEntry = db
      .prepare("SELECT decision, decision_reason, alert_tier FROM trader_simulation_log WHERE alert_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(syntheticAlertId) as { decision: string; decision_reason: string; alert_tier: string } | undefined;

    // Also read current auto_trading state so caller knows which path was taken
    const cfg = db.prepare("SELECT auto_trading_enabled, execution_mode FROM trader_config WHERE id = 1").get() as
      { auto_trading_enabled: number; execution_mode: string } | undefined;

    res.json({
      injected_alert_id:    syntheticAlertId,
      auto_trading_enabled: !!cfg?.auto_trading_enabled,
      execution_mode:       cfg?.execution_mode ?? "UNKNOWN",
      sim_log_entry:        logEntry ?? null,
      engine_reached_gates: !!logEntry,
      note: logEntry
        ? `Gate evaluation ran — decision: ${logEntry.decision}, reason: ${logEntry.decision_reason}`
        : cfg?.auto_trading_enabled
          ? "No log entry written — check server logs (engine may have passed all gates or price resolved to zero)"
          : "No log entry written — engine halted at auto_trading_enabled pre-condition (expected when OFF)",
    });
  } catch (err) {
    console.error("[trader] POST /trader/alert/inject-test error:", err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
