/**
 * Elite Filter — Types
 *
 * Configuration-driven trading filter that replaces all hardcoded thresholds.
 * Research updates the DB profile; no TypeScript changes are ever needed.
 */

// ── Profile (one row = one versioned filter config) ───────────────────────────

export interface EliteFilterProfile {
  id:          string;
  name:        string;
  description: string | null;
  version:     string | null; // human-readable version label, e.g. "v1", "v1.1"
  notes:       string | null; // research notes
  is_active:   number; // 1 = active; only one can be active at a time

  // Hard gate thresholds (null = gate disabled)
  mc_min:           number | null;
  mc_max:           number | null;
  pair_age_min:     number | null; // minutes
  pair_age_max:     number | null; // minutes
  vol_mc_min:       number | null;
  vol_mc_max:       number | null;
  buy_ratio_min:    number | null; // 0.0–1.0
  buy_ratio_max:    number | null;
  liq_min:          number | null;
  liq_max:          number | null;

  // Boolean hard gates (1 = enforce, 0 = ignore)
  require_hev:               number;
  block_buy_pressure:        number;
  block_sell_pressure:       number;
  require_new_pair:          number;
  require_holder_growth:     number;
  require_dev_safe:          number;
  require_lp_locked:         number;
  require_liquidity_present: number;

  // Minimum soft thresholds (0.0 = disabled)
  minimum_score:      number;
  minimum_similarity: number; // applies to winner_similarity
  minimum_confidence: number;

  // Per-profile trading config (null = fall back to global trader_config value)
  max_active_trades:      number | null; // concurrent open positions for this profile
  max_buy_usd:            number | null; // max buy size per trade
  stop_loss_pct:          number | null; // e.g. 90 = exit if price drops 90%
  max_position_age_hours: number | null; // force-close after this many hours
  entry_window_minutes:   number | null; // reject alerts older than this
  max_wallet_exposure_pct:number | null; // max % of sim capital deployed at once

  // Per-profile liquidity exit config
  liquidity_exit_enabled:      number;        // 0 = disabled, 1 = enabled
  liquidity_exit_drop_pct:     number | null; // % drop from entry liquidity that triggers exit
  liquidity_exit_sell_percent: number | null; // % of remaining tokens to sell (0–100)

  // Per-profile developer sell exit config
  dev_sell_enabled:     number;        // 0 = disabled, 1 = enabled
  dev_sell_trigger_pct: number | null; // % of total supply sold by creator that triggers exit
  dev_sell_sell_pct:    number | null; // % of remaining tokens to sell (0–100)

  // Per-profile time exit config
  time_exit_enabled:          number;        // 0 = disabled, 1 = enabled
  time_exit_max_hold_minutes: number | null; // minutes before time exit fires
  time_exit_sell_percent:     number | null; // % of remaining tokens to sell (0–100)

  created_at: number;
  updated_at: number;
}

// ── Per-profile TP ladder rung ─────────────────────────────────────────────────

export interface ProfileTpLadderRung {
  id:          number;
  profile_id:  string;
  multiplier:  number;   // price multiple from entry, e.g. 2.0 = 2x
  sell_pct:    number;   // % of remaining tokens to sell (0 for moon-bag rows)
  is_moon_bag: number;   // 1 = hold remainder indefinitely when triggered
  enabled:     number;   // 0 = skip this rung
  sort_order:  number;   // evaluation order (ascending)
}

// ── Weights (per-profile, per-signal) ─────────────────────────────────────────

export interface EliteFilterWeight {
  id:         number;
  profile_id: string;
  signal:     string;
  weight:     number; // negative = penalty
  enabled:    number; // 1 = included in score computation
}

// ── Gold Dataset token (reference winners for winner similarity) ──────────────

export interface EliteFilterGoldToken {
  id:               number;
  profile_id:       string;
  contract_address: string;
  token_name:       string | null;
  mc:               number | null;
  vol_mc:           number | null;
  pair_age_minutes: number | null;
  buy_ratio:        number | null;
  liquidity:        number | null;
  has_hev:          number;
  has_bp:           number;
  has_sp:           number;
  has_np:           number;
  ath_x:            number | null;
  added_at:         number;
}

// ── Loser Dataset token (reference losers for loser similarity) ───────────────

export interface EliteFilterLoserToken {
  id:               number;
  profile_id:       string;
  contract_address: string;
  token_name:       string | null;
  mc:               number | null;
  vol_mc:           number | null;
  pair_age_minutes: number | null;
  buy_ratio:        number | null;
  liquidity:        number | null;
  has_hev:          number;
  has_bp:           number;
  has_sp:           number;
  has_np:           number;
  ath_x:            number | null;
  added_at:         number;
}

// ── Input to the filter engine ────────────────────────────────────────────────

export interface CandidateSignals {
  mc:               number | null;
  vol_mc:           number | null;
  pair_age_minutes: number | null;
  buy_ratio:        number | null; // buy / (buy + sell), 0.0–1.0
  liquidity:        number | null;
  has_hev:          boolean;
  has_bp:           boolean;
  has_sp:           boolean;
  has_np:           boolean;
  // Future-proof — populated when the data becomes available
  has_holder_growth?: boolean;
  is_dev_safe?:       boolean;
  is_lp_locked?:      boolean;
}

// ── Explainability ────────────────────────────────────────────────────────────

export type SignalStatus = 'PASS' | 'FAIL' | 'PENALTY' | 'NEUTRAL' | 'N/A';

export interface SignalExplain {
  signal:       string;
  label:        string;
  raw_value:    string;          // human-readable raw value ("$12k", "2.77x", "✓")
  norm_value:   number | null;   // normalized 0–1 value used in scoring
  weight:       number;
  contribution: number;          // norm_value * weight
  status:       SignalStatus;
  reason?:      string;
}

export type BlockReason =
  | 'MC_TOO_LOW'
  | 'MC_TOO_HIGH'
  | 'PAIR_TOO_YOUNG'
  | 'PAIR_TOO_OLD'
  | 'VOL_MC_TOO_LOW'
  | 'VOL_MC_TOO_HIGH'
  | 'BUY_RATIO_TOO_LOW'
  | 'BUY_RATIO_TOO_HIGH'
  | 'LIQ_TOO_LOW'
  | 'LIQ_TOO_HIGH'
  | 'MISSING_HEV'
  | 'BUY_PRESSURE_BLOCKED'
  | 'SELL_PRESSURE_BLOCKED'
  | 'MISSING_NEW_PAIR'
  | 'MISSING_HOLDER_GROWTH'
  | 'MISSING_DEV_SAFE'
  | 'MISSING_LP_LOCKED'
  | 'MISSING_LIQUIDITY'
  | 'SCORE_TOO_LOW'
  | 'SIMILARITY_TOO_LOW'
  | 'NO_ACTIVE_PROFILE';

// ── Filter result ─────────────────────────────────────────────────────────────

export interface EliteFilterResult {
  passes:       boolean;
  blocked:      BlockReason[];
  score:        number;              // 0.0–1.0 weighted quality score
  winner_similarity: number;         // 0.0–1.0 similarity to gold winner dataset
  loser_similarity:  number;         // 0.0–1.0 similarity to loser dataset
  /** @deprecated use winner_similarity */
  similarity:   number;              // backward-compat alias → winner_similarity
  profile_id:   string | null;
  profile_name: string | null;
  report:       string;              // human-readable evaluation report
  explain:      SignalExplain[];
  computed: {
    mc:               number | null;
    vol_mc:           number | null;
    pair_age_minutes: number | null;
    buy_ratio:        number | null;
    liquidity:        number | null;
    has_hev:          boolean;
    has_bp:           boolean;
    has_sp:           boolean;
    has_np:           boolean;
  };
}

// ── Known signal keys ─────────────────────────────────────────────────────────

export const SIGNAL_LABELS: Record<string, string> = {
  mc:            'Market Cap',
  vol_mc:        'Vol / MC',
  pair_age:      'Pair Age',
  buy_ratio:     'Buy Ratio',
  liquidity:     'Liquidity',
  hev:           'High Early Volume',
  np:            'New Profile',
  buy_pressure:  'Buy Pressure',
  sell_pressure: 'Sell Pressure',
  holder_growth: 'Holder Growth',
  dev_safe:      'Dev Safe',
  lp_locked:     'LP Locked',
};

/** Default weight set for a brand-new profile. */
export const DEFAULT_WEIGHTS: Array<{ signal: string; weight: number }> = [
  { signal: 'hev',          weight:  15 },
  { signal: 'vol_mc',       weight:  12 },
  { signal: 'mc',           weight:   8 },
  { signal: 'pair_age',     weight:   6 },
  { signal: 'buy_ratio',    weight:   6 },
  { signal: 'liquidity',    weight:   5 },
  { signal: 'np',           weight:   4 },
  { signal: 'buy_pressure', weight:  -3 }, // penalty
  { signal: 'sell_pressure',weight: -15 }, // penalty (also hard-blocked)
];
