/**
 * Alpha API — Drizzle table definitions.
 *
 * Only tables accessed via the drizzle ORM are defined here.
 * Trader, elite-filter, and simulation tables are created via raw SQL
 * in migrate.ts and accessed through the raw `sqlite` instance.
 */

import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";

// ── Settings ──────────────────────────────────────────────────────────────────

export const settingsTable = sqliteTable("settings", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Setting    = typeof settingsTable.$inferSelect;
export type NewSetting = typeof settingsTable.$inferInsert;

// ── App Settings ──────────────────────────────────────────────────────────────

export const appSettingsTable = sqliteTable("app_settings", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type AppSetting    = typeof appSettingsTable.$inferSelect;
export type NewAppSetting = typeof appSettingsTable.$inferInsert;

// ── Alert Flows ────────────────────────────────────────────────────────────────

export const alertFlowsTable = sqliteTable("alert_flows", {
  id:                 text("id").primaryKey(),
  enabled:            integer("enabled").notNull().default(1),
  minScore:           real("min_score").notNull().default(0),
  maxScore:           real("max_score"),
  maxAgeHours:        real("max_age_hours"),
  priority:           integer("priority").notNull().default(0),
  fallback:           integer("fallback").notNull().default(0),
  telegramBotToken:   text("telegram_bot_token"),
  telegramChatId:     text("telegram_chat_id"),
  messageTemplate:    text("message_template"),
  liveTrading:        integer("live_trading_enabled").notNull().default(0),
  tradeSizeUsd:       real("trade_size_usd").notNull().default(0),
  maxOpenPositions:   integer("max_open_positions").notNull().default(1),
  slippagePct:        real("slippage_pct").notNull().default(5.0),
  filterProfileId:    text("filter_profile_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type AlertFlow    = typeof alertFlowsTable.$inferSelect;
export type NewAlertFlow = typeof alertFlowsTable.$inferInsert;
