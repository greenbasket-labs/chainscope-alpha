/**
 * Alpha DexScreener Poller
 *
 * Polls four DexScreener endpoints every POLL_INTERVAL_MS, enriches
 * each fresh Solana token, runs the active elite filter profile,
 * stores the result in alpha_candidates, and fires alertBus for tokens
 * that pass a live-trading-enabled flow.
 *
 * Token deduplication: tokens seen in the last TTL_MS are skipped.
 * Only "new" tokens (not already in alpha_candidates within 6h) are enriched.
 */

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { marketBus } from "../marketBus/index.js";
import { alertBus, type NewAlertEvent } from "../trader/alertBus.js";
import { evaluateEliteFilterForFlow, evaluateEliteFilter } from "../eliteFilter/engine.js";
import type { CandidateSignals } from "../eliteFilter/types.js";
import {
  fetchLatestProfiles,
  fetchRecentProfiles,
  fetchTopBoosted,
  fetchLatestBoosted,
  enrichToken,
  type DiscoveredToken,
} from "./providers.js";

// ── Config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 3 * 60 * 1_000;  // 3 minutes
const DEDUP_TTL_MS      = 6 * 60 * 60 * 1_000; // 6 hours — skip re-enriching
const ENRICH_CONCURRENCY = 5; // max parallel enrichment calls per poll

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

// ── Start / Stop ──────────────────────────────────────────────────────────────

export function startPoller(): void {
  if (running) return;
  running = true;
  logger.info("Alpha DexScreener poller started");
  void runPoll(); // immediate first run
}

export function stopPoller(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info("Alpha DexScreener poller stopped");
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function runPoll(): Promise<void> {
  if (!running) return;

  try {
    await poll();
  } catch (err) {
    logger.error({ err }, "Alpha poller poll() threw unexpectedly");
  }

  if (running) {
    pollTimer = setTimeout(() => void runPoll(), POLL_INTERVAL_MS);
  }
}

async function poll(): Promise<void> {
  const start = Date.now();

  // 1. Collect raw tokens from all 4 providers in parallel
  const [profiles1, profiles2, boosted1, boosted2] = await Promise.allSettled([
    fetchLatestProfiles(),
    fetchRecentProfiles(),
    fetchTopBoosted(),
    fetchLatestBoosted(),
  ]);

  const raw: DiscoveredToken[] = [];
  const seen = new Set<string>();

  for (const result of [profiles1, profiles2, boosted1, boosted2]) {
    if (result.status !== "fulfilled") continue;
    for (const t of result.value) {
      if (!seen.has(t.tokenAddress)) {
        seen.add(t.tokenAddress);
        raw.push(t);
      }
    }
  }

  logger.debug({ count: raw.length }, "Alpha poller: raw tokens collected");

  // 2. Filter out tokens already seen recently
  const cutoff = Date.now() - DEDUP_TTL_MS;
  const fresh = raw.filter((t) => {
    const existing = sqlite
      .prepare("SELECT polled_at FROM alpha_candidates WHERE token_address = ? LIMIT 1")
      .get(t.tokenAddress) as { polled_at: number } | undefined;
    return !existing || existing.polled_at < cutoff;
  });

  logger.debug({ fresh: fresh.length, skipped: raw.length - fresh.length }, "Alpha poller: after dedup");

  if (fresh.length === 0) return;

  // 3. Enrich in batches
  const enriched = await enrichBatch(fresh);

  // 4. Store and route
  const now = Date.now();
  let stored = 0;
  let passed = 0;

  for (const candidate of enriched) {
    // Build signals for elite filter
    const signals: CandidateSignals = {
      mc:               candidate.marketCap,
      vol_mc:           candidate.marketCap && candidate.volume24h
                          ? candidate.volume24h / candidate.marketCap
                          : null,
      pair_age_minutes: candidate.pairAgeMinutes,
      buy_ratio:        candidate.buyRatio,
      liquidity:        candidate.liquidity,
      has_hev:          candidate.hasHev,
      has_bp:           candidate.hasBp,
      has_sp:           candidate.hasSp,
      has_np:           candidate.hasNp,
    };

    // Determine which flow claims this candidate (first match wins)
    const { flowId, result } = matchFlowForCandidate(signals);

    const filterStatus = result.passes
      ? (flowId ?? "PASSED")
      : "REJECTED";

    // Upsert into alpha_candidates
    sqlite
      .prepare(
        `INSERT INTO alpha_candidates (
          token_address, token_name, symbol, icon_url, pair_url,
          market_cap, fdv, liquidity, price_usd,
          volume_24h, volume_1h, volume_5m,
          pair_created_at, pair_age_minutes,
          buy_ratio, has_hev, has_bp, has_sp, has_np, boosts, source,
          elite_score, elite_passes, elite_result_json,
          filter_status, filter_profile_id,
          discovered_at, polled_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?
        )
        ON CONFLICT(token_address) DO UPDATE SET
          token_name = excluded.token_name,
          symbol = excluded.symbol,
          market_cap = excluded.market_cap,
          fdv = excluded.fdv,
          liquidity = excluded.liquidity,
          price_usd = excluded.price_usd,
          volume_24h = excluded.volume_24h,
          volume_1h = excluded.volume_1h,
          volume_5m = excluded.volume_5m,
          pair_age_minutes = excluded.pair_age_minutes,
          buy_ratio = excluded.buy_ratio,
          has_hev = excluded.has_hev,
          has_bp = excluded.has_bp,
          has_sp = excluded.has_sp,
          has_np = excluded.has_np,
          boosts = excluded.boosts,
          elite_score = excluded.elite_score,
          elite_passes = excluded.elite_passes,
          elite_result_json = excluded.elite_result_json,
          filter_status = excluded.filter_status,
          filter_profile_id = excluded.filter_profile_id,
          polled_at = excluded.polled_at`
      )
      .run(
        candidate.tokenAddress,
        candidate.tokenName,
        candidate.symbol,
        candidate.iconUrl,
        candidate.pairUrl,
        candidate.marketCap,
        candidate.fdv,
        candidate.liquidity,
        candidate.priceUsd,
        candidate.volume24h,
        candidate.volume1h,
        candidate.volume5m,
        candidate.pairCreatedAt,
        candidate.pairAgeMinutes,
        candidate.buyRatio,
        candidate.hasHev ? 1 : 0,
        candidate.hasBp  ? 1 : 0,
        candidate.hasSp  ? 1 : 0,
        candidate.hasNp  ? 1 : 0,
        candidate.boosts,
        candidate.source,
        result.score,
        result.passes ? 1 : 0,
        JSON.stringify({ score: result.score, blocked: result.blocked, profile_id: result.profile_id }),
        filterStatus,
        result.profile_id,
        now,
        now,
      );

    stored++;

    // Publish to marketBus
    if (candidate.marketCap && candidate.priceUsd) {
      marketBus.publish({
        chain:         "solana",
        token_address: candidate.tokenAddress,
        timestamp:     now,
        market_cap:    candidate.marketCap,
        liquidity:     candidate.liquidity ?? undefined,
        volume_24h:    candidate.volume24h ?? undefined,
        price_usd:     candidate.priceUsd?.toString(),
        provider:      "DEXSCREENER_POLLER",
      });
    }

    // Publish to alertBus for simulation/live engine
    if (result.passes && flowId) {
      const row = sqlite
        .prepare("SELECT id FROM alpha_candidates WHERE token_address = ? LIMIT 1")
        .get(candidate.tokenAddress) as { id: number } | undefined;

      const alertEvent: NewAlertEvent = {
        alertId:         row?.id ?? 0,
        tokenId:         row?.id ?? 0,
        tokenAddress:    candidate.tokenAddress,
        investigationId: null,
        evidenceScore:   result.score,
        confidence:      result.winner_similarity,
        alertProfile: {
          marketCap:    candidate.marketCap,
          liquidity:    candidate.liquidity,
          buyRatio:     candidate.buyRatio,
          buyCount:     candidate.volume24h,  // approximate
          sellCount:    null,
          volume1h:     candidate.volume1h,
          pairAgeMinutes: candidate.pairAgeMinutes,
          hasHev:       candidate.hasHev,
          hasBp:        candidate.hasBp,
          hasSp:        candidate.hasSp,
          hasNp:        candidate.hasNp,
          triggers: [
            ...(candidate.hasHev ? [{ type: "HIGH_EARLY_VOLUME" }]  : []),
            ...(candidate.hasBp  ? [{ type: "BUY_PRESSURE" }]       : []),
            ...(candidate.hasSp  ? [{ type: "SELL_PRESSURE" }]      : []),
            ...(candidate.hasNp  ? [{ type: "NEW_PROFILE" }]        : []),
          ],
        },
        flowId:    flowId,
        createdAt: now,
      };

      alertBus.emit("alert", alertEvent);
      passed++;

      logger.info(
        { token: candidate.tokenAddress, symbol: candidate.symbol, flowId, score: result.score.toFixed(3) },
        "Alpha alert fired"
      );
    }
  }

  logger.info(
    { stored, passed, elapsed: Date.now() - start },
    "Alpha poller cycle complete"
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Enrich up to ENRICH_CONCURRENCY tokens in parallel, in batches. */
async function enrichBatch(tokens: DiscoveredToken[]) {
  const results = [];
  for (let i = 0; i < tokens.length; i += ENRICH_CONCURRENCY) {
    const batch = tokens.slice(i, i + ENRICH_CONCURRENCY);
    const enriched = await Promise.allSettled(batch.map(enrichToken));
    for (const r of enriched) {
      if (r.status === "fulfilled" && r.value) {
        results.push(r.value);
      }
    }
  }
  return results;
}

/** Check all enabled flows in priority order; return first match. */
function matchFlowForCandidate(signals: CandidateSignals): {
  flowId: string | null;
  result: ReturnType<typeof evaluateEliteFilter>;
} {
  const flows = sqlite
    .prepare(
      `SELECT id, filter_profile_id, live_trading_enabled
       FROM alert_flows
       WHERE enabled = 1
       ORDER BY priority ASC, id ASC`
    )
    .all() as Array<{ id: string; filter_profile_id: string | null; live_trading_enabled: number }>;

  for (const flow of flows) {
    // Skip non-trading flows for alertBus publishing, but still evaluate
    const result = evaluateEliteFilterForFlow(flow.id, signals);
    if (result.passes) {
      return { flowId: flow.id, result };
    }
  }

  // No flow matched — run global eval for storage only
  const result = evaluateEliteFilter(signals);
  return { flowId: null, result };
}
