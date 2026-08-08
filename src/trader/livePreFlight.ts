/**
 * Live Execution Pre-Flight Safety Check
 *
 * Runs a battery of checks before LIVE mode is enabled.
 * Every check is independent — all run even if earlier ones fail.
 *
 * Checks (in order):
 *  1. wallet_configured      — wallet address + encrypted key present in DB
 *  2. key_integrity          — key decrypts without error + derives the stored address
 *  3. rpc_health             — configured RPC node returns a healthy response
 *  4. sol_balance            — wallet SOL ≥ min_sol_reserve + $5 buffer (minimum viable)
 *  5. jupiter_reachable      — Jupiter price API returns a valid SOL price
 *  6. jupiter_quote_dry_run  — Jupiter quote for $1 SOL → USDC succeeds
 *  7. tiers_enabled          — at least one buy tier is enabled with amount > 0
 *  8. emergency_stop         — emergency stop is NOT active
 *  9. mode_not_live          — execution_mode is not already LIVE (warn, not fail)
 *
 * overall: 'go' requires all checks to be 'pass' or 'warn'.
 *          Any 'fail' → overall = 'no_go'.
 *
 * Blocking: checks 1-8 are blocking (fail → no_go).
 *           Check 9 is advisory (warn only).
 */

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { derivePublicKey, type WalletRecord } from "./transactionPipeline.js";
import { getQuote, SOL_MINT, USDC_MINT, amountToAtoms } from "./jupiterClient.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface PreFlightCheck {
  id:      string;
  label:   string;
  status:  CheckStatus;
  detail:  string;
  value?:  string | number | null;  // raw measured value (balance, latency, etc.)
}

export interface PreFlightReport {
  overall:    "go" | "no_go";
  checks:     PreFlightCheck[];
  checked_at: number;
  /** Human-readable summary of what's blocking go-live, if any. */
  blocking:   string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SOL_DECIMALS       = 9;
const DRY_RUN_SOL_USD    = 1;          // $1 worth of SOL for quote dry-run
const SOL_BUFFER_USD     = 5;          // must have at least $5 above reserve
const FETCH_TIMEOUT_MS   = 10_000;

// price.jup.ag is deprecated — use CoinGecko for SOL price (no API key required)
const COINGECKO_SOL_URL  = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
// Jupiter moved from quote-api.jup.ag/v6 → lite-api.jup.ag/swap/v1 (free tier)
const JUPITER_QUOTE_TEST = "https://lite-api.jup.ag/swap/v1/quote" +
  "?inputMint=So11111111111111111111111111111111111111112" +
  "&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" +
  "&amount=1000000&slippageBps=100";

// ── Individual check runners ──────────────────────────────────────────────────

function checkWalletConfigured(): PreFlightCheck {
  const id    = "wallet_configured";
  const label = "Wallet Configured";
  const wallet = sqlite
    .prepare("SELECT wallet_address, encrypted_private_key FROM trader_wallet WHERE id = 1")
    .get() as { wallet_address: string | null; encrypted_private_key: string | null } | undefined;

  if (!wallet?.wallet_address || !wallet?.encrypted_private_key) {
    return {
      id, label, status: "fail",
      detail: "No wallet found. POST /trader/wallet to configure a wallet before enabling LIVE mode.",
    };
  }
  return {
    id, label, status: "pass",
    detail: `Wallet address: ${wallet.wallet_address}`,
    value:  wallet.wallet_address,
  };
}

function checkKeyIntegrity(): PreFlightCheck {
  const id    = "key_integrity";
  const label = "Key Decrypts and Matches Address";

  const wallet = sqlite
    .prepare("SELECT * FROM trader_wallet WHERE id = 1")
    .get() as WalletRecord | undefined;

  if (!wallet?.encrypted_private_key) {
    return { id, label, status: "skip", detail: "Skipped — no wallet key present (check wallet_configured first)." };
  }

  try {
    const derived = derivePublicKey(wallet);
    if (derived !== wallet.wallet_address) {
      return {
        id, label, status: "fail",
        detail: `Key mismatch. Stored: ${wallet.wallet_address} | Derived: ${derived}. Re-import the correct private key.`,
      };
    }
    return {
      id, label, status: "pass",
      detail: `Key decrypts cleanly. Derived address matches stored address (${derived.slice(0, 8)}…).`,
    };
  } catch (err) {
    return {
      id, label, status: "fail",
      detail: `Key decryption failed: ${err instanceof Error ? err.message : String(err)}. SESSION_SECRET may be wrong or key is corrupted.`,
    };
  }
}

async function checkRpcHealth(rpcEndpoint: string): Promise<PreFlightCheck> {
  const id    = "rpc_health";
  const label = "RPC Node Healthy";
  const start = Date.now();

  try {
    const res = await fetch(rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = await res.json() as { result?: string; error?: unknown };
    const latencyMs = Date.now() - start;
    if (json.result === "ok") {
      return {
        id, label, status: latencyMs > 3_000 ? "warn" : "pass",
        detail: latencyMs > 3_000
          ? `RPC is healthy but slow (${latencyMs}ms). Consider switching to a faster endpoint.`
          : `RPC healthy (${latencyMs}ms). Endpoint: ${rpcEndpoint}`,
        value: latencyMs,
      };
    }
    return {
      id, label, status: "fail",
      detail: `RPC returned non-ok status: ${JSON.stringify(json.error ?? json)}`,
    };
  } catch (err) {
    return {
      id, label, status: "fail",
      detail: `RPC unreachable: ${err instanceof Error ? err.message : String(err)}. Check rpc_endpoint in wallet config.`,
    };
  }
}

async function checkSolBalance(
  walletAddress: string,
  rpcEndpoint:   string,
  minReserve:    number,
  solPrice:      number | null,
): Promise<PreFlightCheck> {
  const id    = "sol_balance";
  const label = "Wallet SOL Balance";

  try {
    const res = await fetch(rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getBalance",
        params: [walletAddress, { commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = await res.json() as { result?: { value?: number } };
    const lamports = json.result?.value ?? 0;
    const solBal   = lamports / 1e9;

    if (!solPrice || solPrice <= 0) {
      // Can't compute USD value — check raw SOL
      const minSol = minReserve + 0.05; // 0.05 SOL ≈ $5 at $100/SOL (conservative fallback)
      if (solBal < minSol) {
        return {
          id, label, status: "fail",
          detail: `Wallet has ${solBal.toFixed(4)} SOL. Need at least ${minSol.toFixed(4)} SOL (reserve + buffer). Fund your wallet.`,
          value:  solBal,
        };
      }
      return {
        id, label, status: "warn",
        detail: `Balance: ${solBal.toFixed(4)} SOL (SOL price unavailable — USD check skipped).`,
        value:  solBal,
      };
    }

    const balUsd     = solBal * solPrice;
    const reserveUsd = minReserve * solPrice;
    const requiredUsd = reserveUsd + SOL_BUFFER_USD;

    if (balUsd < requiredUsd) {
      return {
        id, label, status: "fail",
        detail: `Insufficient balance: $${balUsd.toFixed(2)} (${solBal.toFixed(4)} SOL @ $${solPrice.toFixed(0)}/SOL). Need $${requiredUsd.toFixed(2)} (reserve $${reserveUsd.toFixed(2)} + $${SOL_BUFFER_USD} buffer).`,
        value:  solBal,
      };
    }
    return {
      id, label, status: "pass",
      detail: `$${balUsd.toFixed(2)} (${solBal.toFixed(4)} SOL @ $${solPrice.toFixed(0)}/SOL) — above the $${requiredUsd.toFixed(2)} minimum.`,
      value:  solBal,
    };
  } catch (err) {
    return {
      id, label, status: "fail",
      detail: `Balance check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function checkJupiterReachable(): Promise<{ check: PreFlightCheck; solPrice: number | null }> {
  const id    = "jupiter_reachable";
  const label = "Jupiter API Reachable";
  const start = Date.now();

  // Run Jupiter quote test + CoinGecko SOL price in parallel
  const [jupiterResult, coinGeckoPrice] = await Promise.all([
    // Test Jupiter quote API (lite-api.jup.ag/swap/v1) with a minimal $0.001 SOL → USDC
    (async (): Promise<{ ok: boolean; error: string | null }> => {
      try {
        const res = await fetch(JUPITER_QUOTE_TEST, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
        }
        const json = await res.json() as { outAmount?: string };
        if (!json.outAmount) return { ok: false, error: "No outAmount in quote response" };
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })(),
    // SOL price from CoinGecko (price.jup.ag is deprecated)
    (async (): Promise<number | null> => {
      try {
        const res  = await fetch(COINGECKO_SOL_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const json = await res.json() as { solana?: { usd?: number } };
        return json.solana?.usd ?? null;
      } catch {
        return null;
      }
    })(),
  ]);

  const latencyMs = Date.now() - start;

  if (!jupiterResult.ok) {
    return {
      check: {
        id, label, status: "fail",
        detail: `Jupiter unreachable: ${jupiterResult.error}`,
      },
      solPrice: coinGeckoPrice,
    };
  }

  return {
    check: {
      id, label, status: latencyMs > 5_000 ? "warn" : "pass",
      detail: `Jupiter quote API OK (${latencyMs}ms). SOL: $${coinGeckoPrice?.toFixed(2) ?? "price unavailable"}`,
      value:  coinGeckoPrice ?? undefined,
    },
    solPrice: coinGeckoPrice,
  };
}

async function checkJupiterQuoteDryRun(solPrice: number | null): Promise<PreFlightCheck> {
  const id    = "jupiter_quote_dry_run";
  const label = "Jupiter Quote Dry-Run (SOL → USDC)";

  if (!solPrice || solPrice <= 0) {
    return {
      id, label, status: "skip",
      detail: "Skipped — SOL price unavailable (check jupiter_reachable first).",
    };
  }

  const start = Date.now();
  try {
    const solAmount = DRY_RUN_SOL_USD / solPrice;    // $1 worth of SOL
    const lamports  = amountToAtoms(solAmount, SOL_DECIMALS);

    const quote = await getQuote({
      inputMint:          SOL_MINT,
      outputMint:         USDC_MINT,
      amountLamports:     lamports,
      slippageBps:        100,      // 1%
      autoSlippage:       false,
      maxAutoSlippageBps: 500,
    });

    const latencyMs    = Date.now() - start;
    const usdcOut      = Number(quote.outAmount) / 1e6;
    const impactPct    = parseFloat(quote.priceImpactPct ?? "0");

    if (usdcOut <= 0) {
      return {
        id, label, status: "fail",
        detail: `Quote returned 0 USDC out. Jupiter routing may be misconfigured.`,
      };
    }

    return {
      id, label, status: "pass",
      detail: `$${DRY_RUN_SOL_USD} SOL → ${usdcOut.toFixed(4)} USDC in ${latencyMs}ms (impact: ${impactPct.toFixed(4)}%)`,
      value:  usdcOut,
    };
  } catch (err) {
    return {
      id, label, status: "fail",
      detail: `Quote dry-run failed: ${err instanceof Error ? err.message : String(err)}. Jupiter may be down or rate-limiting.`,
    };
  }
}

function checkTiersEnabled(): PreFlightCheck {
  const id    = "tiers_enabled";
  const label = "At Least One Buy Tier Enabled";

  const tiers = sqlite
    .prepare("SELECT tier, enabled, buy_amount_usd FROM trader_buy_settings WHERE enabled = 1 AND buy_amount_usd > 0")
    .all() as { tier: string; enabled: number; buy_amount_usd: number }[];

  if (!tiers.length) {
    return {
      id, label, status: "fail",
      detail: "No buy tiers are enabled with a positive amount. Enable at least one tier in My Auto Trader settings.",
    };
  }

  const summary = tiers.map((t) => `${t.tier} ($${t.buy_amount_usd})`).join(", ");
  return {
    id, label, status: "pass",
    detail: `${tiers.length} enabled: ${summary}`,
    value:  tiers.length,
  };
}

function checkEmergencyStop(): PreFlightCheck {
  const id    = "emergency_stop";
  const label = "Emergency Stop Not Active";

  const cfg = sqlite
    .prepare("SELECT emergency_stop_enabled FROM trader_config WHERE id = 1")
    .get() as { emergency_stop_enabled: number } | undefined;

  if (cfg?.emergency_stop_enabled) {
    return {
      id, label, status: "fail",
      detail: "Emergency stop is currently active. Disable it with PUT /trader/config { \"emergency_stop_enabled\": false } before enabling LIVE mode.",
    };
  }
  return {
    id, label, status: "pass",
    detail: "Emergency stop is off — engine can respond to alerts.",
  };
}

function checkModeNotAlreadyLive(): PreFlightCheck {
  const id    = "mode_not_live";
  const label = "Not Already in LIVE Mode";

  const cfg = sqlite
    .prepare("SELECT execution_mode, live_mode_enabled_at FROM trader_config WHERE id = 1")
    .get() as { execution_mode: string | null; live_mode_enabled_at: number | null } | undefined;

  if (cfg?.execution_mode === "LIVE") {
    const enabledAt = cfg.live_mode_enabled_at
      ? new Date(cfg.live_mode_enabled_at).toISOString()
      : "unknown";
    return {
      id, label, status: "warn",
      detail: `Already in LIVE mode (enabled ${enabledAt}). If you are re-running preflight as a health check, this is expected.`,
    };
  }
  return {
    id, label, status: "pass",
    detail: `Current mode: ${cfg?.execution_mode ?? "OFF"} — safe to enable LIVE.`,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run all pre-flight checks and return a structured report.
 * All checks execute even if earlier ones fail.
 * Never throws — errors are surfaced as 'fail' check status.
 */
export async function runPreFlight(): Promise<PreFlightReport> {
  const checks: PreFlightCheck[] = [];

  // ── Sync checks (fast, no I/O) ────────────────────────────────────────────
  const walletCheck = checkWalletConfigured();
  checks.push(walletCheck);

  checks.push(checkKeyIntegrity());
  checks.push(checkTiersEnabled());
  checks.push(checkEmergencyStop());
  checks.push(checkModeNotAlreadyLive());

  // ── Async checks (network I/O) — run in parallel ─────────────────────────
  const wallet = sqlite
    .prepare("SELECT wallet_address, rpc_endpoint FROM trader_wallet WHERE id = 1")
    .get() as { wallet_address: string | null; rpc_endpoint: string } | undefined;

  const cfg = sqlite
    .prepare("SELECT min_sol_reserve FROM trader_config WHERE id = 1")
    .get() as { min_sol_reserve: number } | undefined;

  const rpcEndpoint  = wallet?.rpc_endpoint ?? "https://api.mainnet-beta.solana.com";
  const walletAddr   = wallet?.wallet_address ?? "";
  const minReserve   = cfg?.min_sol_reserve ?? 0.1;

  const [rpcCheck, { check: jupiterCheck, solPrice }] = await Promise.all([
    checkRpcHealth(rpcEndpoint),
    checkJupiterReachable(),
  ]);
  checks.push(rpcCheck);
  checks.push(jupiterCheck);

  // Balance check and quote dry-run can now proceed with solPrice
  const [balCheck, quoteCheck] = await Promise.all([
    checkSolBalance(walletAddr, rpcEndpoint, minReserve, solPrice),
    checkJupiterQuoteDryRun(solPrice),
  ]);
  checks.push(balCheck);
  checks.push(quoteCheck);

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const blocking = checks
    .filter((c) => c.status === "fail")
    .map((c) => `[${c.id}] ${c.detail}`);

  const overall: "go" | "no_go" = blocking.length === 0 ? "go" : "no_go";

  logger.info(
    { overall, passCount: checks.filter((c) => c.status === "pass").length, failCount: blocking.length },
    "[preflight] check complete",
  );

  return { overall, checks, checked_at: Date.now(), blocking };
}
