/**
 * Live Trade Telegram Notifications
 *
 * Sends real-time Telegram messages when live positions open, close, or fail.
 * Uses the global telegram.* app_settings credentials (same as alert delivery).
 *
 * Message types:
 *   BUY_CONFIRMED  — position opened on-chain (entry price, SOL spent, tx)
 *   SELL_CONFIRMED — position closed or partially sold (exit price, P&L, reason)
 *   MOON_BAG       — final moon-bag milestone reached (holding remainder)
 *   TRADE_FAILED   — buy or sell transaction failed permanently
 *   SYNC_LOST      — position marked SYNC_LOST by periodic on-chain sync
 *
 * Non-fatal: all errors are caught and logged. Notification failure never
 * affects the trade record or execution flow.
 *
 * Format: Telegram Markdown. Mirrors the style of alert notifications.
 */

import { logger } from "../lib/logger.js";
import { getTelegramConfig } from "../settings/appSettings.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuyNotification {
  type:          "BUY_CONFIRMED";
  tradeId:       number;
  tokenSymbol:   string | null;
  tokenAddress:  string;
  tier:          string | null;
  entryPriceUsd: number;
  buyAmountUsd:  number;
  solSpent:      number;
  tokensOut:     number;
  signature:     string;
  bundleId?:     string | null;
}

export interface SellNotification {
  type:          "SELL_CONFIRMED";
  tradeId:       number;
  tokenSymbol:   string | null;
  tokenAddress:  string;
  tier:          string | null;
  reason:        string;
  exitPriceUsd:  number;
  entryPriceUsd: number;
  profitUsd:     number;
  profitPct:     number;
  solReceived:   number;
  signature:     string;
  isFinal:       boolean;
  sellPct:       number;
}

export interface MoonBagNotification {
  type:          "MOON_BAG";
  tradeId:       number;
  tokenSymbol:   string | null;
  tokenAddress:  string;
  currentPriceUsd: number;
  entryPriceUsd:   number;
}

export interface TradeFailedNotification {
  type:      "TRADE_FAILED" | "SYNC_LOST";
  tradeId:   number;
  tokenSymbol: string | null;
  tokenAddress: string;
  error:     string;
}

export type LiveNotification =
  | BuyNotification
  | SellNotification
  | MoonBagNotification
  | TradeFailedNotification;

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtPrice(p: number): string {
  if (p < 0.00001) return p.toExponential(3);
  if (p < 0.01)    return p.toFixed(6);
  if (p < 1)       return p.toFixed(4);
  return p.toFixed(2);
}

function fmtPnl(usd: number, pct: number): string {
  const sign = usd >= 0 ? "+" : "";
  return `${sign}$${usd.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
}

function pnlEmoji(usd: number): string {
  if (usd > 50)  return "🟢";
  if (usd > 0)   return "🟡";
  if (usd > -20) return "🔴";
  return "💀";
}

function buildMessage(n: LiveNotification): string {
  const tier = n.tokenSymbol ? `*${n.tokenSymbol}*` : `\`${fmtAddr(n.tokenAddress)}\``;

  switch (n.type) {
    case "BUY_CONFIRMED": {
      const jito = n.bundleId ? ` \\| Jito bundle` : "";
      return [
        `🟢 *LIVE BUY EXECUTED* — Trade #${n.tradeId}`,
        ``,
        `Token: ${tier}${n.tier ? ` \\[${n.tier}\\]` : ""}`,
        `Entry: $${fmtPrice(n.entryPriceUsd)}`,
        `Amount: $${n.buyAmountUsd.toFixed(2)} (${n.solSpent.toFixed(4)} SOL)`,
        `Tokens: ${n.tokensOut.toLocaleString("en", { maximumFractionDigits: 2 })}`,
        ``,
        `Tx: \`${n.signature.slice(0, 12)}…\`${jito}`,
        `[View on Solscan](https://solscan.io/tx/${n.signature})`,
      ].join("\n");
    }

    case "SELL_CONFIRMED": {
      const emoji    = pnlEmoji(n.profitUsd);
      const pnlStr   = fmtPnl(n.profitUsd, n.profitPct);
      const closeStr = n.isFinal ? "*POSITION CLOSED*" : `*PARTIAL SELL* (${n.sellPct}%)`;
      const reason   = n.reason.replace(/_/g, " ");
      return [
        `${emoji} *LIVE SELL* — ${closeStr} — Trade #${n.tradeId}`,
        ``,
        `Token: ${tier}${n.tier ? ` \\[${n.tier}\\]` : ""}`,
        `Reason: ${reason}`,
        `Exit: $${fmtPrice(n.exitPriceUsd)} (entry: $${fmtPrice(n.entryPriceUsd)})`,
        `SOL received: ${n.solReceived.toFixed(4)} SOL`,
        `P&L: ${pnlStr}`,
        ``,
        `Tx: \`${n.signature.slice(0, 12)}…\``,
        `[View on Solscan](https://solscan.io/tx/${n.signature})`,
      ].join("\n");
    }

    case "MOON_BAG": {
      const mult = (n.currentPriceUsd / n.entryPriceUsd).toFixed(1);
      return [
        `🌙 *MOON BAG* — Trade #${n.tradeId}`,
        ``,
        `Token: ${tier}`,
        `Price: $${fmtPrice(n.currentPriceUsd)} (${mult}x from entry $${fmtPrice(n.entryPriceUsd)})`,
        `Holding remainder indefinitely.`,
      ].join("\n");
    }

    case "TRADE_FAILED": {
      return [
        `❌ *LIVE TRADE FAILED* — Trade #${n.tradeId}`,
        ``,
        `Token: ${tier}`,
        `Error: ${n.error.slice(0, 300)}`,
        ``,
        `Check \`GET /trader/live/trades/${n.tradeId}\` for details.`,
      ].join("\n");
    }

    case "SYNC_LOST": {
      return [
        `⚠️ *POSITION SYNC LOST* — Trade #${n.tradeId}`,
        ``,
        `Token: ${tier}`,
        `On-chain balance = 0 but DB status is OPEN.`,
        `Reason: ${n.error}`,
        ``,
        `Manual review required. Check \`GET /trader/live/trades/${n.tradeId}\`.`,
      ].join("\n");
    }
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendTelegramMessage(text: string): Promise<void> {
  const cfg = getTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
    logger.debug("[live-telegram] Telegram not configured — notification skipped");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:                  cfg.chatId,
        text,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200) }, "[live-telegram] send failed");
    }
  } catch (err) {
    logger.warn({ err }, "[live-telegram] send error — non-fatal");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a live trade notification via Telegram.
 * Non-fatal: never throws, never blocks execution flow.
 */
export async function notifyLiveTrade(notification: LiveNotification): Promise<void> {
  try {
    const text = buildMessage(notification);
    await sendTelegramMessage(text);
    logger.debug({ type: notification.type, tradeId: notification.tradeId }, "[live-telegram] sent");
  } catch (err) {
    logger.warn({ err, type: notification.type }, "[live-telegram] build/send error — non-fatal");
  }
}
