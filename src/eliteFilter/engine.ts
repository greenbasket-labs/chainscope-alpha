/**
 * Elite Filter — Engine
 *
 * Configuration-driven entry filter.  Reads the active profile from DB,
 * applies hard gates, computes a weighted quality score, and measures
 * similarity to both the winner (gold) and loser datasets.
 * Returns a full explainability breakdown and a human-readable report.
 *
 * Design:
 *   • Pure logic — no side-effects, no external API calls.
 *   • In-memory cache with a 60-second TTL to avoid a DB hit on every alert.
 *   • Falls back gracefully when no active profile exists.
 */

import {
  getActiveProfile,
  getProfileById,
  getProfileForFlow,
  getWeightsForProfile,
  getGoldTokensForProfile,
  getLoserTokensForProfile,
} from "./db.js";
import type {
  EliteFilterProfile,
  EliteFilterWeight,
  EliteFilterGoldToken,
  EliteFilterLoserToken,
  CandidateSignals,
  EliteFilterResult,
  BlockReason,
  SignalExplain,
  SignalStatus,
} from "./types.js";
import { SIGNAL_LABELS } from "./types.js";

// ── Cache ─────────────────────────────────────────────────────────────────────

interface ActiveConfig {
  profile:      EliteFilterProfile;
  weights:      EliteFilterWeight[];
  goldTokens:   EliteFilterGoldToken[];
  loserTokens:  EliteFilterLoserToken[];
  ts:           number;
}

let _cache: ActiveConfig | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

function loadConfig(): ActiveConfig | null {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) return _cache;

  const profile = getActiveProfile();
  if (!profile) { _cache = null; return null; }

  const weights      = getWeightsForProfile(profile.id);
  const goldTokens   = getGoldTokensForProfile(profile.id);
  const loserTokens  = getLoserTokensForProfile(profile.id);
  _cache = { profile, weights, goldTokens, loserTokens, ts: now };
  return _cache;
}

/** Call this when a profile is created, updated, or activated. */
export function invalidateEliteFilterCache(): void {
  _cache = null;
}

// ── Signal normalisation (0.0 – 1.0) ─────────────────────────────────────────

interface NormalisedSignals {
  mc:           number | null;
  vol_mc:       number | null;
  pair_age:     number | null;
  buy_ratio:    number | null;
  liquidity:    number | null;
  hev:          number;
  np:           number;
  buy_pressure: number;
  sell_pressure: number;
}

function normalise(s: CandidateSignals, p: EliteFilterProfile): NormalisedSignals {
  // Use loose null checks (== null) so undefined fields are treated as absent data.
  // MC — lower within range = better (more upside potential)
  let mc: number | null = null;
  if (s.mc != null && p.mc_min !== null && p.mc_max !== null && p.mc_max > p.mc_min) {
    mc = Math.max(0, Math.min(1, 1.0 - (s.mc - p.mc_min) / (p.mc_max - p.mc_min)));
  }

  // Vol/MC — higher is better; 5x or above = perfect
  let vol_mc: number | null = null;
  if (s.vol_mc != null) {
    vol_mc = Math.min(1.0, s.vol_mc / 5.0);
  }

  // Pair age — penalise extremes; optimal window is ~10 min
  let pair_age: number | null = null;
  if (s.pair_age_minutes != null) {
    const optimal = 10;
    const range   = Math.max(p.pair_age_max ?? 90, 30);
    pair_age = Math.max(0, 1.0 - Math.abs(s.pair_age_minutes - optimal) / range);
  }

  // Buy ratio — 0.35 (neutral) → 0.0; 0.85+ → 1.0
  let buy_ratio: number | null = null;
  if (s.buy_ratio != null) {
    buy_ratio = Math.max(0, Math.min(1, (s.buy_ratio - 0.35) / 0.50));
  }

  // Liquidity — $20k = max
  let liquidity: number | null = null;
  if (s.liquidity != null) {
    liquidity = Math.min(1.0, s.liquidity / 20_000);
  }

  return {
    mc,
    vol_mc,
    pair_age,
    buy_ratio,
    liquidity,
    hev:           s.has_hev ? 1 : 0,
    np:            s.has_np  ? 1 : 0,
    buy_pressure:  s.has_bp  ? 1 : 0,
    sell_pressure: s.has_sp  ? 1 : 0,
  };
}

function getSignalNorm(signal: string, n: NormalisedSignals): number | null {
  switch (signal) {
    case "mc":           return n.mc;
    case "vol_mc":       return n.vol_mc;
    case "pair_age":     return n.pair_age;
    case "buy_ratio":    return n.buy_ratio;
    case "liquidity":    return n.liquidity;
    case "hev":          return n.hev;
    case "np":           return n.np;
    case "buy_pressure": return n.buy_pressure;
    case "sell_pressure":return n.sell_pressure;
    default:             return null;
  }
}

function formatRawValue(signal: string, s: CandidateSignals): string {
  switch (signal) {
    case "mc":           return s.mc !== null ? `$${Math.round(s.mc / 1000)}k` : "N/A";
    case "vol_mc":       return s.vol_mc !== null ? `${s.vol_mc.toFixed(2)}x` : "N/A";
    case "pair_age":     return s.pair_age_minutes !== null ? `${s.pair_age_minutes.toFixed(1)}m` : "N/A";
    case "buy_ratio":    return s.buy_ratio !== null ? `${(s.buy_ratio * 100).toFixed(0)}%` : "N/A";
    case "liquidity":    return s.liquidity !== null ? `$${Math.round(s.liquidity / 1000)}k` : "N/A";
    case "hev":          return s.has_hev ? "✓" : "✗";
    case "np":           return s.has_np  ? "✓" : "✗";
    case "buy_pressure": return s.has_bp  ? "✓" : "—";
    case "sell_pressure":return s.has_sp  ? "✓" : "—";
    default:             return "N/A";
  }
}

// ── Weighted score ────────────────────────────────────────────────────────────

function computeWeightedScore(
  norms:   NormalisedSignals,
  weights: EliteFilterWeight[],
): { score: number; explain: SignalExplain[] } {
  let positiveMax   = 0;
  let contributions = 0;
  const explain: SignalExplain[] = [];

  for (const w of weights) {
    if (!w.enabled) continue;

    const norm = getSignalNorm(w.signal, norms);
    const label = SIGNAL_LABELS[w.signal] ?? w.signal;

    if (norm === null || !Number.isFinite(norm)) {
      explain.push({
        signal: w.signal, label,
        raw_value: "N/A", norm_value: null,
        weight: w.weight, contribution: 0,
        status: "N/A", reason: "data unavailable",
      });
      continue;
    }

    const contribution = norm * w.weight;
    contributions += contribution;
    if (w.weight > 0) positiveMax += w.weight;

    let status: SignalStatus;
    if (w.weight < 0 && norm > 0)  status = "PENALTY";
    else if (norm >= 0.5)           status = "PASS";
    else if (norm > 0)              status = "NEUTRAL";
    else                            status = "FAIL";

    explain.push({
      signal: w.signal, label,
      raw_value: "→",  // filled in by caller
      norm_value: parseFloat(norm.toFixed(4)),
      weight: w.weight,
      contribution: parseFloat(contribution.toFixed(4)),
      status,
    });
  }

  const score = positiveMax > 0
    ? Math.max(0, Math.min(1, contributions / positiveMax))
    : 0;

  return { score: parseFloat(score.toFixed(4)), explain };
}

// ── Similarity (shared between winner and loser datasets) ─────────────────────

function buildFeatureVector(
  norms:       NormalisedSignals,
  weights:     EliteFilterWeight[],
): Array<{ value: number; weight: number }> {
  return weights
    .filter((w) => w.enabled && w.weight !== 0)
    .map((w) => {
      const raw = getSignalNorm(w.signal, norms);
      // Treat null, undefined, and NaN as 0 so they don't corrupt dot products.
      const v = (raw != null && Number.isFinite(raw)) ? raw : 0;
      return { value: v, weight: Math.abs(w.weight) };
    });
}

function normDatasetToken(
  g: EliteFilterGoldToken | EliteFilterLoserToken,
  p: EliteFilterProfile,
): NormalisedSignals {
  return normalise(
    {
      mc:               g.mc,
      vol_mc:           g.vol_mc,
      pair_age_minutes: g.pair_age_minutes,
      buy_ratio:        g.buy_ratio,
      liquidity:        g.liquidity,
      has_hev:          g.has_hev === 1,
      has_bp:           g.has_bp  === 1,
      has_sp:           g.has_sp  === 1,
      has_np:           g.has_np  === 1,
    },
    p,
  );
}

/**
 * Weighted cosine similarity between two feature vectors.
 * Returns 0.0–1.0.
 */
function weightedCosineSim(
  a: Array<{ value: number; weight: number }>,
  b: Array<{ value: number; weight: number }>,
): number {
  let dot = 0, normA = 0, normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const w = a[i]!.weight;
    dot  += w * a[i]!.value * b[i]!.value;
    normA += w * a[i]!.value * a[i]!.value;
    normB += w * b[i]!.value * b[i]!.value;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? Math.min(1, dot / denom) : 0;
}

function computeDatasetSimilarity(
  norms:   NormalisedSignals,
  profile: EliteFilterProfile,
  weights: EliteFilterWeight[],
  tokens:  Array<EliteFilterGoldToken | EliteFilterLoserToken>,
): number {
  if (tokens.length === 0) return 0;

  const candidateVec = buildFeatureVector(norms, weights);
  if (candidateVec.length === 0) return 0;

  const similarities = tokens.map((g) => {
    const gNorms = normDatasetToken(g, profile);
    const gVec   = buildFeatureVector(gNorms, weights);
    return weightedCosineSim(candidateVec, gVec);
  });

  // Average of top-5 for stability
  const top5 = [...similarities].sort((a, b) => b - a).slice(0, 5);
  const sim   = top5.reduce((s, v) => s + v, 0) / top5.length;
  return parseFloat(Math.max(0, Math.min(1, sim)).toFixed(4));
}

// ── Hard gates ────────────────────────────────────────────────────────────────

function runHardGates(s: CandidateSignals, p: EliteFilterProfile): BlockReason[] {
  const blocked: BlockReason[] = [];

  if (p.require_hev          && !s.has_hev) blocked.push("MISSING_HEV");
  if (p.block_sell_pressure  && s.has_sp)   blocked.push("SELL_PRESSURE_BLOCKED");
  if (p.block_buy_pressure   && s.has_bp)   blocked.push("BUY_PRESSURE_BLOCKED");
  if (p.require_new_pair     && !s.has_np)  blocked.push("MISSING_NEW_PAIR");
  if (p.require_holder_growth && !s.has_holder_growth)  blocked.push("MISSING_HOLDER_GROWTH");
  if (p.require_dev_safe     && !s.is_dev_safe)         blocked.push("MISSING_DEV_SAFE");
  if (p.require_lp_locked    && !s.is_lp_locked)        blocked.push("MISSING_LP_LOCKED");
  if (p.require_liquidity_present && s.liquidity === null) blocked.push("MISSING_LIQUIDITY");

  if (s.mc !== null) {
    if (p.mc_min !== null && s.mc < p.mc_min) blocked.push("MC_TOO_LOW");
    if (p.mc_max !== null && s.mc > p.mc_max) blocked.push("MC_TOO_HIGH");
  }
  if (s.vol_mc !== null) {
    if (p.vol_mc_min !== null && s.vol_mc < p.vol_mc_min) blocked.push("VOL_MC_TOO_LOW");
    if (p.vol_mc_max !== null && s.vol_mc > p.vol_mc_max) blocked.push("VOL_MC_TOO_HIGH");
  }
  if (s.pair_age_minutes !== null) {
    if (p.pair_age_min !== null && s.pair_age_minutes < p.pair_age_min) blocked.push("PAIR_TOO_YOUNG");
    if (p.pair_age_max !== null && s.pair_age_minutes > p.pair_age_max) blocked.push("PAIR_TOO_OLD");
  }
  if (s.buy_ratio !== null) {
    if (p.buy_ratio_min !== null && s.buy_ratio < p.buy_ratio_min) blocked.push("BUY_RATIO_TOO_LOW");
    if (p.buy_ratio_max !== null && s.buy_ratio > p.buy_ratio_max) blocked.push("BUY_RATIO_TOO_HIGH");
  }
  if (s.liquidity !== null) {
    if (p.liq_min !== null && s.liquidity < p.liq_min) blocked.push("LIQ_TOO_LOW");
    if (p.liq_max !== null && s.liquidity > p.liq_max) blocked.push("LIQ_TOO_HIGH");
  }

  return blocked;
}

// ── Report generator ──────────────────────────────────────────────────────────

const GATE_LABELS: Record<BlockReason, string> = {
  MC_TOO_LOW:            "MC",
  MC_TOO_HIGH:           "MC",
  PAIR_TOO_YOUNG:        "Pair Age",
  PAIR_TOO_OLD:          "Pair Age",
  VOL_MC_TOO_LOW:        "Vol/MC",
  VOL_MC_TOO_HIGH:       "Vol/MC",
  BUY_RATIO_TOO_LOW:     "Buy Ratio",
  BUY_RATIO_TOO_HIGH:    "Buy Ratio",
  LIQ_TOO_LOW:           "Liquidity",
  LIQ_TOO_HIGH:          "Liquidity",
  MISSING_HEV:           "HEV",
  BUY_PRESSURE_BLOCKED:  "Buy Pressure",
  SELL_PRESSURE_BLOCKED: "Sell Pressure",
  MISSING_NEW_PAIR:      "New Pair",
  MISSING_HOLDER_GROWTH: "Holder Growth",
  MISSING_DEV_SAFE:      "Dev Safe",
  MISSING_LP_LOCKED:     "LP Locked",
  MISSING_LIQUIDITY:     "Liquidity",
  SCORE_TOO_LOW:         "Score",
  SIMILARITY_TOO_LOW:    "Winner Similarity",
  NO_ACTIVE_PROFILE:     "Profile",
};

function generateReport(
  passes:           boolean,
  blocked:          BlockReason[],
  score:            number,
  winner_sim:       number,
  loser_sim:        number,
  explain:          SignalExplain[],
  profile_name:     string | null,
): string {
  const lines: string[] = [];
  const decision = passes ? "PASS" : "FAIL";

  lines.push(decision);
  lines.push("");

  if (profile_name) {
    lines.push(`Profile: ${profile_name}`);
    lines.push("");
  }

  lines.push(`Winner Similarity: ${Math.round(winner_sim * 100)}%`);
  lines.push(`Loser Similarity:  ${Math.round(loser_sim  * 100)}%`);
  lines.push(`Quality Score:     ${Math.round(score      * 100)}%`);
  lines.push("");

  // Hard gates — show passing gates + any blocks
  const hardGateBlocked = blocked.filter(b => !["SCORE_TOO_LOW","SIMILARITY_TOO_LOW","NO_ACTIVE_PROFILE"].includes(b));
  if (hardGateBlocked.length > 0) {
    lines.push("Hard Gates");
    for (const b of hardGateBlocked) {
      lines.push(`  ✗ ${GATE_LABELS[b] ?? b} — ${b.replace(/_/g,' ').toLowerCase()}`);
    }
  } else {
    const passingGates: string[] = [];
    if (explain.some(e => e.signal === "mc" && e.status !== "N/A"))          passingGates.push("MC");
    if (explain.some(e => e.signal === "pair_age" && e.status !== "N/A"))    passingGates.push("Pair Age");
    if (explain.some(e => e.signal === "vol_mc" && e.status !== "N/A"))      passingGates.push("Vol/MC");
    if (explain.some(e => e.signal === "hev" && e.status === "PASS"))        passingGates.push("HEV");
    if (passingGates.length > 0) {
      lines.push("Hard Gates");
      for (const g of passingGates) lines.push(`  ✓ ${g}`);
    }
  }
  lines.push("");

  // Quality signals (positive weights that passed)
  const positiveSignals = explain.filter(e => e.weight > 0 && e.status === "PASS");
  if (positiveSignals.length > 0) {
    lines.push("Quality Signals");
    for (const e of positiveSignals) {
      lines.push(`  + ${e.label} (${e.raw_value})`);
    }
    lines.push("");
  }

  // Penalties (negative weight signals that fired)
  const penalties = explain.filter(e => e.status === "PENALTY");
  if (penalties.length > 0) {
    lines.push("Penalties");
    for (const e of penalties) {
      lines.push(`  − ${e.label} (${e.raw_value})`);
    }
    lines.push("");
  }

  // Soft threshold blocks
  const softBlocked = blocked.filter(b => ["SCORE_TOO_LOW","SIMILARITY_TOO_LOW"].includes(b));
  if (softBlocked.length > 0) {
    lines.push("Soft Threshold");
    for (const b of softBlocked) {
      lines.push(`  ✗ ${GATE_LABELS[b] ?? b}`);
    }
    lines.push("");
  }

  lines.push("Final Decision");
  if (blocked.length > 0) {
    lines.push(`  ${decision} (${blocked.join(", ")})`);
  } else {
    lines.push(`  ${decision}`);
  }

  return lines.join("\n");
}

// ── Shared evaluation core (accepts pre-loaded config) ────────────────────────

/**
 * Evaluate `signals` against an explicitly supplied profile + supporting data.
 * This is the core evaluation function used by all public entry points.
 * It contains no DB access and is fully pure.
 */
export function evaluateEliteFilterWithConfig(
  profile:     ReturnType<typeof getActiveProfile>,
  weights:     ReturnType<typeof getWeightsForProfile>,
  goldTokens:  ReturnType<typeof getGoldTokensForProfile>,
  loserTokens: ReturnType<typeof getLoserTokensForProfile>,
  signals:     CandidateSignals,
): EliteFilterResult {
  const computed = {
    mc:               signals.mc,
    vol_mc:           signals.vol_mc,
    pair_age_minutes: signals.pair_age_minutes,
    buy_ratio:        signals.buy_ratio,
    liquidity:        signals.liquidity,
    has_hev:          signals.has_hev,
    has_bp:           signals.has_bp,
    has_sp:           signals.has_sp,
    has_np:           signals.has_np,
  };

  if (!profile) {
    const report = generateReport(true, [], 0, 0, 0, [], null);
    return {
      passes: true, blocked: [], score: 0,
      winner_similarity: 0, loser_similarity: 0, similarity: 0,
      profile_id: null, profile_name: null,
      report, explain: [], computed,
    };
  }

  const blocked = runHardGates(signals, profile);
  if (blocked.length > 0) {
    const failExplain = blocked.map((b) => ({
      signal: b, label: GATE_LABELS[b] ?? b.replace(/_/g, " ").toLowerCase(),
      raw_value: "✗", norm_value: 0,
      weight: 0, contribution: 0,
      status: "FAIL" as const, reason: b,
    }));
    const report = generateReport(false, blocked, 0, 0, 0, failExplain, profile.name);
    return {
      passes: false, blocked, score: 0,
      winner_similarity: 0, loser_similarity: 0, similarity: 0,
      profile_id: profile.id, profile_name: profile.name,
      report, explain: failExplain, computed,
    };
  }

  const norms = normalise(signals, profile);
  const { score, explain: rawExplain } = computeWeightedScore(norms, weights);
  const explain: SignalExplain[] = rawExplain.map((e) => ({
    ...e,
    raw_value: formatRawValue(e.signal, signals),
  }));

  const winner_similarity = computeDatasetSimilarity(norms, profile, weights, goldTokens);
  const loser_similarity  = computeDatasetSimilarity(norms, profile, weights, loserTokens);

  const softBlocked: BlockReason[] = [];
  if (profile.minimum_score > 0 && score < profile.minimum_score)
    softBlocked.push("SCORE_TOO_LOW");
  if (profile.minimum_similarity > 0 && winner_similarity < profile.minimum_similarity)
    softBlocked.push("SIMILARITY_TOO_LOW");

  const allBlocked = [...blocked, ...softBlocked];
  const report = generateReport(
    allBlocked.length === 0, allBlocked, score, winner_similarity, loser_similarity,
    explain, profile.name,
  );

  return {
    passes: allBlocked.length === 0, blocked: allBlocked, score,
    winner_similarity, loser_similarity, similarity: winner_similarity,
    profile_id: profile.id, profile_name: profile.name,
    report, explain, computed,
  };
}

/**
 * Evaluate against the profile linked to a specific alert flow.
 * Falls back to the globally active profile when no flow-specific profile is set.
 */
export function evaluateEliteFilterForFlow(
  flowId:  string,
  signals: CandidateSignals,
): EliteFilterResult {
  const profile =
    getProfileForFlow(flowId) ??
    getActiveProfile();
  if (!profile) return evaluateEliteFilterWithConfig(null, [], [], [], signals);
  return evaluateEliteFilterWithConfig(
    profile,
    getWeightsForProfile(profile.id),
    getGoldTokensForProfile(profile.id),
    getLoserTokensForProfile(profile.id),
    signals,
  );
}

/**
 * Evaluate against a profile loaded by ID.
 * Falls back to passes=true when the profile does not exist.
 */
export function evaluateEliteFilterByProfileId(
  profileId: string,
  signals:   CandidateSignals,
): EliteFilterResult {
  const profile = getProfileById(profileId);
  if (!profile) return evaluateEliteFilterWithConfig(null, [], [], [], signals);
  return evaluateEliteFilterWithConfig(
    profile,
    getWeightsForProfile(profileId),
    getGoldTokensForProfile(profileId),
    getLoserTokensForProfile(profileId),
    signals,
  );
}

// ── Main entry point (active profile) ─────────────────────────────────────────

/**
 * Evaluate a candidate against the active Elite Filter profile.
 *
 * Returns a full result including passes/blocked/score/similarities/report/explain.
 * If no active profile exists, returns passes=true (no filter applied).
 */
export function evaluateEliteFilter(signals: CandidateSignals): EliteFilterResult {
  const config = loadConfig();
  return evaluateEliteFilterWithConfig(
    config?.profile    ?? null,
    config?.weights    ?? [],
    config?.goldTokens ?? [],
    config?.loserTokens ?? [],
    signals,
  );
}
