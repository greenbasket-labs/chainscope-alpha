/**
 * Market Data Client
 *
 * Per-token market data fetch (used by simPoller + simulationEngine).
 * Sources: DexScreener (price, MC, liquidity, volume) + Helius (holder count).
 * Publishes to marketBus so all subscribers get data at zero extra API cost.
 */

import { getSetting } from "../settings/service.js";
import { logger } from "../lib/logger.js";
import { marketBus } from "../marketBus/index.js";

export interface MarketData {
  priceUsd:     string | null;
  marketCap:    number | null;
  holders:      number | null;
  liquidityUsd: number | null;
  volume24h:    number | null;
  txCount24h:   number | null;
  raw: Record<string, unknown>;
  source: string;
}

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const TIMEOUT_MS = 12_000;

// ── Main entry point ──────────────────────────────────────────────────────────

export async function fetchMarketData(mint: string): Promise<MarketData | null> {
  const [dex, holderCount] = await Promise.allSettled([
    fetchDexScreener(mint),
    fetchHolderCount(mint),
  ]);

  const dexData = dex.status === "fulfilled" ? dex.value : null;
  const holders =
    holderCount.status === "fulfilled" ? holderCount.value : null;

  if (!dexData && holders === null) return null;

  const result: MarketData = {
    priceUsd:     dexData?.priceUsd   ?? null,
    marketCap:    dexData?.marketCap  ?? null,
    liquidityUsd: dexData?.liquidity  ?? null,
    volume24h:    dexData?.volume24h  ?? null,
    txCount24h:   dexData?.txCount24h ?? null,
    holders,
    raw: {
      dexscreener: dexData?.raw ?? null,
      holderSource: holders !== null ? "helius" : null,
    },
    source: dexData ? "dexscreener" : "partial",
  };

  if (result.marketCap) {
    marketBus.publish({
      chain:         "solana",
      token_address: mint,
      timestamp:     Date.now(),
      market_cap:    result.marketCap,
      liquidity:     result.liquidityUsd ?? undefined,
      volume_24h:    result.volume24h    ?? undefined,
      price_usd:     result.priceUsd     ?? undefined,
      provider:      "DEXSCREENER",
    });
  }

  return result;
}

// ── DexScreener ───────────────────────────────────────────────────────────────

interface DexPair {
  chainId?: string;
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

interface DexResponse {
  pairs?: DexPair[];
}

async function fetchDexScreener(mint: string): Promise<{
  priceUsd: string | null;
  marketCap: number | null;
  liquidity: number | null;
  volume24h: number | null;
  txCount24h: number | null;
  raw: Record<string, unknown>;
} | null> {
  try {
    const url = `${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const body = (await res.json()) as DexResponse;
    const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana");
    if (pairs.length === 0) return null;

    const best = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a
    );

    const h24 = best.txns?.h24;
    const txCount = h24 ? (h24.buys ?? 0) + (h24.sells ?? 0) : null;

    return {
      priceUsd:   best.priceUsd ?? null,
      marketCap:  best.fdv ? Math.round(best.fdv) : null,
      liquidity:  best.liquidity?.usd ? Math.round(best.liquidity.usd) : null,
      volume24h:  best.volume?.h24 ? Math.round(best.volume.h24) : null,
      txCount24h: txCount,
      raw: {
        pairsCount: pairs.length,
        bestPair: {
          priceUsd:      best.priceUsd,
          fdv:           best.fdv,
          liquidityUsd:  best.liquidity?.usd,
          volume24h:     best.volume?.h24,
          txns24h:       best.txns?.h24,
          pairCreatedAt: best.pairCreatedAt,
        },
      },
    };
  } catch (err) {
    logger.warn({ err, mint }, "DexScreener market data fetch error");
    return null;
  }
}

// ── Helius holder count ───────────────────────────────────────────────────────

async function fetchHolderCount(mint: string): Promise<number | null> {
  const apiKey = getSetting("helius_api_key");
  if (!apiKey) return null;

  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      "alpha-holders",
        method:  "getTokenAccounts",
        params:  { mint, limit: 1 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      result?: { total?: number };
      error?: unknown;
    };

    if (json.error) return null;
    return json.result?.total ?? null;
  } catch {
    return null;
  }
}
