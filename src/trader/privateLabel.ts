/**
 * Private Trading Desk — Label Classifier
 *
 * Independent overlay classification built entirely from evidence already
 * present in alert_profile at the moment an alert fires.
 *
 * Does NOT modify the official ChainScope scoring engine.
 * Does NOT access the database directly.
 * Does NOT call any external APIs.
 *
 * Thresholds are derived from empirical analysis of 310 alerted tokens
 * with computable first-hour ATH outcomes.
 *
 * Label hierarchy (best → worst):
 *   IGNITION — Full conviction: early, real market, demand confirmed. Buy.
 *   LIVE     — One condition short of IGNITION. Watch for upgrade; small entry.
 *   SCOUT    — Timing right, demand partial or market thin. Watch only.
 *   GHOST    — Timing missed or market out of range. Ignore.
 *   FLUSH    — Net selling at alert time. Reject immediately.
 */

export type PrivateLabel  = "IGNITION" | "LIVE" | "SCOUT" | "GHOST" | "FLUSH";
export type PrivateAction = "BUY" | "WATCH FOR UPGRADE" | "WATCH ONLY" | "IGNORE" | "REJECT";

export interface PrivateLabelInput {
  /** Seconds since the token's DexScreener pair was created (pairCreatedAt). */
  alertAgeSeconds: number;
  /** alert_profile.marketCap — market cap at alert delivery time (USD). */
  marketCap:       number | null;
  /** alert_profile.buyCount — buy transactions in the DexScreener snapshot. */
  buyCount:        number | null;
  /** alert_profile.sellCount — sell transactions in the DexScreener snapshot. */
  sellCount:       number | null;
  /** alert_profile.volume1h — 1-hour trailing volume at alert time (USD). */
  volume1h:        number | null;
  /** Whether BUY_PRESSURE trigger fired in the alert_profile triggers array. */
  hasBuyPressure:  boolean;
  /** Whether SELL_PRESSURE trigger fired in the alert_profile triggers array. */
  hasSellPressure: boolean;
  /** Raw liquidity at alert time (USD) — informational only, not a hard gate. */
  liquidity:       number | null;
}

export interface PrivateLabelResult {
  label:      PrivateLabel;
  action:     PrivateAction;
  confidence: number; // 0–100
  /** Conditions that passed (✓ lines). */
  reasons:    string[];
  /** Conditions that reduced conviction (✗ lines). */
  rejections: string[];
}

// ── Empirical thresholds ───────────────────────────────────────────────────────
//
// Derived from corpus analysis (310 alerts × first-hour ATH outcomes):
//   MC $50K–$500K    → median ATH +41–76%  vs  +9–22% outside range
//   Alert age <60s   → median ATH +24%      vs  +3%   after 60 s
//   Buy ratio ≥60%   → median +28%, avg +141%
//   Buy ratio <50%   → median +8%           — clear loser profile
//   BUY_PRESSURE     → median doubles (12% → 28%)
//   vol/MC 0.6–1.0   → median +68%          vs  +15%  fully-churned tokens

const MC_MIN_IGNITION = 50_000;
const MC_MAX_IGNITION = 500_000;
const MC_MIN_LIVE     = 10_000;
const MC_MIN_SCOUT    = 10_000;
const MC_MAX_SCOUT    = 500_000;

const AGE_IGNITION_S  = 60;
const AGE_LIVE_S      = 90;
const AGE_SCOUT_S     = 180;

const BR_FLUSH        = 0.50;
const BR_BORDERLINE   = 0.55;
const BR_GOOD         = 0.60;
const BR_STRONG       = 0.65;

const VOL_MC_CLEAN    = 1.0;
const VOL_MC_LIVE     = 2.0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buyRatio(b: number | null, s: number | null): number | null {
  const total = (b ?? 0) + (s ?? 0);
  return total > 0 ? (b ?? 0) / total : null;
}

function volToMC(vol: number | null, mc: number | null): number | null {
  if (!vol || !mc || mc <= 0) return null;
  return vol / mc;
}

function pct(r: number | null): string {
  return r !== null ? `${Math.round(r * 100)}%` : "—";
}

function usd(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function age(s: number): string {
  if (s < 60)   return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ── Main classifier ────────────────────────────────────────────────────────────

export function computePrivateLabel(input: PrivateLabelInput): PrivateLabelResult {
  const { alertAgeSeconds, marketCap, buyCount, sellCount,
          volume1h, hasBuyPressure, hasSellPressure, liquidity } = input;

  const br   = buyRatio(buyCount, sellCount);
  const vtmc = volToMC(volume1h, marketCap);

  const ok:  string[] = [];
  const bad: string[] = [];

  // ── FLUSH — net selling, reject immediately ────────────────────────────────
  if (br !== null && br < BR_FLUSH) {
    bad.push(`Buy ratio ${pct(br)} — net selling at alert time`);
    if (hasSellPressure) bad.push("SELL_PRESSURE trigger active");
    return { label: "FLUSH", action: "REJECT", confidence: 0, reasons: ok, rejections: bad };
  }

  // ── Precompute flags ───────────────────────────────────────────────────────
  const ageOk      = alertAgeSeconds < AGE_IGNITION_S;
  const ageLiveOk  = alertAgeSeconds < AGE_LIVE_S;
  const ageScoutOk = alertAgeSeconds < AGE_SCOUT_S;

  const mcGood     = marketCap !== null && marketCap >= MC_MIN_IGNITION && marketCap <= MC_MAX_IGNITION;
  const mcLow      = marketCap !== null && marketCap >= MC_MIN_LIVE     && marketCap <  MC_MIN_IGNITION;
  const mcTooSmall = marketCap !== null && marketCap < MC_MIN_SCOUT;
  const mcTooLarge = marketCap !== null && marketCap > MC_MAX_IGNITION;

  const buyGood   = br !== null && br >= BR_GOOD;
  const buyStrong = br !== null && br >= BR_STRONG;
  const buyEdge   = br !== null && br >= BR_BORDERLINE && br < BR_GOOD;

  const volClean  = vtmc === null || vtmc < VOL_MC_CLEAN;   // null → give benefit of doubt
  const volHot    = vtmc !== null && vtmc >= VOL_MC_CLEAN && vtmc < VOL_MC_LIVE;
  const volBurned = vtmc !== null && vtmc >= VOL_MC_LIVE;

  // ── GHOST — definitively out of range ────────────────────────────────────
  if (!ageScoutOk) {
    bad.push(`Alert age ${age(alertAgeSeconds)} — entry window closed (>3 min)`);
    return { label: "GHOST", action: "IGNORE", confidence: 0, reasons: ok, rejections: bad };
  }
  if (mcTooSmall) {
    bad.push(`MC ${usd(marketCap)} — below $10K, too thin to trade`);
    return { label: "GHOST", action: "IGNORE", confidence: 0, reasons: ok, rejections: bad };
  }
  if (mcTooLarge) {
    bad.push(`MC ${usd(marketCap)} — above $500K, primary move likely complete`);
    return { label: "GHOST", action: "IGNORE", confidence: 0, reasons: ok, rejections: bad };
  }

  // ── IGNITION — all five conditions pass ───────────────────────────────────
  if (ageOk && mcGood && hasBuyPressure && buyGood && volClean) {
    ok.push(`BUY_PRESSURE`);
    if (br !== null) ok.push(`Buy Ratio = ${pct(br)}`);
    ok.push(`Alert Age = ${age(alertAgeSeconds)}`);
    ok.push(`MC = ${usd(marketCap)}`);
    if (vtmc !== null) ok.push(`Vol/MC = ${vtmc.toFixed(2)}× (float not yet churned)`);
    if (hasSellPressure) bad.push("SELL_PRESSURE also active — consider reducing size");
    if (liquidity !== null && liquidity < 5_000) bad.push(`Liquidity ${usd(liquidity)} — thin pool`);
    const conf = 95 - (hasSellPressure ? 10 : 0) - (volHot ? 5 : 0);
    return { label: "IGNITION", action: "BUY", confidence: conf, reasons: ok, rejections: bad };
  }

  // ── LIVE — one condition short of IGNITION ────────────────────────────────
  // Profile A: MC too small ($10K–$50K) but demand fully confirmed
  const profileA = mcLow && ageLiveOk && hasBuyPressure && buyGood && !volBurned;
  // Profile B: MC good, timing ok, strong buy ratio — BP not yet fired
  const profileB = mcGood && ageLiveOk && buyStrong && !volBurned;
  // Profile C: IGNITION but float slightly churned (vol/MC 1–2×)
  const profileC = mcGood && ageOk && hasBuyPressure && buyGood && volHot;
  // Profile D: IGNITION but buy ratio borderline (0.55–0.60)
  const profileD = mcGood && ageOk && hasBuyPressure && buyEdge && volClean;

  if (profileA || profileB || profileC || profileD) {
    if (hasBuyPressure) ok.push("BUY_PRESSURE");
    if (br !== null)    ok.push(`Buy Ratio = ${pct(br)}`);
    ok.push(`Alert Age = ${age(alertAgeSeconds)}`);
    if (marketCap !== null) ok.push(`MC = ${usd(marketCap)}`);
    // Report the weakest link
    if (!ageOk)         bad.push(`Alert age ${age(alertAgeSeconds)} — past first minute`);
    if (!mcGood && mcLow) bad.push(`MC ${usd(marketCap)} — below preferred $50K range`);
    if (!hasBuyPressure)  bad.push("BUY_PRESSURE not yet confirmed");
    if (!buyGood && buyEdge) bad.push(`Buy ratio ${pct(br)} — slightly below 60%`);
    if (volHot)           bad.push(`Vol/MC ${vtmc?.toFixed(1)}× — float partially churned`);
    if (liquidity !== null && liquidity < 3_000) bad.push(`Liquidity ${usd(liquidity)} — very thin pool`);
    else if (liquidity !== null && liquidity < 10_000) bad.push(`Liquidity ${usd(liquidity)} — slightly below preferred range`);
    const conf = 72
      - (!ageOk ? 8 : 0)
      - (!mcGood ? 8 : 0)
      - (!hasBuyPressure ? 6 : 0)
      - (!buyGood ? 5 : 0)
      - (volHot ? 4 : 0);
    return { label: "LIVE", action: "WATCH FOR UPGRADE", confidence: Math.max(conf, 40), reasons: ok, rejections: bad };
  }

  // ── SCOUT — timing ok, partial demand signals ──────────────────────────────
  const mcScoutOk = marketCap !== null && marketCap >= MC_MIN_SCOUT && marketCap <= MC_MAX_SCOUT;
  if (ageScoutOk && mcScoutOk) {
    if (ageOk)   ok.push(`Alert Age = ${age(alertAgeSeconds)}`);
    else         bad.push(`Alert age ${age(alertAgeSeconds)} — past first minute`);
    if (marketCap !== null) ok.push(`MC = ${usd(marketCap)}`);
    if (hasBuyPressure)     ok.push("BUY_PRESSURE");
    if (br !== null)        ok.push(`Buy Ratio = ${pct(br)}`);
    if (!hasBuyPressure) bad.push("BUY_PRESSURE not confirmed");
    if (!buyGood) bad.push(`Buy ratio ${pct(br)} — below 60% threshold`);
    if (volBurned) bad.push(`Vol/MC ${vtmc?.toFixed(1)}× — float burned through`);
    return { label: "SCOUT", action: "WATCH ONLY", confidence: 30, reasons: ok, rejections: bad };
  }

  // ── GHOST fallback ────────────────────────────────────────────────────────
  if (!ageOk)    bad.push(`Alert age ${age(alertAgeSeconds)}`);
  if (!buyGood)  bad.push(`Buy ratio ${pct(br)} — insufficient demand`);
  if (volBurned) bad.push(`Vol/MC ${vtmc?.toFixed(1)}× — fully churned`);
  return { label: "GHOST", action: "IGNORE", confidence: 0, reasons: ok, rejections: bad };
}

// ── Parse alert_profile JSON into PrivateLabelInput ───────────────────────────

export function parseProfileForLabel(
  raw: string | Record<string, unknown> | null,
  alertAgeSeconds: number,
): PrivateLabelInput {
  let p: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try { p = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (raw && typeof raw === "object") {
    p = raw as Record<string, unknown>;
  }

  const triggers = Array.isArray(p["triggers"])
    ? (p["triggers"] as Array<{ type?: string }>).map(t => t.type ?? "")
    : [];

  return {
    alertAgeSeconds,
    marketCap:      typeof p["marketCap"]  === "number" ? p["marketCap"]  : null,
    buyCount:       typeof p["buyCount"]   === "number" ? p["buyCount"]   : null,
    sellCount:      typeof p["sellCount"]  === "number" ? p["sellCount"]  : null,
    volume1h:       typeof p["volume1h"]   === "number" ? p["volume1h"]   : null,
    liquidity:      typeof p["liquidity"]  === "number" ? p["liquidity"]  : null,
    hasBuyPressure:  triggers.includes("BUY_PRESSURE"),
    hasSellPressure: triggers.includes("SELL_PRESSURE"),
  };
}
