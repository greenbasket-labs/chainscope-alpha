/**
 * Settings Service
 *
 * Key/value settings stored in the `settings` table.
 * Unset keys fall back to the defaults defined below.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settingsTable } from "../db/schema.js";

export type SettingKey =
  | "helius_api_key"
  | "rpc_url"
  | "theme";

export const SETTING_DEFAULTS: Record<SettingKey, string> = {
  helius_api_key: "",
  rpc_url:        "https://api.mainnet-beta.solana.com",
  theme:          "dark",
};

export function getSetting(key: SettingKey): string {
  const row = db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .get();
  return row?.value ?? SETTING_DEFAULTS[key as SettingKey] ?? "";
}

export function setSetting(key: SettingKey, value: string): void {
  const existing = db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .get();

  const now = new Date();
  if (existing) {
    db.update(settingsTable)
      .set({ value, updatedAt: now })
      .where(eq(settingsTable.key, key))
      .run();
  } else {
    db.insert(settingsTable).values({ key, value, updatedAt: now }).run();
  }
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(settingsTable).all();
  const result: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
