/**
 * Live Sell Tracker
 *
 * Subscribes to the Market Observation Bus. On every price update,
 * checks all OPEN live positions (trader_trades) and applies the same
 * stop-loss + sell-milestone logic as Simulation Mode — but calls
 * closeLivePosition() to execute real on-chain sells.
 *
 * Position sync:
 *   startLiveSellTracker() also registers a periodic sync interval that
 *   reconciles DB records against on-chain token balances. This catches
 *   positions that were manually closed or affected by external transactions.
 *
 * SAFETY:
 *   - Checks execution_mode = 'LIVE' on every price event before acting
 *   - Emergency stop halts all sell automation (positions remain open)
 *   - Each position is processed sequentially — no concurrent sells on the
 *     same trade (dedup guard via in-flight set)
 *   - Failures surface in last_error column; position stays OPEN for retry
 */

import { sqlite } from "../db/index.js";
import { marketBus, type MarketObservation } from "../marketBus/index.js";
import { logger } from "../lib/logger.js";
import { closeLivePosition } from "./liveEngine.js";
import { notifyLiveTrade } from "./liveTelegram.js";
import { getProfileForFlow, getTpLadderForProfile } from "../eliteFilter/db.js";
import { getSetting } from "../settings/service.js";
import * as helius from "../helius/client.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LiveTrade {
  id:                number;
  token_address:     string;
  token_symbol:      string | null;
  alert_tier:        string | null;
  entry_price_usd:   number;
  entry_amount_usd:  number;  // USD cost basis — used for profit_pct calculation
  entry_liquidity:         number | null; // liquidity at position open — baseline for liquidity exit
  creator_address:         string | null; // token creator wallet — for developer sell detection
  creator_tokens_at_entry: number | null; // creator's token balance at position open
  total_supply_at_entry:   number | null; // total token supply at position open
  tokens_purchased:        number;
  tokens_remaining:  number;
  token_decimals:    number;
  peak_price_usd:    number | null;
  min_price_usd:     number | null;
  milestones_hit:    string;  // JSON array of multipliers already triggered
  bought_at:         number;
  status:            string;
}

interface SellMilestone {
  id?:         number;
  multiplier:  number;
  sell_pct:    number;
  is_moon_bag: number;
  enabled:     number;
  sort_order:  number;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Trades currently being processed — prevents concurrent sells on same position */
const inFlight = new Set<number>();

/**
 * Per-position dev-sell check throttle.
 * The marketBus fires on every price observation; we limit Helius calls to at
 * most once per DEV_SELL_CHECK_THROTTLE_MS per position.
 */
const devSellLastCheck = new Map<number, number>();
const DEV_SELL_CHECK_THROTTLE_MS = 60_000;

let syncInterval: NodeJS.Timeout | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLiveModeActive(): boolean {
  const row = sqlite
    .prepare("SELECT execution_mode, emergency_stop_enabled FROM trader_config WHERE id = 1")
    .get() as { execution_mode: string; emergency_stop_enabled: number } | undefined;
  return row?.execution_mode === "LIVE" && !row.emergency_stop_enabled;
}

function getOpenLiveTrades(): LiveTrade[] {
  return sqlite
    .prepare(`
      SELECT id, token_address, token_symbol, alert_tier,
             entry_price_usd, entry_amount_usd, entry_liquidity,
             creator_address, creator_tokens_at_entry, total_supply_at_entry,
             tokens_purchased, tokens_remaining,
             token_decimals, peak_price_usd, min_price_usd,
             milestones_hit, bought_at, status
      FROM trader_trades
      WHERE status = 'OPEN'
    `)
    .all() as LiveTrade[];
}

function getStopLossPct(): number {
  const row = sqlite
    .prepare("SELECT stop_loss_pct FROM trader_config WHERE id = 1")
    .get() as { stop_loss_pct: number } | undefined;
  return row?.stop_loss_pct ?? 90;
}

function getSellMilestones(): SellMilestone[] {
  return sqlite
    .prepare("SELECT * FROM trader_sell_strategy WHERE enabled = 1 ORDER BY sort_order ASC, multiplier ASC")
    .all() as SellMilestone[];
}


function updateTradePrice(
  tradeId:       number,
  currentPrice:  number,
  peakPrice:     number,
  minPrice:      number,
  unrealizedPnl: number,
  profitPct:     number,
): void {
  sqlite
    .prepare(`
      UPDATE trader_trades
      SET current_price_usd = ?,
          peak_price_usd    = ?,
          min_price_usd     = ?,
          profit_usd        = ?,
          profit_pct        = ?,
          updated_at        = ?
      WHERE id = ?
    `)
    .run(currentPrice, peakPrice, minPrice, unrealizedPnl, profitPct, Date.now(), tradeId);
}

// ── Price event handler ───────────────────────────────────────────────────────

async function onPriceObservation(obs: MarketObservation): Promise<void> {
  if (!isLiveModeActive()) return;

  const trades   = getOpenLiveTrades().filter((t) => t.token_address === obs.token_address);
  if (!trades.length) return;

  const stopLossPct  = getStopLossPct();
  const currentPrice = obs.price_usd ? parseFloat(obs.price_usd) : 0;
  if (!(currentPrice > 0)) return;

  for (const trade of trades) {
    if (inFlight.has(trade.id)) continue; // already being processed
    inFlight.add(trade.id);

    try {
      // ── Liquidity exit check ───────────────────────────────────────────────
      // Baseline = entry_liquidity (recorded when position opened).
      // Current  = obs.liquidity from this market tick.
      // If the drop from entry exceeds the configured threshold, sell and skip
      // normal stop-loss / milestone processing for this tick.
      let liquidityExitFired = false;
      const currentLiquidity = obs.liquidity;
      if (
        currentLiquidity != null &&
        currentLiquidity > 0 &&
        trade.entry_liquidity != null &&
        trade.entry_liquidity > 0
      ) {
        const profile = trade.alert_tier ? getProfileForFlow(trade.alert_tier) : null;
        if (
          profile?.liquidity_exit_enabled &&
          profile.liquidity_exit_drop_pct != null &&
          profile.liquidity_exit_sell_percent != null
        ) {
          const dropPct =
            ((trade.entry_liquidity - currentLiquidity) / trade.entry_liquidity) * 100;
          if (dropPct >= profile.liquidity_exit_drop_pct) {
            logger.info(
              {
                profile:              profile.id,
                token:                trade.token_symbol ?? trade.token_address,
                entry_liquidity:      trade.entry_liquidity,
                current_liquidity:    currentLiquidity,
                drop_percent:         dropPct.toFixed(2),
                configured_threshold: profile.liquidity_exit_drop_pct,
                sell_percent:         profile.liquidity_exit_sell_percent,
              },
              "[live-sell] LIQUIDITY_EXIT_TRIGGERED",
            );
            await closeLivePosition({
              tradeId:         trade.id,
              reason:          "LIQUIDITY_EXIT",
              sellPct:         profile.liquidity_exit_sell_percent,
              currentPriceUsd: currentPrice,
            });
            liquidityExitFired = true;
          }
        }
      }

      if (!liquidityExitFired) {
        // Load the TP ladder from the trade's own profile (same source as simulation).
        const tpProfile  = trade.alert_tier ? getProfileForFlow(trade.alert_tier) : null;
        const milestones = tpProfile ? getTpLadderForProfile(tpProfile.id) : [];
        await processTradeUpdate(trade, currentPrice, stopLossPct, milestones);
      }
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, "[live-sell] unhandled error in trade update");
    } finally {
      inFlight.delete(trade.id);
    }
  }

  // ── Developer sell (throttled, fire-and-forget) ───────────────────────────
  // After the main price loop, trigger a Helius balance check for any open
  // position whose token just received an observation — at most once per 60 s
  // per position. This catches dev sells within one DexScreener cycle (~seconds)
  // rather than waiting for the 5-minute sync interval.
  const apiKeyForDevSell = getSetting("helius_api_key")?.trim() ?? "";
  if (apiKeyForDevSell) {
    const now = Date.now();
    for (const trade of trades) {
      if (!trade.creator_address || !trade.creator_tokens_at_entry || trade.creator_tokens_at_entry <= 0) continue;
      const lastCheck = devSellLastCheck.get(trade.id) ?? 0;
      if (now - lastCheck < DEV_SELL_CHECK_THROTTLE_MS) continue;
      devSellLastCheck.set(trade.id, now);
      void checkDevSellForTrade(trade, apiKeyForDevSell);
    }
  }
}

async function processTradeUpdate(
  trade:        LiveTrade,
  currentPrice: number,
  stopLossPct:  number,
  milestones:   SellMilestone[],
): Promise<void> {
  const entryPrice      = trade.entry_price_usd;
  const newPeak         = Math.max(trade.peak_price_usd ?? entryPrice, currentPrice);
  const newMin          = Math.min(trade.min_price_usd  ?? entryPrice, currentPrice);
  const tokensRemaining = trade.tokens_remaining ?? trade.tokens_purchased ?? 0;

  // Unrealized P&L on remaining tokens
  const unrealizedPnl = tokensRemaining > 0
    ? (currentPrice - entryPrice) * tokensRemaining
    : 0;

  // Keep profit_pct in sync with profit_usd on every market tick
  const profitPct = trade.entry_amount_usd > 0
    ? (unrealizedPnl / trade.entry_amount_usd) * 100
    : 0;

  updateTradePrice(trade.id, currentPrice, newPeak, newMin, unrealizedPnl, profitPct);

  // ── Stop loss ─────────────────────────────────────────────────────────────
  if (stopLossPct > 0 && stopLossPct < 100) {
    const stopTrigger = entryPrice * (1 - stopLossPct / 100);
    if (currentPrice <= stopTrigger) {
      logger.info(
        { tradeId: trade.id, currentPrice, stopTrigger, stopLossPct },
        "[live-sell] STOP LOSS triggered",
      );
      await closeLivePosition({
        tradeId:         trade.id,
        reason:          `STOP_LOSS_${stopLossPct}pct`,
        sellPct:         100,
        currentPriceUsd: currentPrice,
      });
      return;
    }
  }

  // ── Sell milestones ───────────────────────────────────────────────────────
  if (!milestones.length) return;

  const milestonesHit = new Set<number>(
    JSON.parse(trade.milestones_hit ?? "[]") as number[]
  );

  for (const milestone of milestones) {
    if (milestonesHit.has(milestone.multiplier)) continue; // already triggered

    const targetPrice = entryPrice * milestone.multiplier;
    if (currentPrice < targetPrice) continue; // not reached yet

    if (milestone.is_moon_bag) {
      logger.info(
        { tradeId: trade.id, multiplier: milestone.multiplier, currentPrice },
        "[live-sell] moon bag milestone — holding remainder",
      );
      await closeLivePosition({
        tradeId:         trade.id,
        reason:          `MOON_BAG_${milestone.multiplier}x`,
        sellPct:         0,
        isMoonBag:       true,
        currentPriceUsd: currentPrice,
      });
      return;
    }

    logger.info(
      { tradeId: trade.id, multiplier: milestone.multiplier, sellPct: milestone.sell_pct, currentPrice },
      "[live-sell] milestone — selling",
    );
    const result = await closeLivePosition({
      tradeId:         trade.id,
      reason:          `MILESTONE_${milestone.multiplier}x`,
      sellPct:         milestone.sell_pct,
      currentPriceUsd: currentPrice,
    });

    if (!result.success) {
      logger.warn(
        { tradeId: trade.id, error: result.error, milestone: milestone.multiplier },
        "[live-sell] milestone sell failed — will retry on next tick",
      );
      // Don't mark as hit — will retry next tick
      return;
    }

    // Mark milestone as hit in trade record
    const updatedMilestones = [...milestonesHit, milestone.multiplier];
    sqlite
      .prepare("UPDATE trader_trades SET milestones_hit = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updatedMilestones), Date.now(), trade.id);

    // Only one milestone per price tick to avoid over-selling
    return;
  }
}

// ── Developer sell ────────────────────────────────────────────────────────────

/**
 * Checks one OPEN position for a developer sell.
 *
 * Trigger denominator: creator's ORIGINAL HOLDINGS (creator_tokens_at_entry),
 * not total supply. This is invariant to initial allocation size — a dev
 * holding 4% who sells all their tokens registers 100% of holdings sold,
 * which would be missed entirely if measured as % of supply (4% < any sane
 * supply-based threshold). Supply-based pct is logged separately for context.
 *
 * Called from:
 *   - onPriceObservation (throttled to 60 s per position) — fast path
 *   - checkDevSells() (5-min safety net) — slow path / fallback
 */
async function checkDevSellForTrade(trade: LiveTrade, apiKey: string): Promise<void> {
  if (inFlight.has(trade.id)) return;

  const profile = trade.alert_tier ? getProfileForFlow(trade.alert_tier) : null;
  if (!profile?.dev_sell_enabled) return;
  if (profile.dev_sell_trigger_pct == null || profile.dev_sell_sell_pct == null) return;

  // Guard: creator held nothing at entry — dev was already out; skip.
  if (!trade.creator_tokens_at_entry || trade.creator_tokens_at_entry <= 0) return;

  let currentCreatorBalance: number | null = null;
  try {
    currentCreatorBalance = await helius.getTokenBalanceByOwner(
      apiKey,
      trade.creator_address!,
      trade.token_address,
    );
  } catch {
    return;
  }
  if (currentCreatorBalance == null) return;

  const tokensSold = trade.creator_tokens_at_entry - currentCreatorBalance;
  if (tokensSold <= 0) return; // creator has not sold (or bought more)

  // Primary trigger: % of creator's original holdings
  const soldPctOfHoldings = (tokensSold / trade.creator_tokens_at_entry) * 100;

  // Informational only: % of total supply (for log context)
  const soldPctOfSupply =
    trade.total_supply_at_entry && trade.total_supply_at_entry > 0
      ? (tokensSold / trade.total_supply_at_entry) * 100
      : null;

  if (soldPctOfHoldings < profile.dev_sell_trigger_pct) return;

  logger.info(
    {
      profile:               profile.id,
      token:                 trade.token_symbol ?? trade.token_address,
      creator_address:       trade.creator_address,
      tokens_sold:           tokensSold,
      sold_pct_of_holdings:  soldPctOfHoldings.toFixed(2),
      sold_pct_of_supply:    soldPctOfSupply?.toFixed(2) ?? "n/a",
      trigger_pct:           profile.dev_sell_trigger_pct,
      sell_percent:          profile.dev_sell_sell_pct,
    },
    "[live-sell] DEVELOPER_SELL_TRIGGERED",
  );

  inFlight.add(trade.id);
  try {
    const row = sqlite
      .prepare("SELECT current_price_usd FROM trader_trades WHERE id = ?")
      .get(trade.id) as { current_price_usd: number | null } | undefined;
    const priceUsd = row?.current_price_usd ?? trade.entry_price_usd;

    await closeLivePosition({
      tradeId:         trade.id,
      reason:          "DEVELOPER_SELL",
      sellPct:         profile.dev_sell_sell_pct,
      currentPriceUsd: priceUsd,
    });
  } catch (err) {
    logger.error({ err, tradeId: trade.id }, "[live-sell] developer sell exit failed — non-fatal");
  } finally {
    inFlight.delete(trade.id);
  }
}

/**
 * 5-minute safety net: checks all OPEN positions with dev sell enabled.
 * The primary path is onPriceObservation (throttled per token).
 * This catches positions that haven't received a market observation recently.
 */
async function checkDevSells(): Promise<void> {
  if (!isLiveModeActive()) return;

  const apiKey = getSetting("helius_api_key")?.trim() ?? "";
  if (!apiKey) return;

  const trades = getOpenLiveTrades().filter(
    (t) => t.creator_address != null && t.creator_tokens_at_entry != null && t.creator_tokens_at_entry > 0,
  );

  for (const trade of trades) {
    await checkDevSellForTrade(trade, apiKey);
  }
}

// ── Time exit ─────────────────────────────────────────────────────────────────

/**
 * Checks all OPEN live positions against their profile's time-exit config.
 * If the position has been held longer than time_exit_max_hold_minutes, sells
 * time_exit_sell_percent of the remaining tokens.
 *
 * Moon-bag rule: MOON_BAG status positions are excluded by the OPEN filter in
 * getOpenLiveTrades(); any remaining OPEN position's tokens are fully tradeable.
 */
async function checkTimeExits(): Promise<void> {
  if (!isLiveModeActive()) return;

  const trades = getOpenLiveTrades();
  if (!trades.length) return;

  const milestones = getSellMilestones();
  const now        = Date.now();

  for (const trade of trades) {
    if (inFlight.has(trade.id)) continue;

    // Resolve the profile for this trade via its alert tier (= flow ID)
    const profile = trade.alert_tier ? getProfileForFlow(trade.alert_tier) : null;
    if (!profile) continue;
    if (!profile.time_exit_enabled) continue;

    const maxMinutes = profile.time_exit_max_hold_minutes;
    const sellPct    = profile.time_exit_sell_percent;
    if (!maxMinutes || maxMinutes <= 0) continue;
    if (sellPct == null || sellPct <= 0) continue;

    const holdingMinutes = (now - trade.bought_at) / 60_000;
    if (holdingMinutes < maxMinutes) continue;

    // Moon-bag detection: check if any hit milestone is a moon-bag milestone.
    // In practice MOON_BAG positions have status='MOON_BAG' (excluded by OPEN
    // filter), so this will normally be false — but we compute it for logging.
    let moonBagPreserved = false;
    try {
      const milestonesHit = new Set<number>(
        JSON.parse(trade.milestones_hit ?? "[]") as number[]
      );
      moonBagPreserved = milestones.some(
        (ms) => ms.is_moon_bag === 1 && milestonesHit.has(ms.multiplier)
      );
    } catch {
      // milestones_hit parse failure — treat as no moon bag
    }

    logger.info(
      {
        profile:         profile.id,
        token:           trade.token_symbol ?? trade.token_address,
        tradeId:         trade.id,
        holding_minutes: holdingMinutes.toFixed(1),
        configured_limit: maxMinutes,
        sell_percent:    sellPct,
        moon_bag_preserved: moonBagPreserved,
      },
      "[live-sell] TIME_EXIT_TRIGGERED",
    );

    inFlight.add(trade.id);
    try {
      const currentPrice = sqlite
        .prepare("SELECT current_price_usd FROM trader_trades WHERE id = ?")
        .get(trade.id) as { current_price_usd: number | null } | undefined;

      const priceUsd = currentPrice?.current_price_usd ?? trade.entry_price_usd;

      await closeLivePosition({
        tradeId:         trade.id,
        reason:          "TIME_EXIT",
        sellPct:         sellPct,
        currentPriceUsd: priceUsd,
      });
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, "[live-sell] time exit sell failed — non-fatal");
    } finally {
      inFlight.delete(trade.id);
    }
  }
}

// ── Position sync ─────────────────────────────────────────────────────────────

/**
 * Periodic sync: verify open positions still exist on-chain.
 * Marks OPEN trades as SYNC_LOST if the token account balance is 0
 * and the trade has been open for more than 5 minutes (giving time for
 * the buy tx to settle).
 *
 * This is a best-effort safeguard — manual review is still recommended
 * when SYNC_LOST positions appear.
 */
async function syncPositions(): Promise<void> {
  if (!isLiveModeActive()) return;

  const wallet = sqlite
    .prepare("SELECT wallet_address, rpc_endpoint FROM trader_wallet WHERE id = 1")
    .get() as { wallet_address: string; rpc_endpoint: string } | undefined;
  if (!wallet?.wallet_address) return;

  const openTrades = getOpenLiveTrades();
  if (!openTrades.length) return;

  try {
    // Batch RPC: get all token accounts for wallet
    const res = await fetch(wallet.rpc_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          wallet.wallet_address,
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { encoding: "jsonParsed", commitment: "confirmed" },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json() as {
      result?: { value?: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number } } } } } }> };
    };

    const tokenBalances = new Map<string, number>();
    for (const account of json.result?.value ?? []) {
      const info = account.account.data.parsed.info;
      tokenBalances.set(info.mint, info.tokenAmount.uiAmount ?? 0);
    }

    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    for (const trade of openTrades) {
      if ((trade.bought_at ?? 0) > fiveMinutesAgo) continue; // too fresh to sync

      const onChainBalance = tokenBalances.get(trade.token_address) ?? 0;
      if (onChainBalance === 0) {
        logger.warn(
          { tradeId: trade.id, token: trade.token_address },
          "[live-sell] sync: 0 on-chain balance for OPEN trade — marking SYNC_LOST",
        );
        sqlite
          .prepare(`
            UPDATE trader_trades
            SET status = 'SYNC_LOST', last_error = 'On-chain balance = 0; manual review needed', updated_at = ?
            WHERE id = ?
          `)
          .run(Date.now(), trade.id);
        void notifyLiveTrade({
          type:         "SYNC_LOST",
          tradeId:      trade.id,
          tokenSymbol:  trade.token_symbol,
          tokenAddress: trade.token_address,
          error:        "On-chain balance = 0; manual review needed",
        });
      }
    }
  } catch (err) {
    logger.debug({ err }, "[live-sell] sync error — non-fatal");
  }
}

// ── Startup / shutdown ────────────────────────────────────────────────────────

export function startLiveSellTracker(): void {
  marketBus.subscribe((obs) => {
    void onPriceObservation(obs);
  });

  // Sync and exit checks every 5 minutes
  syncInterval = setInterval(() => {
    void syncPositions();
    void checkTimeExits();
    void checkDevSells();
  }, 5 * 60_000);

  logger.info("[live-sell] Live sell tracker started");
}

export function stopLiveSellTracker(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  logger.info("[live-sell] Live sell tracker stopped");
}
