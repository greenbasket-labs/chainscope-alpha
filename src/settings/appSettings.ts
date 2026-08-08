/**
 * App Settings Service
 *
 * Manages generic app-level config (Telegram bot tokens, chat IDs, etc.)
 * stored in the `app_settings` table. Mirror of alertCenter/appSettings in api-server.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appSettingsTable } from "../db/schema.js";

export function getAppSetting(key: string): string | null {
  const row = db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .get();
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  const existing = db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .get();

  const now = new Date();
  if (existing) {
    db.update(appSettingsTable)
      .set({ value, updatedAt: now })
      .where(eq(appSettingsTable.key, key))
      .run();
  } else {
    db.insert(appSettingsTable).values({ key, value, updatedAt: now }).run();
  }
}

export interface TelegramConfig {
  enabled:  boolean;
  botToken: string | null;
  chatId:   string | null;
}

export function getTelegramConfig(): TelegramConfig {
  return {
    enabled:  getAppSetting("telegram.enabled") === "true",
    botToken: getAppSetting("telegram.bot_token"),
    chatId:   getAppSetting("telegram.chat_id"),
  };
}
