/**
 * Alpha Feed Routes
 *
 * GET  /alpha/feed  — recent candidates from DexScreener poller
 * POST /alpha/notify — Telegram notification (kept for frontend compat)
 */

import { Router, type Request, type Response } from "express";
import { sqlite } from "../db/index.js";
import { getTelegramConfig } from "../settings/appSettings.js";
import { logger } from "../lib/logger.js";

const router: import('express').Router = Router();

// ── GET /alpha/feed ───────────────────────────────────────────────────────────

router.get("/alpha/feed", (req: Request, res: Response): void => {
  const { limit = "100", status, minScore } = req.query as {
    limit?: string;
    status?: string;
    minScore?: string;
  };

  const maxRows  = Math.min(parseInt(limit, 10) || 100, 500);
  const minScoreN = minScore ? parseFloat(minScore) : null;

  let where = "1=1";
  const params: unknown[] = [];

  if (status) {
    where += " AND filter_status = ?";
    params.push(status);
  }
  if (minScoreN !== null) {
    where += " AND elite_score >= ?";
    params.push(minScoreN);
  }

  const candidates = sqlite
    .prepare(
      `SELECT
         id, token_address, token_name, symbol, icon_url, pair_url,
         market_cap, fdv, liquidity, price_usd,
         volume_24h, volume_1h, volume_5m,
         pair_created_at, pair_age_minutes,
         buy_ratio, has_hev, has_bp, has_sp, has_np, boosts, source,
         elite_score, elite_passes, filter_status, filter_profile_id,
         discovered_at, polled_at
       FROM alpha_candidates
       WHERE ${where}
       ORDER BY polled_at DESC
       LIMIT ?`
    )
    .all(...params, maxRows) as Array<Record<string, unknown>>;

  // Map to the shape the frontend expects (mirrors discovery_candidates_v2 format)
  const mapped = candidates.map((c) => ({
    id:                  c.id,
    tokenAddress:        c.token_address,
    tokenName:           c.token_name,
    symbol:              c.symbol,
    iconUrl:             c.icon_url,
    pairUrl:             c.pair_url,
    marketCap:           c.market_cap,
    fdv:                 c.fdv,
    liquidityUsd:        c.liquidity,
    priceUsd:            c.price_usd,
    volume24h:           c.volume_24h,
    volume1h:            c.volume_1h,
    volume5m:            c.volume_5m,
    pairCreatedAt:       c.pair_created_at,
    pairAgeMinutes:      c.pair_age_minutes,
    buyRatio:            c.buy_ratio,
    hasHev:              Boolean(c.has_hev),
    hasBuyPressure:      Boolean(c.has_bp),
    hasSellPressure:     Boolean(c.has_sp),
    hasNewProfile:       Boolean(c.has_np),
    boosts:              c.boosts,
    source:              c.source,
    eliteScore:          c.elite_score,
    elitePasses:         Boolean(c.elite_passes),
    filterStatus:        c.filter_status,
    filterProfileId:     c.filter_profile_id,
    discoveredAt:        c.discovered_at,
    polledAt:            c.polled_at,
    discoveryStatus:     c.filter_status === "REJECTED" ? "REJECTED" : "READY",
  }));

  res.json({
    candidates: mapped,
    total: mapped.length,
    entryWindowMinutes: 60,
  });
});

// ── GET /alpha/feed/stats ─────────────────────────────────────────────────────

router.get("/alpha/feed/stats", (_req: Request, res: Response): void => {
  const stats = sqlite
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN filter_status = 'ELITE' THEN 1 ELSE 0 END) as elite,
         SUM(CASE WHEN filter_status = 'PRO' THEN 1 ELSE 0 END) as pro,
         SUM(CASE WHEN filter_status = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
         MAX(polled_at) as last_polled_at
       FROM alpha_candidates`
    )
    .get() as Record<string, unknown>;

  res.json(stats);
});

// ── POST /alpha/notify ────────────────────────────────────────────────────────
// Kept for frontend compatibility — manual Telegram notification.

router.post("/alpha/notify", async (req: Request, res: Response): Promise<void> => {
  const { tokenAddress, message } = req.body as {
    tokenAddress?: string;
    message?: string;
  };

  const cfg = getTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
    res.status(400).json({ ok: false, error: "Telegram not configured" });
    return;
  }

  const text = message ?? `🔔 Alpha signal: ${tokenAddress ?? "unknown"}`;

  try {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };
    if (data.ok) {
      res.json({ ok: true, messageId: data.result?.message_id ?? null });
    } else {
      res.status(400).json({ ok: false, error: data.description });
    }
  } catch (err) {
    logger.warn({ err }, "POST /alpha/notify failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
