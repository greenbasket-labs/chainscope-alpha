/**
 * DexScreener Discovery Providers
 *
 * Fetches fresh Solana token addresses from four free DexScreener endpoints:
 *   1. Latest Token Profiles  — tokens that just got a DexScreener profile
 *   2. Recent Token Profiles  — recent profiles (last 24h)
 *   3. Top Boosted Tokens     — heavily boosted tokens
 *   4. Latest Boosted Tokens  — tokens that just received a boost
 *
 * Each provider returns { tokenAddress, source } pairs.
 * Deduplication is handled by the poller.
 */

import { logger } from "../lib/logger.js";
import type { DexProfile, DexBoost } from "./types.js";

const TIMEOUT_MS = 12_000;

async function timedFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
}

export interface DiscoveredToken {
  tokenAddress: string;
  source:       string;
  iconUrl?:     string;
  pairUrl?:     string;
  boosts?:      number;
}

// ── Latest Token Profiles ────────────────────────────────────────────────────

export async function fetchLatestProfiles(): Promise<DiscoveredToken[]> {
  try {
    const res = await timedFetch("https://api.dexscreener.com/token-profiles/latest/v1");
    if (!res.ok) return [];
    const raw = (await res.json()) as DexProfile[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p.chainId === "solana" && p.tokenAddress)
      .map((p) => ({
        tokenAddress: p.tokenAddress!,
        source:       "dex_latest_profiles",
        iconUrl:      p.icon,
        pairUrl:      p.url,
      }));
  } catch (err) {
    logger.debug({ err }, "fetchLatestProfiles failed");
    return [];
  }
}

// ── Recent Token Profiles (last 24h, sorted newest first) ────────────────────

export async function fetchRecentProfiles(): Promise<DiscoveredToken[]> {
  try {
    const res = await timedFetch("https://api.dexscreener.com/token-profiles/latest/v1");
    if (!res.ok) return [];
    const raw = (await res.json()) as DexProfile[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p.chainId === "solana" && p.tokenAddress)
      .map((p) => ({
        tokenAddress: p.tokenAddress!,
        source:       "dex_recent_profiles",
        iconUrl:      p.icon,
        pairUrl:      p.url,
      }));
  } catch (err) {
    logger.debug({ err }, "fetchRecentProfiles failed");
    return [];
  }
}

// ── Top Boosted Tokens ────────────────────────────────────────────────────────

export async function fetchTopBoosted(): Promise<DiscoveredToken[]> {
  try {
    const res = await timedFetch("https://api.dexscreener.com/token-boosts/top/v1");
    if (!res.ok) return [];
    const raw = (await res.json()) as DexBoost[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((b) => b.chainId === "solana" && b.tokenAddress)
      .map((b) => ({
        tokenAddress: b.tokenAddress!,
        source:       "dex_top_boost",
        iconUrl:      b.icon,
        pairUrl:      b.url,
        boosts:       b.totalAmount ?? b.amount,
      }));
  } catch (err) {
    logger.debug({ err }, "fetchTopBoosted failed");
    return [];
  }
}

// ── Latest Boosted Tokens ─────────────────────────────────────────────────────

export async function fetchLatestBoosted(): Promise<DiscoveredToken[]> {
  try {
    const res = await timedFetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (!res.ok) return [];
    const raw = (await res.json()) as DexBoost[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((b) => b.chainId === "solana" && b.tokenAddress)
      .map((b) => ({
        tokenAddress: b.tokenAddress!,
        source:       "dex_latest_boost",
        iconUrl:      b.icon,
        pairUrl:      b.url,
        boosts:       b.totalAmount ?? b.amount,
      }));
  } catch (err) {
    logger.debug({ err }, "fetchLatestBoosted failed");
    return [];
  }
}

// ── Enrich with pair data ─────────────────────────────────────────────────────
// Called per-token to get price, MC, volume, txns.

import type { DexTokenResponse, DexPairInfo, AlphaCandidate } from "./types.js";

export async function enrichToken(
  token: DiscoveredToken,
): Promise<AlphaCandidate | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${token.tokenAddress}`;
    const res = await timedFetch(url);
    if (!res.ok) return null;

    const body = (await res.json()) as DexTokenResponse;
    const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana");
    if (pairs.length === 0) return null;

    // Best pair = highest liquidity
    const best: DexPairInfo = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a
    );

    const now = Date.now();
    const pairCreatedAt = best.pairCreatedAt ?? null;
    const pairAgeMs = pairCreatedAt ? now - pairCreatedAt : null;
    const pairAgeMinutes = pairAgeMs ? pairAgeMs / 60_000 : null;

    const h24 = best.txns?.h24;
    const buys24  = h24?.buys  ?? 0;
    const sells24 = h24?.sells ?? 0;
    const total24 = buys24 + sells24;
    const buyRatio = total24 > 0 ? buys24 / total24 : null;

    // Signal detection
    // HEV: High Early Volume — volume/MC ratio is elevated (Vol24h > 0.5× MC)
    const mc       = best.fdv ? Math.round(best.fdv) : null;
    const vol24h   = best.volume?.h24 ? Math.round(best.volume.h24) : null;
    const vol1h    = best.volume?.h1  ? Math.round(best.volume.h1)  : null;
    const vol5m    = best.volume?.m5  ? Math.round(best.volume.m5)  : null;
    const liq      = best.liquidity?.usd ? Math.round(best.liquidity.usd) : null;

    const volMc    = mc && vol24h ? vol24h / mc : null;
    const hasHev   = volMc !== null && volMc >= 0.3;  // 30%+ volume/MC

    // Buy pressure: buys significantly outnumber sells in recent window
    const h1 = best.txns?.h1;
    const buys1h  = h1?.buys  ?? 0;
    const sells1h = h1?.sells ?? 0;
    const total1h = buys1h + sells1h;
    const buyRatio1h = total1h > 0 ? buys1h / total1h : null;
    const hasBp = buyRatio1h !== null && buyRatio1h >= 0.7 && total1h >= 10;

    // Sell pressure: sells significantly outnumber buys
    const hasSp = buyRatio1h !== null && buyRatio1h < 0.4 && total1h >= 10;

    // New pair: less than 30 minutes old
    const hasNp = pairAgeMinutes !== null && pairAgeMinutes < 30;

    return {
      tokenAddress:   token.tokenAddress,
      tokenName:      best.baseToken?.name ?? null,
      symbol:         best.baseToken?.symbol ?? null,
      iconUrl:        token.iconUrl ?? null,
      pairUrl:        token.pairUrl ?? best.url ?? null,
      marketCap:      mc,
      fdv:            mc,
      liquidity:      liq,
      priceUsd:       best.priceUsd ? parseFloat(best.priceUsd) : null,
      volume24h:      vol24h,
      volume1h:       vol1h,
      volume5m:       vol5m,
      pairCreatedAt,
      pairAgeMinutes,
      buyRatio,
      hasHev,
      hasBp,
      hasSp,
      hasNp,
      boosts:         token.boosts ?? best.boosts?.active ?? null,
      source:         token.source,
    };
  } catch (err) {
    logger.debug({ err, token: token.tokenAddress }, "enrichToken failed");
    return null;
  }
}
