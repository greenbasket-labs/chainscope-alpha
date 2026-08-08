/**
 * Elite Filter — Database Layer
 *
 * All reads and writes for elite_filter_profiles, elite_filter_weights,
 * elite_filter_gold_tokens, and elite_filter_loser_tokens.
 * Uses better-sqlite3 (synchronous).
 */

import { sqlite } from "../db/index.js";
import type {
  EliteFilterProfile,
  EliteFilterWeight,
  EliteFilterGoldToken,
  EliteFilterLoserToken,
  ProfileTpLadderRung,
} from "./types.js";
import { DEFAULT_WEIGHTS } from "./types.js";

// ── Profiles ──────────────────────────────────────────────────────────────────

export function getActiveProfile(): EliteFilterProfile | null {
  return (
    (sqlite
      .prepare("SELECT * FROM elite_filter_profiles WHERE is_active = 1 LIMIT 1")
      .get() as EliteFilterProfile | undefined) ?? null
  );
}

export function getProfileById(id: string): EliteFilterProfile | null {
  return (
    (sqlite
      .prepare("SELECT * FROM elite_filter_profiles WHERE id = ?")
      .get(id) as EliteFilterProfile | undefined) ?? null
  );
}

export function listProfiles(): EliteFilterProfile[] {
  return sqlite
    .prepare("SELECT * FROM elite_filter_profiles ORDER BY created_at DESC")
    .all() as EliteFilterProfile[];
}

// ── Flow → Profile lookup ─────────────────────────────────────────────────────

/**
 * Returns the elite filter profile linked to a specific alert flow via
 * alert_flows.filter_profile_id.  Falls back to null if no link is set.
 * Callers should fall back to getActiveProfile() when this returns null.
 */
export function getProfileForFlow(flowId: string): EliteFilterProfile | null {
  const row = sqlite
    .prepare(
      `SELECT efp.*
         FROM alert_flows af
         JOIN elite_filter_profiles efp ON efp.id = af.filter_profile_id
        WHERE af.id = ?
        LIMIT 1`
    )
    .get(flowId) as EliteFilterProfile | undefined;
  return row ?? null;
}

/** Link an alert_flow to a specific filter profile. */
export function linkProfileToFlow(flowId: string, profileId: string | null): void {
  sqlite
    .prepare("UPDATE alert_flows SET filter_profile_id = ? WHERE id = ?")
    .run(profileId, flowId);
}

export interface CreateProfileInput {
  id:          string;
  name:        string;
  description?: string | null;
  version?:    string | null;
  notes?:      string | null;
  mc_min?:     number | null;
  mc_max?:     number | null;
  pair_age_min?: number | null;
  pair_age_max?: number | null;
  vol_mc_min?: number | null;
  vol_mc_max?: number | null;
  buy_ratio_min?: number | null;
  buy_ratio_max?: number | null;
  liq_min?:    number | null;
  liq_max?:    number | null;
  require_hev?:               number;
  block_buy_pressure?:        number;
  block_sell_pressure?:       number;
  require_new_pair?:          number;
  require_holder_growth?:     number;
  require_dev_safe?:          number;
  require_lp_locked?:         number;
  require_liquidity_present?: number;
  minimum_score?:      number;
  minimum_similarity?: number;
  minimum_confidence?: number;
  // Trading config (null = inherit from global trader_config)
  max_active_trades?:       number | null;
  max_buy_usd?:             number | null;
  stop_loss_pct?:           number | null;
  max_position_age_hours?:  number | null;
  entry_window_minutes?:    number | null;
  max_wallet_exposure_pct?: number | null;
  copyWeightsFrom?: string;
}

export function createProfile(input: CreateProfileInput): EliteFilterProfile {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO elite_filter_profiles (
         id, name, description, version, notes,
         mc_min, mc_max, pair_age_min, pair_age_max,
         vol_mc_min, vol_mc_max, buy_ratio_min, buy_ratio_max,
         liq_min, liq_max,
         require_hev, block_buy_pressure, block_sell_pressure,
         require_new_pair, require_holder_growth, require_dev_safe,
         require_lp_locked, require_liquidity_present,
         minimum_score, minimum_similarity, minimum_confidence,
         max_active_trades, max_buy_usd, stop_loss_pct,
         max_position_age_hours, entry_window_minutes, max_wallet_exposure_pct,
         is_active, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         0, ?, ?
       )`
    )
    .run(
      input.id,
      input.name,
      input.description ?? null,
      input.version    ?? null,
      input.notes      ?? null,
      input.mc_min   ?? null,
      input.mc_max   ?? null,
      input.pair_age_min ?? null,
      input.pair_age_max ?? null,
      input.vol_mc_min ?? null,
      input.vol_mc_max ?? null,
      input.buy_ratio_min ?? null,
      input.buy_ratio_max ?? null,
      input.liq_min  ?? null,
      input.liq_max  ?? null,
      input.require_hev               ?? 1,
      input.block_buy_pressure        ?? 0,
      input.block_sell_pressure       ?? 1,
      input.require_new_pair          ?? 0,
      input.require_holder_growth     ?? 0,
      input.require_dev_safe          ?? 0,
      input.require_lp_locked         ?? 0,
      input.require_liquidity_present ?? 0,
      input.minimum_score      ?? 0,
      input.minimum_similarity ?? 0,
      input.minimum_confidence ?? 0,
      input.max_active_trades       ?? null,
      input.max_buy_usd             ?? null,
      input.stop_loss_pct           ?? null,
      input.max_position_age_hours  ?? null,
      input.entry_window_minutes    ?? null,
      input.max_wallet_exposure_pct ?? null,
      now,
      now,
    );

  // Seed weights — copy from another profile or use defaults
  if (input.copyWeightsFrom) {
    const sourceWeights = getWeightsForProfile(input.copyWeightsFrom);
    if (sourceWeights.length > 0) {
      for (const w of sourceWeights) {
        upsertWeight(input.id, w.signal, w.weight, w.enabled);
      }
    } else {
      _seedDefaultWeights(input.id);
    }
  } else {
    _seedDefaultWeights(input.id);
  }

  return getProfileById(input.id)!;
}

export function updateProfile(
  id: string,
  updates: Partial<Omit<EliteFilterProfile, "id" | "created_at" | "is_active">>,
): void {
  const now = Date.now();
  const allowed: Array<keyof EliteFilterProfile> = [
    "name", "description", "version", "notes",
    "mc_min", "mc_max", "pair_age_min", "pair_age_max",
    "vol_mc_min", "vol_mc_max", "buy_ratio_min", "buy_ratio_max",
    "liq_min", "liq_max",
    "require_hev", "block_buy_pressure", "block_sell_pressure",
    "require_new_pair", "require_holder_growth", "require_dev_safe",
    "require_lp_locked", "require_liquidity_present",
    "minimum_score", "minimum_similarity", "minimum_confidence",
    // Trading config
    "max_active_trades", "max_buy_usd", "stop_loss_pct",
    "max_position_age_hours", "entry_window_minutes", "max_wallet_exposure_pct",
    // Liquidity exit
    "liquidity_exit_enabled", "liquidity_exit_drop_pct", "liquidity_exit_sell_percent",
    // Developer sell exit
    "dev_sell_enabled", "dev_sell_trigger_pct", "dev_sell_sell_pct",
    // Time exit
    "time_exit_enabled", "time_exit_max_hold_minutes", "time_exit_sell_percent",
  ];

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (key in updates) {
      setClauses.push(`${key} = ?`);
      values.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = ?");
  values.push(now);
  values.push(id);

  sqlite
    .prepare(`UPDATE elite_filter_profiles SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function activateProfile(id: string): void {
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare("UPDATE elite_filter_profiles SET is_active = 0, updated_at = ?")
      .run(now);
    sqlite
      .prepare("UPDATE elite_filter_profiles SET is_active = 1, updated_at = ? WHERE id = ?")
      .run(now, id);
  })();
}

export function deleteProfile(id: string): void {
  sqlite.prepare("DELETE FROM elite_filter_profiles WHERE id = ?").run(id);
}

export function duplicateProfile(sourceId: string, newId: string, newName: string): EliteFilterProfile | null {
  const source = getProfileById(sourceId);
  if (!source) return null;

  const { id: _id, is_active: _a, created_at: _c, updated_at: _u, name: _n, ...rest } = source;
  return createProfile({ id: newId, name: newName, ...rest, copyWeightsFrom: sourceId });
}

// ── Weights ───────────────────────────────────────────────────────────────────

export function getWeightsForProfile(profileId: string): EliteFilterWeight[] {
  return sqlite
    .prepare("SELECT * FROM elite_filter_weights WHERE profile_id = ? ORDER BY signal")
    .all(profileId) as EliteFilterWeight[];
}

export function upsertWeight(
  profileId: string,
  signal: string,
  weight: number,
  enabled: number = 1,
): void {
  sqlite
    .prepare(
      `INSERT INTO elite_filter_weights (profile_id, signal, weight, enabled)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, signal) DO UPDATE
         SET weight = excluded.weight, enabled = excluded.enabled`
    )
    .run(profileId, signal, weight, enabled);
}

export function bulkUpsertWeights(
  profileId: string,
  weights: Array<{ signal: string; weight: number; enabled?: number }>,
): void {
  const upsert = sqlite.prepare(
    `INSERT INTO elite_filter_weights (profile_id, signal, weight, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, signal) DO UPDATE
       SET weight = excluded.weight, enabled = excluded.enabled`
  );
  sqlite.transaction(() => {
    for (const w of weights) {
      upsert.run(profileId, w.signal, w.weight, w.enabled ?? 1);
    }
  })();
}

function _seedDefaultWeights(profileId: string): void {
  bulkUpsertWeights(
    profileId,
    DEFAULT_WEIGHTS.map((w) => ({ signal: w.signal, weight: w.weight, enabled: 1 })),
  );
}

// ── Gold Tokens (winners) ─────────────────────────────────────────────────────

export function getGoldTokensForProfile(profileId: string): EliteFilterGoldToken[] {
  return sqlite
    .prepare("SELECT * FROM elite_filter_gold_tokens WHERE profile_id = ? ORDER BY ath_x DESC NULLS LAST")
    .all(profileId) as EliteFilterGoldToken[];
}

export interface AddGoldTokenInput {
  profileId:       string;
  contractAddress: string;
  tokenName?:      string | null;
  mc?:             number | null;
  volMc?:          number | null;
  pairAgeMinutes?: number | null;
  buyRatio?:       number | null;
  liquidity?:      number | null;
  hasHev?:         boolean;
  hasBp?:          boolean;
  hasSp?:          boolean;
  hasNp?:          boolean;
  athX?:           number | null;
}

export function addGoldToken(input: AddGoldTokenInput): EliteFilterGoldToken {
  const now = Date.now();
  const result = sqlite
    .prepare(
      `INSERT INTO elite_filter_gold_tokens (
         profile_id, contract_address, token_name,
         mc, vol_mc, pair_age_minutes, buy_ratio, liquidity,
         has_hev, has_bp, has_sp, has_np, ath_x, added_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.profileId,
      input.contractAddress,
      input.tokenName ?? null,
      input.mc ?? null,
      input.volMc ?? null,
      input.pairAgeMinutes ?? null,
      input.buyRatio ?? null,
      input.liquidity ?? null,
      input.hasHev ? 1 : 0,
      input.hasBp  ? 1 : 0,
      input.hasSp  ? 1 : 0,
      input.hasNp  ? 1 : 0,
      input.athX ?? null,
      now,
    );
  return sqlite
    .prepare("SELECT * FROM elite_filter_gold_tokens WHERE id = ?")
    .get(result.lastInsertRowid) as EliteFilterGoldToken;
}

export function removeGoldToken(id: number): void {
  sqlite.prepare("DELETE FROM elite_filter_gold_tokens WHERE id = ?").run(id);
}

// ── Loser Tokens ──────────────────────────────────────────────────────────────

export function getLoserTokensForProfile(profileId: string): EliteFilterLoserToken[] {
  return sqlite
    .prepare("SELECT * FROM elite_filter_loser_tokens WHERE profile_id = ? ORDER BY added_at DESC")
    .all(profileId) as EliteFilterLoserToken[];
}

export interface AddLoserTokenInput {
  profileId:       string;
  contractAddress: string;
  tokenName?:      string | null;
  mc?:             number | null;
  volMc?:          number | null;
  pairAgeMinutes?: number | null;
  buyRatio?:       number | null;
  liquidity?:      number | null;
  hasHev?:         boolean;
  hasBp?:          boolean;
  hasSp?:          boolean;
  hasNp?:          boolean;
  athX?:           number | null;
}

export function addLoserToken(input: AddLoserTokenInput): EliteFilterLoserToken {
  const now = Date.now();
  const result = sqlite
    .prepare(
      `INSERT INTO elite_filter_loser_tokens (
         profile_id, contract_address, token_name,
         mc, vol_mc, pair_age_minutes, buy_ratio, liquidity,
         has_hev, has_bp, has_sp, has_np, ath_x, added_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.profileId,
      input.contractAddress,
      input.tokenName ?? null,
      input.mc ?? null,
      input.volMc ?? null,
      input.pairAgeMinutes ?? null,
      input.buyRatio ?? null,
      input.liquidity ?? null,
      input.hasHev ? 1 : 0,
      input.hasBp  ? 1 : 0,
      input.hasSp  ? 1 : 0,
      input.hasNp  ? 1 : 0,
      input.athX ?? null,
      now,
    );
  return sqlite
    .prepare("SELECT * FROM elite_filter_loser_tokens WHERE id = ?")
    .get(result.lastInsertRowid) as EliteFilterLoserToken;
}

export function removeLoserToken(id: number): void {
  sqlite.prepare("DELETE FROM elite_filter_loser_tokens WHERE id = ?").run(id);
}

// ── TP Ladder (per-profile take-profit rungs) ─────────────────────────────────

export function getTpLadderForProfile(profileId: string): ProfileTpLadderRung[] {
  return sqlite
    .prepare(
      `SELECT * FROM profile_tp_ladder
        WHERE profile_id = ? AND enabled = 1
        ORDER BY sort_order ASC, multiplier ASC`
    )
    .all(profileId) as ProfileTpLadderRung[];
}

export function upsertTpLadderRung(
  profileId: string,
  multiplier: number,
  sellPct: number,
  isMoonBag: number,
  enabled: number,
  sortOrder: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO profile_tp_ladder
         (profile_id, multiplier, sell_pct, is_moon_bag, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, multiplier) DO UPDATE
         SET sell_pct    = excluded.sell_pct,
             is_moon_bag = excluded.is_moon_bag,
             enabled     = excluded.enabled,
             sort_order  = excluded.sort_order`
    )
    .run(profileId, multiplier, sellPct, isMoonBag, enabled, sortOrder);
}

export function deleteTpLadderRung(id: number): void {
  sqlite.prepare("DELETE FROM profile_tp_ladder WHERE id = ?").run(id);
}

/** Replace all TP ladder rungs for a profile atomically. */
export function replaceTpLadder(
  profileId: string,
  rungs: Array<{ multiplier: number; sell_pct: number; is_moon_bag: number; enabled: number; sort_order: number }>,
): void {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM profile_tp_ladder WHERE profile_id = ?").run(profileId);
    const insert = sqlite.prepare(
      `INSERT INTO profile_tp_ladder
         (profile_id, multiplier, sell_pct, is_moon_bag, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of rungs) {
      insert.run(profileId, r.multiplier, r.sell_pct, r.is_moon_bag, r.enabled, r.sort_order);
    }
  })();
}
