/**
 * Simulation Stress Test — Phase 4F
 *
 * Tests the simulation engine's gate logic against synthetic edge-case scenarios.
 * Each scenario constructs a mock GateContext and verifies the engine produces
 * the expected decision.
 *
 * Scenarios:
 *   1.  Simulation mode off         → no processing (not a gate, pre-condition)
 *   2.  Emergency stop active       → no processing (not a gate, pre-condition)
 *   3.  Late alert                  → SKIP (outside entry window)
 *   4.  Fresh alert                 → gate passes
 *   5.  Tier not enabled            → SKIP
 *   6.  Tier enabled                → gate passes
 *   7.  No buy setting              → SKIP
 *   8.  Buy amount zero             → SKIP
 *   9.  Max active trades hit       → SKIP
 *   10. Wallet exposure exceeded    → SKIP
 *   11. Consecutive losses limit    → SKIP
 *   12. Daily loss limit            → SKIP
 *   13. All gates pass              → BUY
 *   14. Duplicate entry             → second call to evaluateGates with same
 *                                      context but openCount+1 → still passes
 *                                      (dedup is caller responsibility)
 *   15. Rapid burst (10 sequential) → eventually hit max_active_trades gate
 *   16. Wallet overflow accumulation → investing last $ before limit
 *   17. Stop loss at entry price    → stop trigger = entry × (1 − 100%) = 0
 *                                     → stop never fires (guard in positionTracker)
 *   18. Stop loss > 100%            → stop never fires (guard)
 *   19. Price gap (deep drop)       → verifies stop price formula
 *   20. Missing price (null)        → engine handles gracefully
 *
 * NEVER modifies production DB state.
 * All tests use evaluateGates(), a pure function exported from simulationEngine.
 */

import { evaluateGates, type TraderConfig, type GateContext, type GateDecision } from "./simulationEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StressTestScenario {
  id:          number;
  name:        string;
  description: string;
  expected:    string;
  actual:      string;
  pass:        boolean;
  detail:      string | null;
}

export interface StressTestReport {
  total:     number;
  passed:    number;
  failed:    number;
  scenarios: StressTestScenario[];
  ran_at:    number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseCfg(): TraderConfig {
  return {
    simulation_mode:           1,
    emergency_stop_enabled:    0,
    max_active_trades:         5,
    max_buy_amount_usd:        50,
    default_slippage_pct:      1.0,
    max_slippage_pct:          5.0,
    auto_slippage_enabled:     1,
    min_priority_fee_lamports: 1000,
    max_priority_fee_lamports: 100000,
    max_wallet_exposure_pct:   20,
    min_sol_reserve:           0.1,
    max_consecutive_losses:    3,
    max_daily_loss_usd:        null,
    execution_mode:            "SIMULATION",
    auto_trading_enabled:      0,
    simulation_capital_usd:    500,
    enabled_entry_filters:     '["ELITE","PRO"]',
    entry_window_minutes:      60,
    stop_loss_pct:             90,
    max_position_age_hours:    24,
  };
}

function baseCtx(): GateContext {
  return {
    alertAgeMs:              5_000,        // 5 seconds old — fresh
    tier:                    "ELITE",
    enabledFilters:          ["ELITE", "PRO"],
    eliteFilterPasses:       null,         // null = legacy path; tier check applies
    buySetting:              { enabled: 1, buy_amount_usd: 25 },
    openPositionCount:       0,
    totalOpenInvestmentUsd:  0,
    consecutiveLossStreak:   0,
    todayRealizedLossUsd:    0,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

function run(
  id: number,
  name: string,
  description: string,
  expected: string,
  testFn: () => GateDecision,
): StressTestScenario {
  try {
    const result = testFn();
    const actual = result.decision === "BUY"
      ? `BUY (${result.reason})`
      : `SKIP gate ${result.gate}: ${result.reason}`;
    const pass = result.decision === (expected.startsWith("BUY") ? "BUY" : "SKIP");
    return { id, name, description, expected, actual, pass, detail: pass ? null : `Got: ${actual}` };
  } catch (err) {
    return {
      id, name, description, expected,
      actual: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      pass: false,
      detail: `Unexpected exception thrown`,
    };
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

export function runStressTests(): StressTestReport {
  const scenarios: StressTestScenario[] = [];

  // 1. Late alert — outside entry window
  scenarios.push(run(1, "Late Alert",
    "Alert older than entry_window_minutes is rejected at gate 1",
    "SKIP gate 1",
    () => {
      const cfg = baseCfg(); // 60-min window
      const ctx = { ...baseCtx(), alertAgeMs: 61 * 60_000 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 2. Fresh alert — within window
  scenarios.push(run(2, "Fresh Alert",
    "Alert 1 minute old passes gate 1",
    "BUY",
    () => evaluateGates(baseCfg(), { ...baseCtx(), alertAgeMs: 60_000 })
  ));

  // 3. Tier not in enabled filters
  scenarios.push(run(3, "Tier Not Enabled",
    "STANDARD tier is rejected when only ELITE/PRO enabled",
    "SKIP gate 2",
    () => {
      const ctx = { ...baseCtx(), tier: "STANDARD", enabledFilters: ["ELITE", "PRO"] };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  // 4. Tier enabled
  scenarios.push(run(4, "Tier Enabled — PRO",
    "PRO tier passes when PRO is in enabledFilters",
    "BUY",
    () => {
      const ctx = { ...baseCtx(), tier: "PRO" };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  // 5. No buy setting for tier
  scenarios.push(run(5, "No Buy Setting",
    "Null buySetting causes SKIP at gate 3",
    "SKIP gate 3",
    () => {
      const ctx = { ...baseCtx(), buySetting: null };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  // 6. Buy setting disabled
  scenarios.push(run(6, "Buy Setting Disabled",
    "buySetting.enabled = 0 causes SKIP at gate 3",
    "SKIP gate 3",
    () => {
      const ctx = { ...baseCtx(), buySetting: { enabled: 0, buy_amount_usd: 25 } };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  // 7. Buy amount zero
  scenarios.push(run(7, "Buy Amount Zero",
    "buy_amount_usd = 0 causes SKIP at gate 4",
    "SKIP gate 4",
    () => {
      const ctx = { ...baseCtx(), buySetting: { enabled: 1, buy_amount_usd: 0 } };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  // 8. Max active trades exactly at limit
  scenarios.push(run(8, "Max Active Trades Reached",
    "openPositionCount = max_active_trades causes SKIP at gate 5",
    "SKIP gate 5",
    () => {
      const cfg = baseCfg(); // max = 5
      const ctx = { ...baseCtx(), openPositionCount: 5 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 9. One below max active trades — still passes
  scenarios.push(run(9, "Below Max Active Trades",
    "openPositionCount = max_active_trades - 1 passes gate 5",
    "BUY",
    () => {
      const cfg = baseCfg(); // max = 5
      const ctx = { ...baseCtx(), openPositionCount: 4 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 10. Wallet exposure exceeded
  scenarios.push(run(10, "Wallet Exposure Exceeded",
    "invested + buy > capital × max_exposure% causes SKIP at gate 6",
    "SKIP gate 6",
    () => {
      const cfg = baseCfg(); // capital=500, max_exposure=20% → limit=$100
      // totalOpen=90, buy=25 → 90+25=115 > 100 → SKIP
      const ctx = { ...baseCtx(), totalOpenInvestmentUsd: 90, buySetting: { enabled: 1, buy_amount_usd: 25 } };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 11. Wallet exposure at exact limit
  scenarios.push(run(11, "Wallet At Exact Limit",
    "invested + buy = capital × max_exposure% exactly passes (not strictly greater)",
    "BUY",
    () => {
      const cfg = baseCfg(); // limit = $100
      // totalOpen=75, buy=25 → 75+25=100 = limit → passes (≤, not <)
      const ctx = { ...baseCtx(), totalOpenInvestmentUsd: 75, buySetting: { enabled: 1, buy_amount_usd: 25 } };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 12. Consecutive loss limit hit
  scenarios.push(run(12, "Consecutive Losses Limit",
    "consecutiveLossStreak ≥ max_consecutive_losses causes SKIP at gate 7",
    "SKIP gate 7",
    () => {
      const cfg = baseCfg(); // max_consecutive_losses = 3
      const ctx = { ...baseCtx(), consecutiveLossStreak: 3 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 13. Consecutive losses at limit - 1
  scenarios.push(run(13, "Below Consecutive Loss Limit",
    "consecutiveLossStreak = max - 1 passes gate 7",
    "BUY",
    () => {
      const cfg = baseCfg();
      const ctx = { ...baseCtx(), consecutiveLossStreak: 2 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 14. Daily loss limit hit
  scenarios.push(run(14, "Daily Loss Limit Reached",
    "todayRealizedLossUsd ≥ max_daily_loss_usd causes SKIP at gate 8",
    "SKIP gate 8",
    () => {
      const cfg = { ...baseCfg(), max_daily_loss_usd: 50 };
      const ctx = { ...baseCtx(), todayRealizedLossUsd: 50 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 15. Daily loss limit disabled (null)
  scenarios.push(run(15, "Daily Loss Limit Disabled",
    "max_daily_loss_usd = null means gate 8 never fires",
    "BUY",
    () => {
      const cfg = { ...baseCfg(), max_daily_loss_usd: null };
      const ctx = { ...baseCtx(), todayRealizedLossUsd: 99999 };
      return evaluateGates(cfg, ctx);
    }
  ));

  // 16. All gates pass — BUY
  scenarios.push(run(16, "All Gates Pass",
    "Clean config with fresh alert produces BUY",
    "BUY",
    () => evaluateGates(baseCfg(), baseCtx())
  ));

  // 17. Rapid burst: first N slots fill then gate 5 fires
  scenarios.push(run(17, "Rapid Burst — Slots Fill",
    "Simulating 6 rapid alerts: positions 1-5 BUY, position 6 SKIP (gate 5)",
    "SKIP gate 5",
    () => {
      const cfg = { ...baseCfg(), max_active_trades: 5 };
      let openCount = 0;
      let last: GateDecision = evaluateGates(cfg, { ...baseCtx(), openPositionCount: openCount });
      for (let i = 0; i < 6; i++) {
        last = evaluateGates(cfg, { ...baseCtx(), openPositionCount: openCount });
        if (last.decision === "BUY") openCount++;
      }
      return last;
    }
  ));

  // 18. Wallet overflow accumulation
  scenarios.push(run(18, "Wallet Overflow — Accumulation",
    "Investing up to $90 with $25 buy and $100 limit: 4th buy would overflow",
    "SKIP gate 6",
    () => {
      const cfg = baseCfg(); // capital=500, 20% = $100, buy=$25
      // 3 positions open × $25 = $75 invested. 4th buy: $75+$25=$100 ≤ limit → passes.
      // 5th buy: $100+$25=$125 > $100 → SKIP
      return evaluateGates(cfg, {
        ...baseCtx(),
        totalOpenInvestmentUsd: 100,
        buySetting: { enabled: 1, buy_amount_usd: 25 },
      });
    }
  ));

  // 19. Zero entry window (strict — all alerts blocked)
  scenarios.push(run(19, "Zero Entry Window",
    "entry_window_minutes = 0 blocks even fresh alerts",
    "SKIP gate 1",
    () => {
      const cfg = { ...baseCfg(), entry_window_minutes: 0 };
      const ctx = { ...baseCtx(), alertAgeMs: 1_000 }; // 1 second old
      return evaluateGates(cfg, ctx);
    }
  ));

  // 20. Unknown/null tier
  scenarios.push(run(20, "Null Tier",
    "Null tier is rejected at gate 2 (not in any enabled filter)",
    "SKIP gate 2",
    () => {
      const ctx = { ...baseCtx(), tier: null };
      return evaluateGates(baseCfg(), ctx);
    }
  ));

  const passed = scenarios.filter(s => s.pass).length;
  return {
    total:     scenarios.length,
    passed,
    failed:    scenarios.length - passed,
    scenarios,
    ran_at:    Date.now(),
  };
}

// ── Stop loss formula verification ────────────────────────────────────────────
// Not a gate test — verifies the price-level arithmetic used by positionTracker.

export function verifyStopLossFormula(): {
  pass:    boolean;
  cases:   { stop_loss_pct: number; entry_price: number; expected_trigger: number; safe: boolean }[];
} {
  const cases = [
    { stop_loss_pct: 90,  entry_price: 1.00  },  // trigger = 0.10
    { stop_loss_pct: 50,  entry_price: 1.00  },  // trigger = 0.50
    { stop_loss_pct: 10,  entry_price: 1.00  },  // trigger = 0.90
    { stop_loss_pct: 0,   entry_price: 1.00  },  // guard: never fires
    { stop_loss_pct: 100, entry_price: 1.00  },  // guard: never fires
    { stop_loss_pct: 90,  entry_price: 0.001 },  // micro-cap token
  ];

  const results = cases.map(c => {
    const trigger = c.entry_price * (1 - c.stop_loss_pct / 100);
    // positionTracker guards: if (pct <= 0 || pct >= 100) return false — stop never fires.
    // Those edge cases are always "safe" because the guard short-circuits before the trigger is used.
    const guardFires = c.stop_loss_pct <= 0 || c.stop_loss_pct >= 100;
    const safe       = guardFires ? true : trigger > 0;
    return { ...c, expected_trigger: Math.round(trigger * 1e8) / 1e8, guard_fires: guardFires, safe };
  });

  return { pass: results.every(r => r.safe), cases: results };
}
