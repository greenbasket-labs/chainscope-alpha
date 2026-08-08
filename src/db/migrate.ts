/**
 * Alpha API — Schema migration.
 *
 * Creates all tables on first boot (idempotent — uses IF NOT EXISTS).
 * No migration versioning needed; Alpha DB starts fresh each environment.
 * Called once from src/index.ts before the server starts.
 */

import { sqlite } from "./index.js";
import { logger } from "../lib/logger.js";

export function runMigration(): void {
  logger.info("Running Alpha DB schema migration…");

  sqlite.exec(`
    -- ── Settings ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ── App Settings (Telegram config etc.) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ── Alert Flows ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS alert_flows (
      id                    TEXT    PRIMARY KEY,
      enabled               INTEGER NOT NULL DEFAULT 1,
      min_score             REAL    NOT NULL DEFAULT 0,
      max_score             REAL,
      max_age_hours         REAL,
      priority              INTEGER NOT NULL DEFAULT 0,
      fallback              INTEGER NOT NULL DEFAULT 0,
      telegram_bot_token    TEXT,
      telegram_chat_id      TEXT,
      message_template      TEXT,
      live_trading_enabled  INTEGER NOT NULL DEFAULT 0,
      trade_size_usd        REAL    NOT NULL DEFAULT 0,
      max_open_positions    INTEGER NOT NULL DEFAULT 1,
      slippage_pct          REAL    NOT NULL DEFAULT 5.0,
      filter_profile_id     TEXT,
      updated_at            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- ── Alpha Candidates (fresh-token discovery feed) ─────────────────────────
    CREATE TABLE IF NOT EXISTS alpha_candidates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address    TEXT    NOT NULL UNIQUE,
      token_name       TEXT,
      symbol           TEXT,
      icon_url         TEXT,
      pair_url         TEXT,
      market_cap       REAL,
      fdv              REAL,
      liquidity        REAL,
      price_usd        REAL,
      volume_24h       REAL,
      volume_1h        REAL,
      volume_5m        REAL,
      pair_created_at  INTEGER,
      pair_age_minutes REAL,
      buy_ratio        REAL,
      has_hev          INTEGER NOT NULL DEFAULT 0,
      has_bp           INTEGER NOT NULL DEFAULT 0,
      has_sp           INTEGER NOT NULL DEFAULT 0,
      has_np           INTEGER NOT NULL DEFAULT 0,
      boosts           INTEGER,
      source           TEXT,
      elite_score      REAL,
      elite_passes     INTEGER,
      elite_result_json TEXT,
      filter_status    TEXT,
      filter_profile_id TEXT,
      discovered_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      polled_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_alpha_candidates_polled
      ON alpha_candidates(polled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alpha_candidates_status
      ON alpha_candidates(filter_status);

    -- ── Elite Filter ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS elite_filter_profiles (
      id                         TEXT PRIMARY KEY,
      name                       TEXT NOT NULL,
      description                TEXT,
      is_active                  INTEGER NOT NULL DEFAULT 0,
      mc_min                     REAL,
      mc_max                     REAL,
      pair_age_min               REAL,
      pair_age_max               REAL,
      vol_mc_min                 REAL,
      vol_mc_max                 REAL,
      buy_ratio_min              REAL,
      buy_ratio_max              REAL,
      liq_min                    REAL,
      liq_max                    REAL,
      require_hev                INTEGER NOT NULL DEFAULT 1,
      block_buy_pressure         INTEGER NOT NULL DEFAULT 0,
      block_sell_pressure        INTEGER NOT NULL DEFAULT 1,
      require_new_pair           INTEGER NOT NULL DEFAULT 0,
      require_holder_growth      INTEGER NOT NULL DEFAULT 0,
      require_dev_safe           INTEGER NOT NULL DEFAULT 0,
      require_lp_locked          INTEGER NOT NULL DEFAULT 0,
      require_liquidity_present  INTEGER NOT NULL DEFAULT 0,
      minimum_score              REAL    NOT NULL DEFAULT 0.0,
      minimum_similarity         REAL    NOT NULL DEFAULT 0.0,
      minimum_confidence         REAL    NOT NULL DEFAULT 0.0,
      version                    TEXT,
      notes                      TEXT,
      max_active_trades          INTEGER,
      max_buy_usd                REAL,
      stop_loss_pct              REAL,
      max_position_age_hours     REAL,
      entry_window_minutes       INTEGER,
      max_wallet_exposure_pct    REAL,
      time_exit_enabled          INTEGER NOT NULL DEFAULT 0,
      time_exit_max_hold_minutes INTEGER,
      time_exit_sell_percent     REAL,
      liquidity_exit_enabled         INTEGER NOT NULL DEFAULT 0,
      liquidity_exit_drop_pct        REAL,
      liquidity_exit_sell_percent    REAL,
      dev_sell_enabled           INTEGER NOT NULL DEFAULT 0,
      dev_sell_trigger_pct       REAL,
      dev_sell_sell_pct          REAL,
      created_at                 INTEGER NOT NULL,
      updated_at                 INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_efp_active
      ON elite_filter_profiles(is_active) WHERE is_active = 1;

    CREATE TABLE IF NOT EXISTS elite_filter_weights (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT    NOT NULL REFERENCES elite_filter_profiles(id) ON DELETE CASCADE,
      signal     TEXT    NOT NULL,
      weight     REAL    NOT NULL DEFAULT 1.0,
      enabled    INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, signal)
    );

    CREATE INDEX IF NOT EXISTS idx_efw_profile ON elite_filter_weights(profile_id);

    CREATE TABLE IF NOT EXISTS elite_filter_gold_tokens (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id       TEXT    NOT NULL REFERENCES elite_filter_profiles(id) ON DELETE CASCADE,
      contract_address TEXT    NOT NULL,
      token_name       TEXT,
      mc               REAL,
      vol_mc           REAL,
      pair_age_minutes REAL,
      buy_ratio        REAL,
      liquidity        REAL,
      has_hev          INTEGER NOT NULL DEFAULT 0,
      has_bp           INTEGER NOT NULL DEFAULT 0,
      has_sp           INTEGER NOT NULL DEFAULT 0,
      has_np           INTEGER NOT NULL DEFAULT 0,
      ath_x            REAL,
      added_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_efgt_profile ON elite_filter_gold_tokens(profile_id);

    CREATE TABLE IF NOT EXISTS elite_filter_loser_tokens (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id       TEXT    NOT NULL REFERENCES elite_filter_profiles(id) ON DELETE CASCADE,
      contract_address TEXT    NOT NULL,
      token_name       TEXT,
      mc               REAL,
      vol_mc           REAL,
      pair_age_minutes REAL,
      buy_ratio        REAL,
      liquidity        REAL,
      has_hev          INTEGER NOT NULL DEFAULT 0,
      has_bp           INTEGER NOT NULL DEFAULT 0,
      has_sp           INTEGER NOT NULL DEFAULT 0,
      has_np           INTEGER NOT NULL DEFAULT 0,
      ath_x            REAL,
      added_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eflt_profile ON elite_filter_loser_tokens(profile_id);

    CREATE TABLE IF NOT EXISTS profile_tp_ladder (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  TEXT    NOT NULL REFERENCES elite_filter_profiles(id) ON DELETE CASCADE,
      multiplier  REAL    NOT NULL,
      sell_pct    REAL    NOT NULL DEFAULT 0,
      is_moon_bag INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(profile_id, multiplier)
    );

    CREATE INDEX IF NOT EXISTS idx_ptl_profile ON profile_tp_ladder(profile_id);

    -- ── Trader Config & Wallet ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trader_config (
      id                          INTEGER PRIMARY KEY DEFAULT 1,
      auto_trading_enabled        INTEGER NOT NULL DEFAULT 0,
      max_active_trades           INTEGER NOT NULL DEFAULT 10,
      default_slippage_pct        REAL    NOT NULL DEFAULT 1.0,
      max_slippage_pct            REAL    NOT NULL DEFAULT 5.0,
      auto_slippage_enabled       INTEGER NOT NULL DEFAULT 1,
      min_priority_fee_lamports   INTEGER NOT NULL DEFAULT 1000,
      max_priority_fee_lamports   INTEGER NOT NULL DEFAULT 100000,
      auto_priority_fee_enabled   INTEGER NOT NULL DEFAULT 1,
      max_wallet_exposure_pct     REAL    NOT NULL DEFAULT 20.0,
      min_sol_reserve             REAL    NOT NULL DEFAULT 0.1,
      max_buy_amount_usd          REAL    NOT NULL DEFAULT 100.0,
      emergency_stop_enabled      INTEGER NOT NULL DEFAULT 0,
      max_consecutive_losses      INTEGER NOT NULL DEFAULT 5,
      max_daily_loss_usd          REAL,
      enabled_entry_filters       TEXT    NOT NULL DEFAULT '["ELITE"]',
      simulation_mode             INTEGER NOT NULL DEFAULT 0,
      simulation_capital_usd      REAL    NOT NULL DEFAULT 500.0,
      entry_window_minutes        INTEGER NOT NULL DEFAULT 60,
      stop_loss_pct               REAL    NOT NULL DEFAULT 90,
      max_position_age_hours      REAL    NOT NULL DEFAULT 24,
      execution_mode              TEXT    NOT NULL DEFAULT 'OFF',
      live_mode_enabled_at        INTEGER,
      watch_for_upgrade_live_trading INTEGER NOT NULL DEFAULT 0,
      created_at                  INTEGER NOT NULL,
      updated_at                  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_wallet (
      id                    INTEGER PRIMARY KEY DEFAULT 1,
      wallet_address        TEXT,
      encrypted_private_key TEXT,
      encryption_iv         TEXT,
      encryption_tag        TEXT,
      rpc_endpoint          TEXT    NOT NULL DEFAULT 'https://api.mainnet-beta.solana.com',
      jito_rpc              TEXT,
      mev_protection        INTEGER NOT NULL DEFAULT 0,
      connected             INTEGER NOT NULL DEFAULT 0,
      connected_at          INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_buy_settings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tier           TEXT    NOT NULL UNIQUE,
      enabled        INTEGER NOT NULL DEFAULT 0,
      buy_amount_usd REAL    NOT NULL DEFAULT 10.0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_sell_strategy (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      multiplier  REAL    NOT NULL,
      sell_pct    REAL    NOT NULL,
      is_moon_bag INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- ── Live Trades ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trader_trades (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address           TEXT    NOT NULL,
      token_name              TEXT,
      token_symbol            TEXT,
      alert_id                INTEGER,
      alert_tier              TEXT,
      status                  TEXT    NOT NULL DEFAULT 'WAITING',
      entry_price_usd         REAL,
      entry_amount_usd        REAL,
      entry_amount_sol        REAL,
      entry_tx_hash           TEXT,
      bought_at               INTEGER,
      exit_price_usd          REAL,
      exit_amount_usd         REAL,
      exit_tx_hash            TEXT,
      sold_at                 INTEGER,
      current_price_usd       REAL,
      profit_usd              REAL,
      profit_pct              REAL,
      reason_closed           TEXT,
      tokens_purchased        REAL,
      tokens_remaining        REAL,
      token_decimals          INTEGER NOT NULL DEFAULT 6,
      sol_price_at_entry      REAL,
      peak_price_usd          REAL,
      min_price_usd           REAL,
      milestones_hit          TEXT    NOT NULL DEFAULT '[]',
      jito_bundle_id          TEXT,
      confirmation_retries    INTEGER NOT NULL DEFAULT 0,
      last_error              TEXT,
      slippage_pct            REAL,
      priority_fee_lamports   INTEGER,
      entry_liquidity_usd     REAL,
      filter_profile_id       TEXT,
      private_label           TEXT,
      creator_address         TEXT,
      creator_tokens_at_entry REAL,
      total_supply_at_entry   REAL,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trader_trades_status  ON trader_trades(status);
    CREATE INDEX IF NOT EXISTS idx_trader_trades_created ON trader_trades(created_at DESC);

    -- ── Simulation ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trader_simulation_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address         TEXT    NOT NULL,
      token_name            TEXT,
      token_symbol          TEXT,
      alert_level           TEXT,
      decision              TEXT    NOT NULL,
      decision_reason       TEXT,
      buy_amount_usd        REAL,
      slippage_pct          REAL,
      priority_fee_lamports INTEGER,
      expected_cost_usd     REAL,
      expected_tokens       REAL,
      result                TEXT,
      result_reason         TEXT,
      is_simulation         INTEGER NOT NULL DEFAULT 1,
      alert_id              INTEGER,
      entry_price_usd       REAL,
      alert_tier            TEXT,
      status                TEXT    NOT NULL DEFAULT 'OPEN',
      created_at            INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sim_log_created ON trader_simulation_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS trader_sim_positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sim_log_id          INTEGER NOT NULL REFERENCES trader_simulation_log(id),
      alert_id            INTEGER,
      token_address       TEXT    NOT NULL,
      token_symbol        TEXT,
      token_name          TEXT,
      alert_tier          TEXT,
      entry_price_usd     REAL    NOT NULL,
      buy_amount_usd      REAL    NOT NULL,
      tokens_purchased    REAL    NOT NULL,
      tokens_remaining    REAL    NOT NULL,
      cost_basis_usd      REAL    NOT NULL,
      realized_profit_usd REAL    NOT NULL DEFAULT 0,
      unrealized_pnl_usd  REAL,
      peak_price_usd      REAL,
      last_price_usd      REAL,
      roi_pct             REAL,
      status              TEXT    NOT NULL DEFAULT 'OPEN',
      milestones_hit      TEXT    NOT NULL DEFAULT '[]',
      opened_at           INTEGER NOT NULL,
      closed_at           INTEGER,
      last_updated_at     INTEGER NOT NULL,
      evidence_score      REAL,
      market_cap_usd      REAL,
      liquidity_usd       REAL,
      min_price_usd       REAL,
      filter_profile_id   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sim_pos_status ON trader_sim_positions(status);
    CREATE INDEX IF NOT EXISTS idx_sim_pos_token  ON trader_sim_positions(token_address, status);

    CREATE TABLE IF NOT EXISTS trader_sim_exits (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id    INTEGER NOT NULL REFERENCES trader_sim_positions(id),
      milestone_x    REAL    NOT NULL,
      exit_price_usd REAL    NOT NULL,
      tokens_sold    REAL    NOT NULL,
      proceeds_usd   REAL    NOT NULL,
      cost_basis_usd REAL    NOT NULL,
      profit_usd     REAL    NOT NULL,
      is_moon_bag    INTEGER NOT NULL DEFAULT 0,
      executed_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sim_exits_position ON trader_sim_exits(position_id);

    CREATE TABLE IF NOT EXISTS trader_sim_price_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id    INTEGER NOT NULL REFERENCES trader_sim_positions(id),
      price_usd      REAL    NOT NULL,
      market_cap_usd REAL,
      observed_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sim_price_hist_position
      ON trader_sim_price_history(position_id, observed_at ASC);
  `);

  logger.info("Alpha DB schema migration complete");
}
