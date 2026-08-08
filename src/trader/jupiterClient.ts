/**
 * Jupiter v6 REST Client
 *
 * Wraps Jupiter Aggregator API v6 (quote-api.jup.ag/v6).
 * No SDK dependency — pure HTTP using fetch.
 *
 * Responsibilities:
 *   - getQuote()     — best route from inputMint → outputMint for a given amount
 *   - getSwapTx()    — serialized VersionedTransaction ready to sign
 *
 * Dynamic slippage:
 *   - If auto_slippage_enabled: request autoSlippage=true with maxAutoSlippageBps cap
 *   - Otherwise: use configured slippage_bps exactly
 *
 * Dynamic priority fee:
 *   - If auto_priority_fee_enabled: "auto" → Jupiter computes optimal fee
 *   - Otherwise: pass exact lamports from config
 *
 * Jito tip:
 *   - If jito_rpc configured + mev_protection=1, pass jitoTipLamports instead of
 *     a standard priority fee. Jupiter embeds the tip instruction in the transaction.
 */

import { logger } from "../lib/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const SOL_MINT  = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Jupiter moved from quote-api.jup.ag/v6 → lite-api.jup.ag/swap/v1 (free tier, no key required)
const QUOTE_API  = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_API   = "https://lite-api.jup.ag/swap/v1/swap";

const FETCH_TIMEOUT_MS = 12_000;

// ── Default Jito tip (auto-scaled from config) ─────────────────────────────────
const DEFAULT_JITO_TIP_LAMPORTS = 5_000; // ~0.000005 SOL

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JupiterQuote {
  inputMint:             string;
  outputMint:            string;
  inAmount:              string;   // smallest unit
  outAmount:             string;   // smallest unit (tokens for buy, SOL lamports for sell)
  otherAmountThreshold:  string;   // min received after slippage
  swapMode:              string;
  slippageBps:           number;
  priceImpactPct:        string;
  routePlan:             unknown[];
  contextSlot?:          number;
  timeTaken?:            number;
}

export interface SwapInstructions {
  swapTransaction:   string;   // base64-encoded VersionedTransaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export interface QuoteParams {
  inputMint:             string;
  outputMint:            string;
  amountLamports:        number;   // integer, in smallest unit
  slippageBps:           number;   // e.g. 100 = 1%
  autoSlippage:          boolean;
  maxAutoSlippageBps:    number;   // cap when autoSlippage=true (e.g. 500 = 5%)
}

export interface SwapParams {
  quote:                 JupiterQuote;
  userPublicKey:         string;
  autoSlippage:          boolean;
  maxAutoSlippageBps:    number;
  priorityFeeLamports:   number | "auto";
  jitoTipLamports?:      number;  // if set, embed Jito tip instead of priority fee
  wrapSol:               boolean; // true for SOL→token buys
  unwrapSol:             boolean; // true for token→SOL sells
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function jupFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jupiter HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the best swap quote from Jupiter.
 * amount is in smallest units (lamports for SOL, token atoms for SPL tokens).
 */
export async function getQuote(params: QuoteParams): Promise<JupiterQuote> {
  const url = new URL(QUOTE_API);
  url.searchParams.set("inputMint",  params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount",     String(Math.floor(params.amountLamports)));
  url.searchParams.set("swapMode",   "ExactIn");

  if (params.autoSlippage) {
    url.searchParams.set("autoSlippage",       "true");
    url.searchParams.set("maxAutoSlippageBps", String(params.maxAutoSlippageBps));
  } else {
    url.searchParams.set("slippageBps", String(params.slippageBps));
  }

  // Minimise price impact — allow multi-hop routes
  url.searchParams.set("onlyDirectRoutes", "false");
  url.searchParams.set("asLegacyTransaction", "false");

  logger.debug({ url: url.toString() }, "[jupiter] getQuote");
  return jupFetch<JupiterQuote>(url.toString());
}

/**
 * Build a swap VersionedTransaction from a Jupiter quote.
 * Returns base64-encoded transaction ready to deserialize → sign → send.
 */
export async function getSwapTx(params: SwapParams): Promise<SwapInstructions> {
  const body: Record<string, unknown> = {
    quoteResponse:       params.quote,
    userPublicKey:       params.userPublicKey,
    wrapAndUnwrapSol:    params.wrapSol || params.unwrapSol,
    dynamicComputeUnitLimit: true,
    asLegacyTransaction:     false,
  };

  // Priority fee / Jito tip
  if (params.jitoTipLamports != null && params.jitoTipLamports > 0) {
    body["prioritizationFeeLamports"] = { jitoTipLamports: params.jitoTipLamports };
  } else if (params.priorityFeeLamports === "auto") {
    body["prioritizationFeeLamports"] = "auto";
  } else {
    body["prioritizationFeeLamports"] = params.priorityFeeLamports;
  }

  // Dynamic slippage on the swap side as well
  if (params.autoSlippage) {
    body["dynamicSlippage"] = {
      minBps: 50,
      maxBps: params.maxAutoSlippageBps,
    };
  }

  logger.debug({ userPublicKey: params.userPublicKey }, "[jupiter] getSwapTx");
  const res = await jupFetch<{
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports?: number;
    simulationError?: unknown;
  }>(SWAP_API, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (res.simulationError) {
    logger.warn({ simulationError: res.simulationError }, "[jupiter] swap simulation warning");
  }

  return {
    swapTransaction:          res.swapTransaction,
    lastValidBlockHeight:     res.lastValidBlockHeight,
    prioritizationFeeLamports: res.prioritizationFeeLamports ?? 0,
  };
}

/**
 * Convert token atoms → human-readable amount given decimals.
 * e.g. 1_000_000 atoms with 6 decimals → 1.0
 */
export function atomsToAmount(atoms: string | number, decimals: number): number {
  return Number(atoms) / Math.pow(10, decimals);
}

/**
 * Convert human-readable amount → token atoms.
 * e.g. 1.5 SOL → 1_500_000_000 lamports
 */
export function amountToAtoms(amount: number, decimals: number): number {
  return Math.floor(amount * Math.pow(10, decimals));
}
