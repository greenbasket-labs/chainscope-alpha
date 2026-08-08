/**
 * Alpha API — Database singleton.
 *
 * Exports:
 *   sqlite  — raw better-sqlite3 instance (used by trader/eliteFilter modules)
 *   db      — drizzle ORM instance (used by settings/service.ts)
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema.js";

const DATA_DIR = process.env.DATA_ROOT ?? join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "alpha.db");

export const sqlite: import("better-sqlite3").Database = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
