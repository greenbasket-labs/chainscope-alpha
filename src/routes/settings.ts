/**
 * Alpha API — Settings Routes
 *
 * GET  /settings          — return current settings
 * PUT  /settings          — update settings (helius_api_key, rpc_url, theme)
 *
 * GET  /settings/telegram — return Telegram config status
 * POST /settings/telegram — save Telegram config
 * POST /settings/telegram/test — send test message
 *
 * GET  /settings/flows    — list all alert flows
 * PUT  /settings/flows/:id — update one alert flow
 */

import { Router, type Request, type Response } from "express";
import { getAllSettings, getSetting, setSetting, type SettingKey } from "../settings/service.js";
import { getTelegramConfig, setAppSetting } from "../settings/appSettings.js";
import { sqlite as db } from "../db/index.js";

const ALLOWED_KEYS: SettingKey[] = ["helius_api_key", "rpc_url", "theme"];

const router: import('express').Router = Router();

// ── GET /settings ─────────────────────────────────────────────────────────────

router.get("/settings", (_req: Request, res: Response): void => {
  const all = getAllSettings();
  const heliusSet = Boolean(all.helius_api_key);
  res.json({
    helius_api_key:     "",
    helius_api_key_set: heliusSet,
    rpc_url:            all.rpc_url,
    theme:              all.theme,
  });
});

// ── PUT /settings ─────────────────────────────────────────────────────────────

router.put("/settings", (req: Request, res: Response): void => {
  const body = req.body as Record<string, string>;
  for (const key of ALLOWED_KEYS) {
    if (!(key in body)) continue;
    const value = String(body[key]);
    if (key === "helius_api_key" && !value.trim()) continue;
    setSetting(key, value);
  }
  res.json({ ok: true });
});

// ── GET /settings/telegram ────────────────────────────────────────────────────

router.get("/settings/telegram", (_req: Request, res: Response): void => {
  const cfg = getTelegramConfig();
  res.json({
    enabled:       cfg.enabled,
    bot_token_set: Boolean(cfg.botToken?.trim()),
    chat_id_set:   Boolean(cfg.chatId?.trim()),
  });
});

// ── POST /settings/telegram ───────────────────────────────────────────────────

router.post("/settings/telegram", (req: Request, res: Response): void => {
  const { enabled, bot_token, chat_id } = req.body as {
    enabled?: boolean;
    bot_token?: string;
    chat_id?: string;
  };

  if (enabled !== undefined) setAppSetting("telegram.enabled", enabled ? "true" : "false");
  if (bot_token !== undefined && bot_token.trim()) setAppSetting("telegram.bot_token", bot_token.trim());
  if (chat_id !== undefined && chat_id.trim()) setAppSetting("telegram.chat_id", chat_id.trim());

  res.json({ ok: true });
});

// ── POST /settings/telegram/test ─────────────────────────────────────────────

router.post("/settings/telegram/test", async (_req: Request, res: Response): Promise<void> => {
  const cfg = getTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
    res.status(400).json({ error: "Telegram not configured" });
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text:    "✅ Alpha API test message — Telegram is working!",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await r.json() as { ok?: boolean; description?: string };
    if (json.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: json.description ?? "Telegram error" });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /settings/flows ───────────────────────────────────────────────────────

/** Strip raw token/chat_id values; return boolean _set flags instead. */
function sanitizeFlow(flow: Record<string, unknown>): Record<string, unknown> {
  const { telegram_bot_token, telegram_chat_id, ...rest } = flow;
  return {
    ...rest,
    telegram_bot_token_set: !!(telegram_bot_token as string | null),
    telegram_chat_id_set:   !!(telegram_chat_id  as string | null),
  };
}

router.get("/settings/flows", (_req: Request, res: Response): void => {
  const flows = db
    .prepare("SELECT * FROM alert_flows ORDER BY priority ASC, id ASC")
    .all() as Record<string, unknown>[];
  res.json(flows.map(sanitizeFlow));
});

// ── PUT /settings/flows/:id ───────────────────────────────────────────────────

router.put("/settings/flows/:id", (req: Request, res: Response): void => {
  const { id } = req.params;
  const now = Date.now();
  const body = req.body as Record<string, unknown>;

  const allowed = [
    "enabled", "min_score", "max_score", "max_age_hours",
    "telegram_bot_token", "telegram_chat_id",
    "live_trading_enabled", "trade_size_usd", "max_open_positions", "slippage_pct",
    "filter_profile_id",
  ];

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(body[key] ?? null);
    }
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  sets.push("updated_at = ?");
  vals.push(now);
  vals.push(id);

  db.prepare(`UPDATE alert_flows SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const flow = db.prepare("SELECT * FROM alert_flows WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!flow) {
    res.status(404).json({ error: "Flow not found" });
    return;
  }
  res.json(sanitizeFlow(flow));
});

export default router;
