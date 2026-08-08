/**
 * Live Execution Engine
 *
 * Handles real on-chain buys and sells using Jupiter v6 + the transaction
 * pipeline. Shares all decision logic with Simulation Mode (evaluateGates()
 * is called upstream in simulationEngine.ts before this is invoked).
 *
 * Execution flow for a BUY:
 *   1. Resolve SOL price → compute lamports needed
 *   2. Check actual wallet SOL balance ≥ buy amount + min_sol_reserve
 *   3. Fetch Jupiter quote (SOL → token)
 *   4. Build swap transaction (with dynamic slippage + priority fee / Jito tip)
 *   5. Sign → submit → confirm (via transactionPipeline)
 *   6. Record open trade in trader_trades
 *   7. Register position with liveSellTracker
 *
 * Execution flow for a SELL:
 *   1. Fetch Jupiter quote (token → SOL)
 *   2. Build swap transaction
 *   3. Sign → submit → confirm
 *   4. Update trader_trades record (exit price, profit, status)
 *
 * SAFETY:
 *   - Never called unless execution_mode = 'LIVE' in trader_config
 *   - Emergency stop checked on every entry
 *   - All failures are logged and surface as SellResult / BuyResult — no throws
 *   - min_sol_reserve is enforced before every buy
 */

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { getSetting } from "../settings/service.js";
import * as helius from "../helius/client.js";
import {
  getQuote, getSwapTx,
  SOL_MINT, amountToAtoms, atomsToAmount,
  type JupiterQuote,
} from "./jupiterClient.js";
import { executeTransaction, type WalletRecord } from "./transactionPipeline.js";
import { notifyLiveTrade } from "./liveTelegram.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SOL_DECIMALS   = 9;
// price.jup.ag is deprecated — CoinGecko is the reliable fallback (no key required)
const SOL_PRICE_URL  = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const TOKEN_META_URL = "https://token.jup.ag/strict";
const DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuyResult {
  success:        boolean;
  tradeId:        number | null;
  signature:      string | null;
  entryPriceUsd:  number | null;
  tokensBought:   number | null;
  solSpent:       number | null;
  error:          string | null;
}

export interface SellResult {
  success:       boolean;
  tradeId:       number;
  signature:     string | null;
  exitPriceUsd:  number | null;
  solReceived:   number | null;
  profitUsd:     number | null;
  profitPct:     number | null;
  error:         string | null;
}

interface LiveTradeRow {
  id:               number;
  token_address:    string;
  token_name:       string | null;
  token_symbol:     string | null;
  alert_id:         number | null;
  alert_tier:       string | null;
  status:           string;
  entry_price_usd:  number | null;
  entry_amount_usd: number | null;
  tokens_purchased: number | null;
  tokens_remaining: number | null;
  token_decimals:   number;
  sol_price_at_entry: number | null;
  peak_price_usd:   number | null;
  min_price_usd:    number | null;
  milestones_hit:   string;
  entry_tx_hash:    string | null;
  bought_at:        number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchSolPrice(): Promise<number | null> {
  try {
    const res  = await fetch(SOL_PRICE_URL, { signal: AbortSignal.timeout(8_000) });
    const json = await res.json() as { solana?: { usd?: number } };
    return json.solana?.usd ?? null;
  } catch {
    return null;
  }
}

async function fetchTokenDecimals(mint: string, rpcEndpoint: string): Promise<number> {
  // Use on-chain RPC (getTokenSupply) — no external API dependency.
  try {
    const res = await fetch(rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenSupply",
        params: [mint],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json() as { result?: { value?: { decimals?: number } } };
    return json.result?.value?.decimals ?? 6;
  } catch {
    return 6; // safe default — most Solana meme tokens use 6 decimals
  }
}

async function getWalletSolBalance(walletAddress: string, rpcEndpoint: string): Promise<number> {
  try {
    const res = await fetch(rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getBalance",
        params: [walletAddress, { commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json() as { result?: { value?: number } };
    const lamports = json.result?.value ?? 0;
    return lamports / 1e9;
  } catch {
    return 0;
  }
}

function getWalletRecord(): WalletRecord | null {
  const row = sqlite
    .prepare("SELECT * FROM trader_wallet WHERE id = 1")
    .get() as WalletRecord | undefined;
  if (!row?.encrypted_private_key) return null;
  return row;
}

function ts(): number { return Date.now(); }

/**
 * Best-effort DexScreener lookup for market cap + liquidity at a given moment.
 * Used at both BUY confirmation (entry snapshot) and SELL close (exit snapshot).
 * Values are stored as immutable facts — never fetched or updated again.
 * Returns nulls on any failure, never throws.
 */
async function fetchMarketSnapshot(
  mint: string,
): Promise<{ marketCapUsd: number | null; liquidityUsd: number | null }> {
  try {
    const res = await fetch(`${DEXSCREENER_TOKEN_URL}/${mint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { marketCapUsd: null, liquidityUsd: null };
    const json = await res.json() as {
      pairs?: Array<{
        marketCap?: number;
        fdv?:       number;
        liquidity?: { usd?: number };
      }>;
    };
    const pair = json.pairs?.[0];
    return {
      marketCapUsd: pair?.marketCap ?? pair?.fdv ?? null,
      liquidityUsd: pair?.liquidity?.usd ?? null,
    };
  } catch {
    return { marketCapUsd: null, liquidityUsd: null };
  }
}

/**
 * Best-effort DexScreener lookup for token name + symbol.
 * Called only when the tokens table has no entry at execution time.
 * Returns { name: null, symbol: null } on any failure — never throws.
 */
async function fetchTokenMeta(
  mint: string,
): Promise<{ name: string | null; symbol: string | null }> {
  try {
    const res = await fetch(`${DEXSCREENER_TOKEN_URL}/${mint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { name: null, symbol: null };
    const json = await res.json() as {
      pairs?: Array<{ baseToken?: { name?: string; symbol?: string } }>;
    };
    const token = json.pairs?.[0]?.baseToken;
    return {
      name:   token?.name   ?? null,
      symbol: token?.symbol ?? null,
    };
  } catch {
    return { name: null, symbol: null };
  }
}

// ── BUY ───────────────────────────────────────────────────────────────────────

export interface OpenPositionParams {
  alertId:             number;
  investigationId:     number | null;
  tokenAddress:        string;
  tokenSymbol:         string | null;
  tokenName:           string | null;
  alertTier:           string;
  buyAmountUsd:        number;
  slippagePct:         number;
  priorityFeeLamports: number;
  evidenceScore:       number | null;
  marketCapUsd:        number | null;
  liquidityUsd:        number | null;
  // Alert snapshot extras — captured from the originating alert event
  alertTime:           number | null;   // Unix ms timestamp of the alert (alert_events.created_at)
  alertAgeSec:         number | null;   // Token age in seconds at alert time
}

export async function openLivePosition(params: OpenPositionParams): Promise<BuyResult> {
  const tag = { alertId: params.alertId, token: params.tokenAddress };
  logger.info(tag, "[live-engine] BUY — starting");

  try {
    // ── Safety: re-read config ───────────────────────────────────────────────
    const cfg = sqlite
      .prepare("SELECT * FROM trader_config WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    if (!cfg || cfg["execution_mode"] !== "LIVE") {
      return fail(0, "execution_mode is not LIVE — buy aborted (safety check)");
    }
    if (cfg["emergency_stop_enabled"]) {
      return fail(0, "Emergency stop active");
    }

    // ── Wallet ───────────────────────────────────────────────────────────────
    const wallet = getWalletRecord();
    if (!wallet) return fail(0, "No wallet configured");

    // ── SOL price → lamports ─────────────────────────────────────────────────
    const solPrice = await fetchSolPrice();
    if (!solPrice || solPrice <= 0) return fail(0, "Could not resolve SOL price");

    const solNeeded     = params.buyAmountUsd / solPrice;
    const minReserve    = Number(cfg["min_sol_reserve"] ?? 0.1);
    const solBalance    = await getWalletSolBalance(wallet.wallet_address, wallet.rpc_endpoint);
    const solRequired   = solNeeded + minReserve;

    if (solBalance < solRequired) {
      return fail(0,
        `Insufficient SOL: need ${solRequired.toFixed(4)} (buy ${solNeeded.toFixed(4)} + reserve ${minReserve}), have ${solBalance.toFixed(4)}`
      );
    }

    // ── Token decimals ───────────────────────────────────────────────────────
    const decimals = await fetchTokenDecimals(params.tokenAddress, wallet.rpc_endpoint);

    // ── Jupiter quote ────────────────────────────────────────────────────────
    const autoSlippage      = Boolean(cfg["auto_slippage_enabled"]);
    const slippageBps       = Math.round(params.slippagePct * 100);
    const maxAutoSlippageBps = Math.round(Number(cfg["max_slippage_pct"] ?? 5) * 100);
    const lamportsIn        = amountToAtoms(solNeeded, SOL_DECIMALS);

    let quote: JupiterQuote;
    try {
      quote = await getQuote({
        inputMint:          SOL_MINT,
        outputMint:         params.tokenAddress,
        amountLamports:     lamportsIn,
        slippageBps,
        autoSlippage,
        maxAutoSlippageBps,
      });
    } catch (err) {
      return fail(0, `Jupiter quote failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const tokensOut = atomsToAmount(quote.outAmount, decimals);
    const entryPriceUsd = tokensOut > 0 ? params.buyAmountUsd / tokensOut : null;
    if (!entryPriceUsd || entryPriceUsd <= 0) {
      return fail(0, "Jupiter quote returned 0 tokens out");
    }

    // ── Swap transaction ─────────────────────────────────────────────────────
    const autoPriorityFee = Boolean(cfg["auto_priority_fee_enabled"]);
    const useJito         = !!(wallet.jito_rpc && wallet.mev_protection);

    let swapInstructions;
    try {
      swapInstructions = await getSwapTx({
        quote,
        userPublicKey:      wallet.wallet_address,
        autoSlippage,
        maxAutoSlippageBps,
        priorityFeeLamports: autoPriorityFee ? "auto" : params.priorityFeeLamports,
        jitoTipLamports:    useJito ? Number(cfg["min_priority_fee_lamports"] ?? 5_000) : undefined,
        wrapSol:  true,
        unwrapSol: false,
      });
    } catch (err) {
      return fail(0, `Jupiter swap tx failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Token metadata — DexScreener fallback if tokens table had no entry ─────
    // The tokens table may not have a row for every traded token. If name or
    // symbol is missing, attempt a single best-effort DexScreener call now so
    // the stored trade record is as complete as possible. Never block or throw.
    let resolvedName   = params.tokenName;
    let resolvedSymbol = params.tokenSymbol;
    if (!resolvedName || !resolvedSymbol) {
      const meta = await fetchTokenMeta(params.tokenAddress);
      if (meta.name   && !resolvedName)   resolvedName   = meta.name;
      if (meta.symbol && !resolvedSymbol) resolvedSymbol = meta.symbol;
      if (resolvedName || resolvedSymbol) {
        logger.info(
          { token: params.tokenAddress, name: resolvedName, symbol: resolvedSymbol },
          "[live-engine] token meta resolved via DexScreener",
        );
      }
    }

    // ── Slippage from Jupiter quote (actual price impact, not configured bps) ──
    const actualSlippagePct = parseFloat(quote.priceImpactPct ?? "0") || null;

    // ── Priority fee: known when not auto, NULL when Jupiter resolves it ──────
    const storedPriorityFee = autoPriorityFee ? null : params.priorityFeeLamports;

    // ── Alert time in Unix seconds (params carries Unix ms from event.createdAt) ─
    const alertTimeSec = params.alertTime != null
      ? Math.floor(params.alertTime / 1_000)
      : null;

    // ── Create DB record BEFORE submitting (status = WAITING) ────────────────
    const now  = ts();
    const row  = sqlite
      .prepare(`
        INSERT INTO trader_trades (
          token_address, token_name, token_symbol,
          alert_id, alert_tier, status,
          entry_amount_usd, entry_amount_sol, token_decimals,
          sol_price_at_entry,
          tokens_purchased, tokens_remaining,
          peak_price_usd, min_price_usd, milestones_hit,
          confirmation_retries, created_at, updated_at,
          alert_time, alert_market_cap, alert_liquidity, alert_age_sec, alert_score,
          buy_submitted_at, slippage_pct, priority_fee_lamports, execution_audit_version
        ) VALUES (
          ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `)
      .run(
        params.tokenAddress, resolvedName, resolvedSymbol,
        params.alertId, params.alertTier,
        params.buyAmountUsd, solNeeded, decimals,
        solPrice,
        tokensOut, tokensOut,        // purchased = remaining at start
        entryPriceUsd,               // peak = entry
        entryPriceUsd,               // min = entry
        now, now,
        // Alert snapshot
        alertTimeSec,
        params.marketCapUsd ?? null,
        params.liquidityUsd ?? null,
        params.alertAgeSec  ?? null,
        params.evidenceScore != null ? Math.round(params.evidenceScore * 1000) / 1000 : null,
        // Execution snapshot
        now,                         // buy_submitted_at = same moment as created_at
        actualSlippagePct,
        storedPriorityFee,
        1,                           // execution_audit_version
      );
    const tradeId = Number(row.lastInsertRowid);

    // ── Execute transaction ───────────────────────────────────────────────────
    const txResult = await executeTransaction({
      wallet,
      base64Transaction:   swapInstructions.swapTransaction,
      lastValidBlockHeight: swapInstructions.lastValidBlockHeight,
      maxRetries: 3,
      confirmTimeoutMs: 60_000,
      skipPreflight: false,
    });

    if (!txResult.success) {
      // Mark trade as failed
      sqlite
        .prepare(`
          UPDATE trader_trades
          SET status = 'FAILED', last_error = ?, confirmation_retries = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(txResult.error, txResult.retries, ts(), tradeId);
      void notifyLiveTrade({
        type: "TRADE_FAILED", tradeId,
        tokenSymbol:  params.tokenSymbol,
        tokenAddress: params.tokenAddress,
        error: txResult.error ?? "Transaction failed",
      });
      return fail(tradeId, txResult.error ?? "Transaction failed");
    }

    // ── Entry market snapshot — fetched at the exact BUY confirmation moment ──
    // Never estimated: NULL stored when DexScreener is unavailable.
    const entryMkt   = await fetchMarketSnapshot(params.tokenAddress);
    const alertMc    = params.marketCapUsd ?? null;
    const entryMc    = entryMkt.marketCapUsd;
    const mcDriftPct = (entryMc != null && alertMc != null && alertMc > 0)
      ? ((entryMc - alertMc) / alertMc) * 100
      : null;
    logger.info(
      { tradeId, alertMc, entryMc, mcDriftPct: mcDriftPct?.toFixed(2) },
      "[live-engine] entry market snapshot captured",
    );

    // ── Confirm: update trade record with confirmed data ─────────────────────
    const confirmedAt = ts();
    sqlite
      .prepare(`
        UPDATE trader_trades
        SET status = 'OPEN',
            entry_price_usd = ?, entry_tx_hash = ?,
            bought_at = ?, confirmation_retries = ?,
            current_price_usd = ?, profit_usd = 0, profit_pct = 0,
            entry_market_cap = ?, entry_liquidity = ?, entry_mc_drift_pct = ?,
            network_fee_lamports = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        entryPriceUsd, txResult.signature,
        confirmedAt, txResult.retries,
        entryPriceUsd,
        entryMc, entryMkt.liquidityUsd, mcDriftPct,
        txResult.networkFeeLamports ?? null,
        confirmedAt, tradeId,
      );

    if (txResult.bundleId) {
      sqlite
        .prepare("UPDATE trader_trades SET jito_bundle_id = ? WHERE id = ?")
        .run(txResult.bundleId, tradeId);
    }

    // ── Developer wallet capture (non-fatal) ──────────────────────────────────
    // Best-effort: if Helius is unavailable the position still opens normally.
    // Runs after confirmation so it never delays the buy transaction path.
    const heliusKey = getSetting("helius_api_key")?.trim() ?? "";
    if (heliusKey) {
      helius.getCreatorInfo(heliusKey, params.tokenAddress).then((info) => {
        if (info.creatorAddress != null || info.totalSupply != null) {
          sqlite
            .prepare(`
              UPDATE trader_trades
              SET creator_address        = ?,
                  creator_tokens_at_entry = ?,
                  total_supply_at_entry   = ?,
                  updated_at             = ?
              WHERE id = ?
            `)
            .run(info.creatorAddress, info.creatorTokensAtEntry, info.totalSupply, Date.now(), tradeId);
          logger.info(
            { tradeId, creatorAddress: info.creatorAddress, totalSupply: info.totalSupply, creatorTokens: info.creatorTokensAtEntry },
            "[live-engine] developer wallet captured",
          );
        }
      }).catch((err) => {
        logger.warn({ err, tradeId }, "[live-engine] developer wallet capture failed — non-fatal");
      });
    }

    logger.info(
      {
        tradeId, alertId: params.alertId,
        signature: txResult.signature, bundleId: txResult.bundleId,
        entryPriceUsd, tokensOut, solSpent: solNeeded,
        latencyMs: txResult.latencyMs,
      },
      "[live-engine] BUY confirmed",
    );

    // Telegram notification (non-fatal)
    void notifyLiveTrade({
      type:          "BUY_CONFIRMED",
      tradeId,
      tokenSymbol:   params.tokenSymbol,
      tokenAddress:  params.tokenAddress,
      tier:          params.alertTier,
      entryPriceUsd,
      buyAmountUsd:  params.buyAmountUsd,
      solSpent:      solNeeded,
      tokensOut,
      signature:     txResult.signature!,
      bundleId:      txResult.bundleId,
    });

    return {
      success:       true,
      tradeId,
      signature:     txResult.signature,
      entryPriceUsd,
      tokensBought:  tokensOut,
      solSpent:      solNeeded,
      error:         null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, ...tag }, "[live-engine] BUY unhandled error");
    return fail(0, msg);
  }
}

// ── SELL ──────────────────────────────────────────────────────────────────────

export interface ClosePositionParams {
  tradeId:           number;
  reason:            string;
  sellPct:           number;    // 0–100: fraction of tokens_remaining to sell
  isMoonBag?:        boolean;   // if true, mark hold, no sell
  currentPriceUsd:   number;
}

export async function closeLivePosition(params: ClosePositionParams): Promise<SellResult> {
  const tag = { tradeId: params.tradeId, reason: params.reason };
  logger.info(tag, "[live-engine] SELL — starting");

  try {
    // ── Safety: re-read config ───────────────────────────────────────────────
    const cfg = sqlite
      .prepare("SELECT * FROM trader_config WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    if (!cfg) return sellFail(params.tradeId, "Config missing");

    // ── Load trade ───────────────────────────────────────────────────────────
    const trade = sqlite
      .prepare("SELECT * FROM trader_trades WHERE id = ?")
      .get(params.tradeId) as LiveTradeRow | undefined;
    if (!trade) return sellFail(params.tradeId, "Trade not found");
    if (trade.status !== "OPEN") return sellFail(params.tradeId, `Trade is not OPEN (status=${trade.status})`);

    const tokensRemaining = trade.tokens_remaining ?? trade.tokens_purchased ?? 0;
    const decimals        = trade.token_decimals ?? 6;
    const sellFraction    = params.sellPct / 100;

    // ── Moon bag: mark and return (no sell) ──────────────────────────────────
    if (params.isMoonBag) {
      const milestones = JSON.parse(trade.milestones_hit ?? "[]") as number[];
      milestones.push(-1); // sentinel for moon bag
      sqlite
        .prepare(`
          UPDATE trader_trades
          SET status = 'MOON_BAG', milestones_hit = ?, current_price_usd = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(JSON.stringify(milestones), params.currentPriceUsd, ts(), params.tradeId);
      void notifyLiveTrade({
        type:            "MOON_BAG",
        tradeId:         params.tradeId,
        tokenSymbol:     trade.token_symbol,
        tokenAddress:    trade.token_address,
        currentPriceUsd: params.currentPriceUsd ?? 0,
        entryPriceUsd:   trade.entry_price_usd ?? 0,
      });
      return {
        success: true, tradeId: params.tradeId, signature: null,
        exitPriceUsd: params.currentPriceUsd ?? 0, solReceived: null,
        profitUsd: null, profitPct: null, error: null,
      };
    }

    const tokensToSell = tokensRemaining * sellFraction;
    if (tokensToSell <= 0) {
      return sellFail(params.tradeId, "No tokens to sell");
    }

    // ── Wallet ───────────────────────────────────────────────────────────────
    const wallet = getWalletRecord();
    if (!wallet) return sellFail(params.tradeId, "No wallet configured");

    // ── Jupiter quote (token → SOL) ───────────────────────────────────────────
    const autoSlippage       = Boolean(cfg["auto_slippage_enabled"]);
    const slippageBps        = Math.round(Number(cfg["default_slippage_pct"] ?? 1) * 100);
    const maxAutoSlippageBps = Math.round(Number(cfg["max_slippage_pct"] ?? 5) * 100);
    const atomsToSell        = amountToAtoms(tokensToSell, decimals);

    let quote: JupiterQuote;
    try {
      quote = await getQuote({
        inputMint:          trade.token_address,
        outputMint:         SOL_MINT,
        amountLamports:     atomsToSell,
        slippageBps,
        autoSlippage,
        maxAutoSlippageBps,
      });
    } catch (err) {
      return sellFail(params.tradeId, `Jupiter quote failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const solOutLamports = Number(quote.outAmount);
    const solReceived    = solOutLamports / 1e9;
    const solPrice       = await fetchSolPrice();
    const exitPriceUsd   = solPrice ? (solReceived * solPrice) / tokensToSell : (params.currentPriceUsd ?? 0);

    // ── Swap transaction ─────────────────────────────────────────────────────
    const autoPriorityFee = Boolean(cfg["auto_priority_fee_enabled"]);
    const useJito         = !!(wallet.jito_rpc && wallet.mev_protection);

    let swapInstructions;
    try {
      swapInstructions = await getSwapTx({
        quote,
        userPublicKey:      wallet.wallet_address,
        autoSlippage,
        maxAutoSlippageBps,
        priorityFeeLamports: autoPriorityFee ? "auto" : Number(cfg["min_priority_fee_lamports"] ?? 1000),
        jitoTipLamports:    useJito ? Number(cfg["min_priority_fee_lamports"] ?? 5_000) : undefined,
        wrapSol:   false,
        unwrapSol: true,
      });
    } catch (err) {
      return sellFail(params.tradeId, `Jupiter swap tx failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    const sellSubmittedAt = ts();   // timestamp just before network submission
    const txResult = await executeTransaction({
      wallet,
      base64Transaction:   swapInstructions.swapTransaction,
      lastValidBlockHeight: swapInstructions.lastValidBlockHeight,
      maxRetries: 3,
      confirmTimeoutMs: 60_000,
    });

    if (!txResult.success) {
      sqlite
        .prepare("UPDATE trader_trades SET last_error = ?, confirmation_retries = ?, updated_at = ? WHERE id = ?")
        .run(txResult.error, txResult.retries, ts(), params.tradeId);
      return sellFail(params.tradeId, txResult.error ?? "Sell transaction failed");
    }

    // ── Update position ───────────────────────────────────────────────────────
    const newTokensRemaining = tokensRemaining - tokensToSell;
    const isFinalSell        = newTokensRemaining <= 0 || params.sellPct >= 100;

    const entryCost  = trade.entry_amount_usd ?? 0;
    const sellValue  = solPrice ? solReceived * solPrice : exitPriceUsd * tokensToSell;
    const profitFrac = tokensToSell / (trade.tokens_purchased ?? 1);
    const costBasis  = entryCost * profitFrac;
    const profitUsd  = sellValue - costBasis;
    const profitPct  = costBasis > 0 ? (profitUsd / costBasis) * 100 : 0;

    // ── Exit market data — captured at exact close moment, immutable ─────────
    // Fetched only on a final close so the values reflect the actual exit state.
    // NULL is stored when DexScreener is unavailable — never invented.
    let exitMarketCapUsd: number | null = null;
    let exitLiquidityUsd: number | null = null;
    if (isFinalSell) {
      const exitMkt = await fetchMarketSnapshot(trade.token_address);
      exitMarketCapUsd = exitMkt.marketCapUsd;
      exitLiquidityUsd = exitMkt.liquidityUsd;
      logger.info(
        { tradeId: params.tradeId, exitMarketCapUsd, exitLiquidityUsd },
        "[live-engine] exit market data captured",
      );
    }

    if (isFinalSell) {
      const soldAt      = ts();
      const holdTimeSec = trade.bought_at != null ? Math.round((soldAt - trade.bought_at) / 1_000) : null;
      sqlite
        .prepare(`
          UPDATE trader_trades
          SET status = 'CLOSED',
              exit_price_usd = ?, exit_amount_usd = ?, exit_tx_hash = ?,
              tokens_remaining = 0,
              sold_at = ?, reason_closed = ?,
              profit_usd = ?, profit_pct = ?,
              exit_market_cap_usd = ?, exit_liquidity_usd = ?,
              confirmation_retries = ?, current_price_usd = ?,
              sell_submitted_at = ?, hold_time_sec = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          exitPriceUsd, sellValue, txResult.signature,
          soldAt, params.reason,
          profitUsd, profitPct,
          exitMarketCapUsd, exitLiquidityUsd,
          txResult.retries, exitPriceUsd,
          sellSubmittedAt, holdTimeSec,
          soldAt, params.tradeId,
        );
    } else {
      // Partial sell — update tokens_remaining and accumulate profit
      const milestones = JSON.parse(trade.milestones_hit ?? "[]") as number[];
      sqlite
        .prepare(`
          UPDATE trader_trades
          SET tokens_remaining = ?,
              milestones_hit = ?,
              profit_usd = COALESCE(profit_usd, 0) + ?,
              current_price_usd = ?,
              exit_tx_hash = ?,
              confirmation_retries = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          newTokensRemaining,
          JSON.stringify([...milestones, params.sellPct]),
          profitUsd,
          exitPriceUsd,
          txResult.signature,
          txResult.retries,
          ts(), params.tradeId,
        );
    }

    logger.info(
      {
        tradeId: params.tradeId,
        reason: params.reason,
        signature: txResult.signature,
        exitPriceUsd, solReceived, profitUsd, profitPct: profitPct.toFixed(1),
        isFinalSell, sellPct: params.sellPct,
      },
      "[live-engine] SELL confirmed",
    );

    void notifyLiveTrade({
      type:          "SELL_CONFIRMED",
      tradeId:       params.tradeId,
      tokenSymbol:   trade.token_symbol,
      tokenAddress:  trade.token_address,
      tier:          trade.alert_tier,
      reason:        params.reason,
      exitPriceUsd:  exitPriceUsd ?? 0,
      entryPriceUsd: trade.entry_price_usd ?? 0,
      profitUsd,
      profitPct,
      solReceived,
      signature:     txResult.signature!,
      isFinal:       isFinalSell,
      sellPct:       params.sellPct,
    });

    return {
      success:      true,
      tradeId:      params.tradeId,
      signature:    txResult.signature,
      exitPriceUsd,
      solReceived,
      profitUsd,
      profitPct,
      error:        null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, ...tag }, "[live-engine] SELL unhandled error");
    return sellFail(params.tradeId, msg);
  }
}

// ── Failure helpers ───────────────────────────────────────────────────────────

function fail(tradeId: number, error: string): BuyResult {
  logger.error({ tradeId, error }, "[live-engine] BUY failed");
  return { success: false, tradeId: tradeId || null, signature: null,
           entryPriceUsd: null, tokensBought: null, solSpent: null, error };
}

function sellFail(tradeId: number, error: string): SellResult {
  logger.error({ tradeId, error }, "[live-engine] SELL failed");
  return { success: false, tradeId, signature: null,
           exitPriceUsd: null, solReceived: null, profitUsd: null, profitPct: null, error };
}
