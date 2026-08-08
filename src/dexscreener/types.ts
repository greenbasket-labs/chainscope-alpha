/**
 * DexScreener Poller — Types
 *
 * Raw API response shapes and the normalized AlphaCandidate record
 * that gets written to alpha_candidates and published to alertBus.
 */

// ── Raw DexScreener API shapes ────────────────────────────────────────────────

export interface DexProfile {
  url?:          string;
  chainId?:      string;
  tokenAddress?: string;
  icon?:         string;
  header?:       string;
  description?:  string;
  links?:        Array<{ type?: string; label?: string; url?: string }>;
}

export interface DexBoost {
  url?:          string;
  chainId?:      string;
  tokenAddress?: string;
  icon?:         string;
  totalAmount?:  number;
  amount?:       number;
}

export interface DexPairInfo {
  chainId?:       string;
  dexId?:         string;
  url?:           string;
  pairAddress?:   string;
  baseToken?: {
    address?: string;
    name?:    string;
    symbol?:  string;
  };
  quoteToken?: {
    address?: string;
    symbol?:  string;
  };
  priceUsd?:    string;
  fdv?:         number;
  liquidity?: { usd?: number };
  volume?: {
    h24?: number;
    h6?:  number;
    h1?:  number;
    m5?:  number;
  };
  txns?: {
    h24?: { buys?: number; sells?: number };
    h6?:  { buys?: number; sells?: number };
    h1?:  { buys?: number; sells?: number };
    m5?:  { buys?: number; sells?: number };
  };
  pairCreatedAt?: number; // unix ms
  boosts?: { active?: number };
}

export interface DexTokenResponse {
  pairs?: DexPairInfo[];
}

// ── Normalized candidate record (in-memory before DB write) ──────────────────

export interface AlphaCandidate {
  tokenAddress:   string;
  tokenName:      string | null;
  symbol:         string | null;
  iconUrl:        string | null;
  pairUrl:        string | null;
  marketCap:      number | null;
  fdv:            number | null;
  liquidity:      number | null;
  priceUsd:       number | null;
  volume24h:      number | null;
  volume1h:       number | null;
  volume5m:       number | null;
  pairCreatedAt:  number | null; // unix ms
  pairAgeMinutes: number | null;
  buyRatio:       number | null;  // buys / (buys + sells) from 24h data
  hasHev:         boolean;        // high early volume trigger
  hasBp:          boolean;        // buy pressure trigger
  hasSp:          boolean;        // sell pressure trigger
  hasNp:          boolean;        // new profile trigger
  boosts:         number | null;
  source:         string;         // e.g. "dex_latest_profiles"
}
