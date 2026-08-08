/**
 * Elite Filter — Seed
 *
 * Creates the initial filter profiles on first startup:
 *
 *   gold-v1  (ELITE) — 21 production winner tokens, aggressive entry gates.
 *   pro-v1   (PRO)   — 16 production winner tokens + 50 production loser tokens.
 *                       Data-backed gates derived from 714 PRO production records.
 *
 * Both profiles carry per-profile trading config (position sizing, risk) and
 * a per-profile TP ladder.  The simulation engine merges profile config over
 * the global trader_config so system-level switches remain global.
 *
 * Idempotent: skips individual steps when they have already been applied.
 */

import {
  getProfileById,
  createProfile,
  updateProfile,
  addGoldToken,
  getGoldTokensForProfile,
  addLoserToken,
  getLoserTokensForProfile,
  activateProfile,
  linkProfileToFlow,
  getTpLadderForProfile,
  replaceTpLadder,
} from "./db.js";
import { logger } from "../lib/logger.js";
import { sqlite } from "../db/index.js";

const ELITE_PROFILE_ID = "gold-v1";
const PRO_PROFILE_ID   = "pro-v1";

// ── ELITE Gold Dataset — 21 production winner tokens ─────────────────────────
// Source: manually curated ELITE winners, Aug 2026.

const GOLD_TOKENS = [
  { ca: "3xkAe2GTSVakU1yKPh1CxmYL1bfjHc5HqNjCGsBfpump", name: "AFAA",       mc: 16000,  vol_mc: 1.80, age: 49.3, buy_ratio: 0.57, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 1.19 },
  { ca: "2kcAFpgEmzsjNdKFLCs8a8rEv6UZUisBQzDXXG4Hpump", name: "KODY",       mc: 26000,  vol_mc: 8.92, age: 24.6, buy_ratio: 0.51, liq: 11000, hev: true,  bp: false, sp: false, np: true, ath: 4.37 },
  { ca: "Gyn99ta9UrKUr7QUgrb8ist6cvvmVTcyYVxrf7Yfyinu",  name: "Inu",        mc: 12000,  vol_mc: 1.17, age: 32.2, buy_ratio: 0.57, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 3.32 },
  { ca: "DnmdeUqUxyGKRd5WN4nfSZP3zbzG3giB6vaERD4apump", name: "eelonmusk",  mc: 60000,  vol_mc: 0.67, age: 4.1,  buy_ratio: 0.55, liq: 17000, hev: true,  bp: false, sp: false, np: true, ath: 2.66 },
  { ca: "8wQR89A1iWYuQWQqrDsCTfszmPj36HzPt51jQyZmpump", name: "SOLAURA",    mc: 113000, vol_mc: 2.39, age: 20.5, buy_ratio: 0.59, liq: 24000, hev: true,  bp: false, sp: false, np: true, ath: 1.95 },
  { ca: "7yyacjJh5ZSW3TaTEuH1if1b5JQcGtKGFmmVFRYjpump", name: "DINNER",     mc: 14000,  vol_mc: 3.11, age: 10.9, buy_ratio: 0.56, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 2.71 },
  { ca: "5ygitPxnWHExsGhw2VAWX1F422xgTW1CP6zkwke5pump", name: "CHUGGET",    mc: 10000,  vol_mc: 2.89, age: 6.3,  buy_ratio: 0.45, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 3.94 },
  { ca: "Aq2idw7BeJX2WfNek6jGnp1z2s79CpFYZXo2zCF1pump", name: "LARP",       mc: 58000,  vol_mc: 2.27, age: 23.4, buy_ratio: 0.55, liq: 16000, hev: true,  bp: false, sp: false, np: true, ath: 5.86 },
  { ca: "Go7QKqxZt26YeTP9jahZh8vcKySirxCjbKrt423hpump", name: "Thai",        mc: 18000,  vol_mc: 2.77, age: 17.3, buy_ratio: 0.57, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 3.77 },
  { ca: "7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump", name: "WIZCAT",     mc: 85000,  vol_mc: 1.42, age: 41.0, buy_ratio: 0.90, liq: null,  hev: true,  bp: true,  sp: false, np: true, ath: 2.74 },
  { ca: "82vsbiZ4fBFGhPrKgCvMPyrTsNWMhTNgzXWjP7QMpump", name: "Yurii",      mc: 14000,  vol_mc: 2.80, age: 7.0,  buy_ratio: 0.56, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 2.10 },
  { ca: "8N1yDFZUf71HnEovfiAACQ1e23Bdf9HSghuHmkPqpump", name: "Yolk",       mc: 6000,   vol_mc: 7.59, age: 9.0,  buy_ratio: null, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 3.69 },
  { ca: "9MWjBE9Qq3Ng1gTghrvbYaktppaGFHHfM2wZ9bedpump", name: "POTATO",     mc: 12000,  vol_mc: 2.66, age: 38.0, buy_ratio: 0.50, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 2.27 },
  { ca: "97yrevPUfFpunTAeK1KBynVhqgHf3ScXdws87aTJokyW",  name: "好的",      mc: 21000,  vol_mc: 6.17, age: 13.0, buy_ratio: null, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 3.11 },
  { ca: "FYPcU7HrfVUhWS1F4MsfvqFoUZa3U2cUnGduyUaTpump", name: "NEW-1",      mc: 6000,   vol_mc: 1.78, age: 6.0,  buy_ratio: null, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 2.76 },
  { ca: "4j6NavaLPbTJsqSurj1zaUsvfmN2nzvVmu7UNJiupump", name: "NEW-2",      mc: 8000,   vol_mc: 5.36, age: 11.0, buy_ratio: null, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 6.23 },
  { ca: "6pioT4Wv2WkJKaCXPH9B6JXXU4yEwm8whmwtZWDUpump", name: "NEW-3",      mc: 64000,  vol_mc: 3.59, age: 7.0,  buy_ratio: null, liq: 13000, hev: true,  bp: false, sp: false, np: true, ath: 3.99 },
  { ca: "6vmwncbtNQRLJRTZCKnwVDjG3jm9Qoxvi6cnHAfZpump", name: "NEW-4",      mc: 6000,   vol_mc: 7.76, age: 7.3,  buy_ratio: 0.54, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 2.04 },
  { ca: "HqkK61RnNop2P5MtS9K4K1uxYgYR7L21cmfz6Jhkpump", name: "NEW-5",      mc: 12000,  vol_mc: 1.37, age: 9.5,  buy_ratio: 0.59, liq: null,  hev: true,  bp: false, sp: false, np: true, ath: 1.19 },
  { ca: "5SjKqDsHT35k9nJPVpJ5fbrPHqooVWoDGpESniEvpump", name: "NEW-6",      mc: 37000,  vol_mc: 4.03, age: 9.1,  buy_ratio: 0.50, liq: 13000, hev: true,  bp: false, sp: false, np: true, ath: 4.03 },
  { ca: "3zyBhfJrMrXJrWG8n4LJdUnoASfgQrBZ2SjtzQeqpump", name: "NEW-7",      mc: 100000, vol_mc: 1.87, age: 9.5,  buy_ratio: 0.41, liq: 22000, hev: true,  bp: false, sp: false, np: true, ath: 1.41 },
] as const;

// ── ELITE TP ladder (gold-v1) ─────────────────────────────────────────────────
// 4-rung ladder: take 55% at 2x, 30% at 4x, 10% at 8x, moon-bag the rest.
const ELITE_TP_LADDER = [
  { multiplier: 2.0,  sell_pct: 55, is_moon_bag: 0, enabled: 1, sort_order: 1 },
  { multiplier: 4.0,  sell_pct: 30, is_moon_bag: 0, enabled: 1, sort_order: 2 },
  { multiplier: 8.0,  sell_pct: 10, is_moon_bag: 0, enabled: 1, sort_order: 3 },
  { multiplier: 16.0, sell_pct: 0,  is_moon_bag: 1, enabled: 1, sort_order: 4 },
];

// ── PRO Gold Dataset — 16 production winner tokens ────────────────────────────
// Source: alert_research_records JOIN alert_queue_telegram WHERE flow_id='PRO'
//         AND peak_x_multiple >= 2.0 ORDER BY peak_x_multiple DESC.
// Research basis: 714 PRO alerts, 412 with outcomes (August 2026).
// All 16 tokens have HEV + NEW_PROFILE; zero have buy/sell pressure.

const PRO_GOLD_TOKENS = [
  // peak_x ≥ 10x
  { ca: "8HykgZKXNpMhfxQtDPb7AayRKJonZaQ8Mw1Xo3xmpump", name: "The Sisypuss",    mc: 14177.00,  vm: 11.5076, age: 56.0, br: 0.5094, liq: 7436.02,  hev: true, bp: false, sp: false, np: true, ath: 28.80 },
  { ca: "HDgkikLfWm4CuFVXVrfja8cApnHyWgEcx4ULFEsNpump", name: "Shark Cat",        mc: 13465.00,  vm: 5.9197,  age: 48.0, br: 0.5837, liq: 7028.64,  hev: true, bp: false, sp: false, np: true, ath: 19.59 },
  { ca: "2tBjFsno9tdkX7AhZ9uehAet5o8GninkrqDYZZYUpump", name: null,               mc: 24399.00,  vm: 1.2596,  age: 5.0,  br: 0.5861, liq: 9967.91,  hev: true, bp: false, sp: false, np: true, ath: 12.19 },
  // peak_x 4x–10x
  { ca: "Ae46k6NjLryFHwd11D2Xt43ZyyA5BRZg4ijY4cFgDPz7", name: null,               mc: 20051.00,  vm: 2.4677,  age: 39.0, br: 0.5731, liq: 4413.23,  hev: true, bp: false, sp: false, np: true, ath: 5.12 },
  { ca: "F8ZZzngxuZ34mdE2M4ffgZDgsqZ5Faz7CWFB3sCGpump", name: null,               mc: 26964.00,  vm: 13.3317, age: 14.0, br: 0.4922, liq: 10859.87, hev: true, bp: false, sp: false, np: true, ath: 4.80 },
  // peak_x 3x–4x
  { ca: "7C17GMDWxy2wCggRXEKKeTY21B84mT9vv9c6b1vTpump", name: "No Brian",          mc: 14504.59,  vm: 2.5766,  age: 13.0, br: 0.5906, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 3.58 },
  { ca: "247PRAdaopwLD4aSW5GjJgLjRLTqWz3UE7n47v6Spump", name: null,               mc: 7461.68,   vm: 1.4749,  age: 8.0,  br: 0.5167, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 3.58 },
  { ca: "7JYJuHx17BdWM7Ui6zH4Dp6PMDCBezGt64yEVjXspump", name: null,               mc: 9094.95,   vm: 2.8425,  age: 8.0,  br: 0.5759, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 3.40 },
  { ca: "5M831RoaGRRtGQ8KvSRkhLKkbWmpJUGV7eZeGTJBpump", name: null,               mc: 6445.53,   vm: 2.8017,  age: 4.0,  br: 0.5312, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 3.31 },
  // peak_x 2x–3x
  { ca: "3c7uGViL2KZoFcuktqF8e9FZJpdS3595Ry2q4u5ypump", name: null,               mc: 37351.00,  vm: 10.7694, age: 35.0, br: 0.5412, liq: 13074.31, hev: true, bp: false, sp: false, np: true, ath: 2.89 },
  { ca: "GoYgKp7R8VTcJveLzm6sfbVB3XJYeh1EYjftWzCipump", name: null,               mc: 13677.20,  vm: 1.9767,  age: 28.0, br: 0.5559, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 2.74 },
  { ca: "A2ncdzEmTiaKTrCqN5tHFS7L8rixZsg1UQXsf4Gspump", name: "The Heroic Goose", mc: 15346.16,  vm: 1.8308,  age: 11.0, br: 0.5825, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 2.63 },
  { ca: "Gz7q1mUTrh4M3XdNDknArFLgWeCudsdv3utjLDjdpump", name: null,               mc: 11797.00,  vm: 7.1282,  age: 12.0, br: 0.5432, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 2.61 },
  { ca: "DS5keTZHhwn9L8meotEb9XhzUPaHWrJGeNk76kcUpump", name: "Unknown",          mc: 110062.00, vm: 8.4464,  age: 57.0, br: 0.5434, liq: 24295.43, hev: true, bp: false, sp: false, np: true, ath: 2.49 },
  { ca: "GWCFLYZMsoMkPgY1nvkWNH28gSskEBDfLHFUVvNUmed",  name: null,               mc: 12133.01,  vm: 2.9289,  age: 4.0,  br: 0.5484, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 2.40 },
  { ca: "9WYRJXXj56SevFYchKwfs7Sdv9tZJ3jGH7te6jg1pump", name: null,               mc: 29420.53,  vm: 1.6038,  age: 3.0,  br: 0.4523, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 2.34 },
] as const;

// ── PRO Loser Dataset — 50 worst production losers ────────────────────────────
// Source: alert_research_records JOIN alert_queue_telegram WHERE flow_id='PRO'
//         AND classification IN ('RUG','LOSER') AND alert_market_cap <= 100000
//         ORDER BY peak_x_multiple ASC LIMIT 50.
// All pass the current mc_max=$100k gate — these represent future risk.
// mc_max filter applied so the loser fingerprints reflect realistic PRO candidates.

const PRO_LOSER_TOKENS = [
  // Worst rugs (peak 0.01x–0.03x) — highest-MC PRO losers within $100k gate
  { ca: "9McR3kxw4x3Nfgvkm3ZPLHQAGMuG19aJ1QCXSNypump", name: null,                           mc: 91950.00, vm: 1.4407,  age: 32.0, br: 0.5728, liq: 20801.68, hev: true, bp: false, sp: false, np: true, ath: 0.0161 },
  { ca: "D8yEyFTE1bFBP3MJeDocajNFasgBdpt6fSHxqotrpump", name: "PornHub Coin",                 mc: 94946.00, vm: 2.4650,  age: 31.0, br: 0.4156, liq: 21415.82, hev: true, bp: false, sp: false, np: true, ath: 0.0181 },
  { ca: "FQjuoBJrQcFj4Hp1YijK55P8cmpEg4bLKWjgq3Ahpump", name: "DIGITAL RESISTANCE",           mc: 79457.00, vm: 2.8005,  age: 9.0,  br: 0.5292, liq: 19351.32, hev: true, bp: false, sp: false, np: true, ath: 0.0206 },
  { ca: "GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump", name: null,                           mc: 88105.00, vm: 3.2062,  age: 37.0, br: 0.5506, liq: 20843.17, hev: true, bp: false, sp: false, np: true, ath: 0.0246 },
  { ca: "J3yT8eGYMr7iSXxH6M3ne84kQJQZPqpSr69HHJG8pump", name: "Pumpfun Coin",                mc: 69746.00, vm: 3.2641,  age: 8.0,  br: 0.5616, liq: 18169.25, hev: true, bp: false, sp: false, np: true, ath: 0.0260 },
  { ca: "3bBbavRweBxEbsqTRw9R5BFTFS9udnHLaos7xr2cpump", name: "solcat",                       mc: 58772.00, vm: 2.4519,  age: 6.0,  br: 0.5662, liq: 16409.73, hev: true, bp: false, sp: false, np: true, ath: 0.0277 },
  { ca: "2wbUoxZ8Die8XYuV8aDqzAaPzCfpQD3C2QbGBUEJpump", name: "Daisy",                        mc: 80061.00, vm: 12.6121, age: 45.0, br: 0.5363, liq: 21011.98, hev: true, bp: false, sp: false, np: true, ath: 0.0302 },
  { ca: "vNBgX1SXWZJU3qZzhfACu2rt9z7zV3xUbb6x5XCpump",  name: null,                           mc: 42467.00, vm: 2.5658,  age: 5.0,  br: 0.5499, liq: 13657.80, hev: true, bp: false, sp: false, np: true, ath: 0.0347 },
  { ca: "FXYxeJXqDC7cyZKEpvWawKZoftfycBCbM7WmjmDDpump", name: null,                           mc: 40329.00, vm: 1.7139,  age: 5.0,  br: 0.5314, liq: 13332.38, hev: true, bp: false, sp: false, np: true, ath: 0.0350 },
  { ca: "G13ME86x6YSDSXGJmxkh8MmjF3SxAM1Jfk26iZLppump", name: null,                           mc: 38494.00, vm: 3.3374,  age: 4.0,  br: 0.5475, liq: 13085.18, hev: true, bp: false, sp: false, np: true, ath: 0.0375 },
  { ca: "HWQhwBhpacVH2BobSsbFwBTp7okanUwPy3nNKe9Tpump", name: null,                           mc: 63923.00, vm: 1.2419,  age: 7.0,  br: 0.5484, liq: 17127.09, hev: true, bp: false, sp: false, np: true, ath: 0.0393 },
  { ca: "7QmTqQJRqgB9SAHKqx4kg61bkQUAfvSXtzZTxYdYpump", name: null,                           mc: 43672.00, vm: 3.1303,  age: 5.0,  br: 0.5954, liq: 14092.10, hev: true, bp: false, sp: false, np: true, ath: 0.0417 },
  { ca: "7sP3xLAywb3NJrNLiGBHrxXwMwXhFhJLam4szwuQpump", name: "dog wif wheels",               mc: 39626.00, vm: 2.2036,  age: 11.0, br: 0.5279, liq: 13145.83, hev: true, bp: false, sp: false, np: true, ath: 0.0420 },
  { ca: "ygMHP6J7n3Rdyi6VRDxBFJFqoKokn3YLGaaH5uDpump",  name: null,                           mc: 46875.00, vm: 3.2836,  age: 6.0,  br: 0.5429, liq: 14499.14, hev: true, bp: false, sp: false, np: true, ath: 0.0425 },
  { ca: "8zz2yFtEr4nqHAKSUW21XD1MuXFKRNrPC5VC25CQpump", name: null,                           mc: 44300.00, vm: 1.7761,  age: 5.0,  br: 0.5480, liq: 14052.14, hev: true, bp: false, sp: false, np: true, ath: 0.0446 },
  { ca: "D2CpiYSGu729sX4P3rnnyLLkVf5XrY7U9sPdzQqSpump",  name: null,                           mc: 33598.00, vm: 2.5166,  age: 10.0, br: 0.5134, liq: 11984.62, hev: true, bp: false, sp: false, np: true, ath: 0.0468 },
  { ca: "6hPZXVt6XW4mrtJgJTF6fydc8ksZVXPJHc99HmrzKPMP", name: null,                           mc: 37041.00, vm: 3.0627,  age: 14.0, br: 0.5566, liq: 12724.65, hev: true, bp: false, sp: false, np: true, ath: 0.0470 },
  { ca: "9ozDxJfnDvc2Bj62qZWakC4aRogPSSWEbgnwVTmGpump", name: "cattybara",                    mc: 43412.00, vm: 19.7209, age: 47.0, br: 0.5251, liq: 15046.94, hev: true, bp: false, sp: false, np: true, ath: 0.0476 },
  { ca: "7kkB7mn4BGzLookhDyabyZ53kKBsLLw6EGw7NqpBpump", name: null,                           mc: 25833.77, vm: 2.6339,  age: 5.0,  br: 0.4514, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0559 },
  { ca: "6WL245NVFi2bPb2Jb5tjCwfCfApqoF2iA1vuZfLNpump", name: null,                           mc: 25536.50, vm: 2.6532,  age: 10.0, br: 0.5004, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0569 },
  { ca: "21BTR4m7ndap1mqq6MobR7S4SQZrum8YfznEuoExpump", name: null,                           mc: 21688.63, vm: 2.5292,  age: 10.0, br: 0.5895, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0690 },
  { ca: "CiPxKfgE1sX4i9sgSrHzpbAw1aGUH4QFRgrAyE6Rpump", name: "THE BOARD",                   mc: 22887.00, vm: 8.7246,  age: 45.0, br: 0.5164, liq: 9853.63,  hev: true, bp: false, sp: false, np: true, ath: 0.0695 },
  { ca: "82A941LEyqj2gmKranWyMxk2DAtuEPaJ3ucZ4KHwpump", name: null,                           mc: 25526.00, vm: 1.2452,  age: 2.0,  br: 0.4435, liq: 10236.99, hev: true, bp: false, sp: false, np: true, ath: 0.0717 },
  { ca: "7f3hE4qwjTv9wsKCRkUPp8vmY2Y1ejR8cRq5Garu3VD2", name: null,                           mc: 26049.00, vm: 30.7137, age: 58.0, br: 0.5187, liq: 11219.03, hev: true, bp: false, sp: false, np: true, ath: 0.0729 },
  { ca: "3fB2NSgSJx3r3PC6waadxDFxettquexZPkSuKt7Lpump", name: null,                           mc: 57132.00, vm: 5.3378,  age: 28.0, br: 0.5434, liq: 16518.09, hev: true, bp: false, sp: false, np: true, ath: 0.0744 },
  { ca: "B5TRgwPwNSRBkSacqKUx46ygEKEMhssD8mWnK113pump", name: null,                           mc: 29746.00, vm: 3.5887,  age: 14.0, br: 0.5351, liq: 11240.54, hev: true, bp: false, sp: false, np: true, ath: 0.0745 },
  { ca: "BWJ2hyJJye62Z4xx7PJQtR3NHmZmEvYay82SufVcpump", name: null,                           mc: 19695.00, vm: 6.9767,  age: 3.0,  br: 0.4943, liq: 8947.01,  hev: true, bp: false, sp: false, np: true, ath: 0.0756 },
  { ca: "6pUAR38LLDP6vYExrxb9c2CB4oFNwgMsTEk2EmwMpump", name: "horses dont stop they keep going", mc: 20753.00, vm: 4.6216, age: 20.0, br: 0.5226, liq: 9165.64, hev: true, bp: false, sp: false, np: true, ath: 0.0766 },
  { ca: "4yhBDcNUmdknfZE87gyYDn1nxjuYBgFPo3GS1v7Zpump", name: null,                           mc: 21786.06, vm: 1.1718,  age: 7.0,  br: 0.5737, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0774 },
  { ca: "6ovQxNfg4AQENbAfMAt651NvFGnAJLunHAEs2A7Rpump", name: null,                           mc: 29612.00, vm: 1.3531,  age: 14.0, br: 0.5509, liq: 11123.11, hev: true, bp: false, sp: false, np: true, ath: 0.0790 },
  { ca: "7CsPtjBwbAdZUtrsxNPeiR7Zx59L14VYZ6GryrPRpump", name: null,                           mc: 19038.76, vm: 3.1843,  age: 28.0, br: 0.5824, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0794 },
  { ca: "DpQcE35NnXaaaXT4AoixEeVX4e5CqEXStoSGM46jpump", name: null,                           mc: 18136.03, vm: 1.2883,  age: 7.0,  br: 0.5870, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0795 },
  { ca: "BkXp4GFwmpZho2rZk5WUuqATMwg2KerBRfv7NpPVpump", name: null,                           mc: 25085.00, vm: 1.9804,  age: 11.0, br: 0.5921, liq: 10116.75, hev: true, bp: false, sp: false, np: true, ath: 0.0814 },
  { ca: "7CHiJezDRfn6ffqiCHzPmodeCN128TeRSje1mBGKpump", name: null,                           mc: 25495.16, vm: 3.2091,  age: 9.0,  br: 0.5834, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0826 },
  { ca: "HDtM7yjmFkER8Wj2a9CynA8G5jL9t7YE1gY5WUJRpump", name: null,                           mc: 30809.00, vm: 2.1975,  age: 2.0,  br: 0.5214, liq: 11424.18, hev: true, bp: false, sp: false, np: true, ath: 0.0826 },
  { ca: "DywrfwoP2fsCDLJwAEpZHHxKehYKkPzJrXU8rd5zvCxm",  name: null,                           mc: 17630.00, vm: 2.2901,  age: 3.0,  br: 0.5407, liq: 8275.67,  hev: true, bp: false, sp: false, np: true, ath: 0.0831 },
  { ca: "F3hU7evswjeaAeMescLFHCpGzcLSFNEp7Vko2fWxpump", name: null,                           mc: 19879.97, vm: 2.8776,  age: 12.0, br: 0.5879, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0834 },
  { ca: "7aMv7KvLdKabAthiB5f4q8ZMBsWqawKHmgSY5bd9pump", name: null,                           mc: 17357.00, vm: 2.3290,  age: 4.0,  br: 0.5486, liq: 8222.06,  hev: true, bp: false, sp: false, np: true, ath: 0.0842 },
  { ca: "27rRgzHGkm9Kmuxw1EBCJxoAkzxUXkHApGTyydaCpump", name: null,                           mc: 23307.13, vm: 2.7092,  age: 27.0, br: 0.4953, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0842 },
  { ca: "CVZPsgkdeHq5L8pSnphGzdV7xzxFZgnJGXxcJzhV8dBe",  name: null,                           mc: 23971.00, vm: 1.9782,  age: 2.0,  br: 0.4591, liq: 9870.67,  hev: true, bp: false, sp: false, np: true, ath: 0.0856 },
  { ca: "8hq56BabpafYpMfVYELuL2jbKs8gp7XgBXbRpxMopump", name: null,                           mc: 23652.76, vm: 2.2747,  age: 7.0,  br: 0.5283, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0865 },
  { ca: "2SxjuXQtor81yP7Nor1Zbw2rHzbTirgyhBWARw1fpump", name: null,                           mc: 22825.44, vm: 2.8028,  age: 15.0, br: 0.5857, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0871 },
  { ca: "AEgyF6YLH6BavXgR5iaBJSqZg4unWHtBnxr8US9npump", name: null,                           mc: 67786.00, vm: 1.8504,  age: 5.0,  br: 0.4620, liq: 17759.94, hev: true, bp: false, sp: false, np: true, ath: 0.0927 },
  { ca: "3qkuH6AbTqPByqTNxTtBmcDutuHLREGHyZJBPYkipump", name: null,                           mc: 22055.77, vm: 2.3533,  age: 10.0, br: 0.4047, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0948 },
  { ca: "4LZM2SqrHcL2ghAJCK68ZGqVYyfQgd36h6WZg8uMpump", name: null,                           mc: 22450.30, vm: 2.5010,  age: 5.0,  br: 0.5501, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0950 },
  { ca: "4VUStN56FrbXcUVxGJKJ5ASDKasVuupKg5GxxoTepump", name: null,                           mc: 15759.00, vm: 6.0614,  age: 31.0, br: 0.5303, liq: 7803.95,  hev: true, bp: false, sp: false, np: true, ath: 0.0953 },
  { ca: "32LM5tQmT9f6e5pFqkF7tjwgZguoauqW1Y8q54n1pump", name: null,                           mc: 14709.01, vm: 1.4294,  age: 33.0, br: 0.5889, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0989 },
  { ca: "ACiPypHuig2J272ybUdqaj4PWa9yNXMHbU8836iM4acM",  name: null,                           mc: 18264.23, vm: 1.7859,  age: 4.0,  br: 0.5729, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0989 },
  { ca: "CeH47XYKS4YntFd53MiWrbTsQzEuHM5JPCi57wdjpump", name: null,                           mc: 23114.64, vm: 2.0996,  age: 12.0, br: 0.5874, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0990 },
  { ca: "9nrCE5q2zJs3wSUpeYuyu3niD4YziG7J8Sgz9Hbzpump", name: null,                           mc: 15947.49, vm: 4.3636,  age: 11.0, br: 0.5918, liq: null,     hev: true, bp: false, sp: false, np: true, ath: 0.0991 },
] as const;

// ── PRO TP ladder (pro-v1) ────────────────────────────────────────────────────
// 3-rung ladder: take 60% at 2x, 30% at 3.5x, moon-bag the rest.
// Earlier exits reflect lower-confidence PRO selections.
const PRO_TP_LADDER = [
  { multiplier: 2.0,  sell_pct: 60, is_moon_bag: 0, enabled: 1, sort_order: 1 },
  { multiplier: 3.5,  sell_pct: 30, is_moon_bag: 0, enabled: 1, sort_order: 2 },
  { multiplier: 6.0,  sell_pct: 0,  is_moon_bag: 1, enabled: 1, sort_order: 3 },
];

// ── Seed ELITE (gold-v1) ──────────────────────────────────────────────────────

function seedElite(): void {
  const existing = getProfileById(ELITE_PROFILE_ID);

  if (!existing) {
    logger.info("[elite-filter] seeding Gold Dataset v1 production profile (ELITE)");

    createProfile({
      id:          ELITE_PROFILE_ID,
      name:        "Gold Dataset v1 — Production",
      description: "Validated August 2026 from 21 production winner tokens. " +
                   "Passes 21/21 gold winners, blocks all peaked-at-alert tokens. " +
                   "Replaces hardcoded entryFilter constants.",
      version:     "v1",
      notes:       "Initial production profile. HEV required, SP blocked. " +
                   "MC $5k–$200k, Pair Age 3–90m, Vol/MC ≥ 0.5x. " +
                   "Do not edit directly — clone and activate a new version instead.",
      mc_min:           5_000,
      mc_max:           200_000,
      pair_age_min:     3,
      pair_age_max:     90,
      vol_mc_min:       0.5,
      vol_mc_max:       null,
      buy_ratio_min:    null,
      buy_ratio_max:    null,
      liq_min:          null,
      liq_max:          null,
      require_hev:               1,
      block_buy_pressure:        0,
      block_sell_pressure:       1,
      require_new_pair:          0,
      require_holder_growth:     0,
      require_dev_safe:          0,
      require_lp_locked:         0,
      require_liquidity_present: 0,
      minimum_score:      0.0,
      minimum_similarity: 0.0,
      minimum_confidence: 0.0,
      // ELITE trading config
      max_active_trades:       4,
      max_buy_usd:             5,
      stop_loss_pct:           90,
      max_position_age_hours:  24,
      entry_window_minutes:    60,
      max_wallet_exposure_pct: 20,
    });

    activateProfile(ELITE_PROFILE_ID);

    for (const t of GOLD_TOKENS) {
      addGoldToken({
        profileId:       ELITE_PROFILE_ID,
        contractAddress: t.ca,
        tokenName:       t.name,
        mc:              t.mc,
        volMc:           t.vol_mc,
        pairAgeMinutes:  t.age,
        buyRatio:        t.buy_ratio ?? null,
        liquidity:       t.liq ?? null,
        hasHev:          t.hev,
        hasBp:           t.bp,
        hasSp:           t.sp,
        hasNp:           t.np,
        athX:            t.ath,
      });
    }

    logger.info(`[elite-filter] Gold Dataset v1 seeded — ${GOLD_TOKENS.length} gold tokens`);
  } else {
    // Backfill: version/notes on profiles created before v52
    if (!existing.version || !existing.notes) {
      updateProfile(ELITE_PROFILE_ID, {
        version: existing.version ?? "v1",
        notes:   existing.notes  ??
          "Initial production profile. HEV required, SP blocked. " +
          "MC $5k–$200k, Pair Age 3–90m, Vol/MC ≥ 0.5x. " +
          "Do not edit directly — clone and activate a new version instead.",
      });
      logger.info("[elite-filter] Backfilled version/notes on Gold Dataset v1");
    }

    // Backfill: per-profile trading config added in v53
    if (existing.max_active_trades == null) {
      updateProfile(ELITE_PROFILE_ID, {
        max_active_trades:       4,
        max_buy_usd:             5,
        stop_loss_pct:           90,
        max_position_age_hours:  24,
        entry_window_minutes:    60,
        max_wallet_exposure_pct: 20,
      });
      logger.info("[elite-filter] Backfilled trading config on Gold Dataset v1 (ELITE)");
    }
  }

  // Seed ELITE TP ladder (idempotent — replaces if already set to ensure it's current)
  const existingLadder = getTpLadderForProfile(ELITE_PROFILE_ID);
  if (existingLadder.length === 0) {
    replaceTpLadder(ELITE_PROFILE_ID, ELITE_TP_LADDER);
    logger.info("[elite-filter] Seeded ELITE TP ladder (4 rungs)");
  }

  // Link ELITE flow → gold-v1 profile
  const eliteFlowLink = sqlite
    .prepare("SELECT filter_profile_id FROM alert_flows WHERE id = 'ELITE' LIMIT 1")
    .get() as { filter_profile_id: string | null } | undefined;
  if (!eliteFlowLink) {
    logger.warn("[elite-filter] ELITE flow row not found — profile link skipped; re-run after flows are seeded");
  } else if (eliteFlowLink.filter_profile_id !== ELITE_PROFILE_ID) {
    linkProfileToFlow("ELITE", ELITE_PROFILE_ID);
    logger.info("[elite-filter] Linked ELITE flow → gold-v1");
  }
}

// ── Seed PRO (pro-v1) ─────────────────────────────────────────────────────────

function seedPro(): void {
  const existing = getProfileById(PRO_PROFILE_ID);

  if (!existing) {
    logger.info("[elite-filter] seeding PRO profile (pro-v1)");

    createProfile({
      id:          PRO_PROFILE_ID,
      name:        "PRO v1 — Production",
      description: "Independent PRO profile. 16-token winner dataset + 50-token loser dataset " +
                   "derived from 714 PRO production records (August 2026). " +
                   "Loser similarity gate active at 0.50.",
      version:     "v1",
      notes:       "Research basis: 714 PRO alerts, 412 with outcomes (Aug 2026). " +
                   "16 winners (peak ≥ 2x), 50 losers (worst rugs/losses ≤ $100k MC). " +
                   "Key findings: all winners have HEV+NP; MC $7k–$30k; buy_ratio 0.45–0.59. " +
                   "Do not edit directly — clone and activate a new version instead.",
      // PRO-specific entry gates
      mc_min:           5_000,
      mc_max:           100_000,
      pair_age_min:     3,
      pair_age_max:     90,
      vol_mc_min:       0.5,
      vol_mc_max:       null,
      buy_ratio_min:    0.45,
      buy_ratio_max:    null,
      liq_min:          null,
      liq_max:          null,
      require_hev:               1,
      block_buy_pressure:        0,
      block_sell_pressure:       1,
      require_new_pair:          0,
      require_holder_growth:     0,
      require_dev_safe:          0,
      require_lp_locked:         0,
      require_liquidity_present: 0,
      minimum_score:      0.750,
      minimum_similarity: 0.50,  // loser dataset active from first run
      minimum_confidence: 0.0,
      // PRO trading config
      max_active_trades:       3,
      max_buy_usd:             3,
      stop_loss_pct:           90,
      max_position_age_hours:  24,
      entry_window_minutes:    60,
      max_wallet_exposure_pct: 15,
    });

    logger.info("[elite-filter] PRO profile (pro-v1) seeded");
  }

  // ── PRO Gold Tokens (winner dataset) ────────────────────────────────────────
  // Address-based idempotency: insert only tokens not already present.
  // Handles partial populations (e.g. seed file extended after first run).
  {
    const existingAddrs = new Set(
      getGoldTokensForProfile(PRO_PROFILE_ID).map((t) => t.contract_address),
    );
    const toAdd = PRO_GOLD_TOKENS.filter((t) => !existingAddrs.has(t.ca));
    if (toAdd.length > 0) {
      for (const t of toAdd) {
        addGoldToken({
          profileId:       PRO_PROFILE_ID,
          contractAddress: t.ca,
          tokenName:       t.name ?? null,
          mc:              t.mc,
          volMc:           t.vm,
          pairAgeMinutes:  t.age,
          buyRatio:        t.br,
          liquidity:       t.liq ?? null,
          hasHev:          t.hev,
          hasBp:           t.bp,
          hasSp:           t.sp,
          hasNp:           t.np,
          athX:            t.ath,
        });
      }
      logger.info(`[elite-filter] Seeded PRO winner dataset — ${toAdd.length} new token(s) (total: ${existingAddrs.size + toAdd.length})`);
    }
  }

  // ── PRO Loser Tokens (historical loss dataset) ───────────────────────────────
  // Address-based idempotency: insert only tokens not already present.
  {
    const existingAddrs = new Set(
      getLoserTokensForProfile(PRO_PROFILE_ID).map((t) => t.contract_address),
    );
    const toAdd = PRO_LOSER_TOKENS.filter((t) => !existingAddrs.has(t.ca));
    if (toAdd.length > 0) {
      for (const t of toAdd) {
        addLoserToken({
          profileId:       PRO_PROFILE_ID,
          contractAddress: t.ca,
          tokenName:       t.name ?? null,
          mc:              t.mc,
          volMc:           t.vm,
          pairAgeMinutes:  t.age,
          buyRatio:        t.br,
          liquidity:       t.liq ?? null,
          hasHev:          t.hev,
          hasBp:           t.bp,
          hasSp:           t.sp,
          hasNp:           t.np,
          athX:            t.ath,
        });
      }
      logger.info(`[elite-filter] Seeded PRO loser dataset — ${toAdd.length} new token(s) (total: ${existingAddrs.size + toAdd.length})`);
    }
  }

  // ── Backfill: enable loser similarity gate on existing pro-v1 ───────────────
  // If pro-v1 existed before this run (loser dataset now populated), activate the gate.
  const profile = getProfileById(PRO_PROFILE_ID);
  if (profile && profile.minimum_similarity === 0.0 &&
      getLoserTokensForProfile(PRO_PROFILE_ID).length > 0) {
    updateProfile(PRO_PROFILE_ID, { minimum_similarity: 0.50 });
    logger.info("[elite-filter] PRO loser gate activated (minimum_similarity = 0.50)");
  }

  // Seed PRO TP ladder (idempotent)
  const existingLadder = getTpLadderForProfile(PRO_PROFILE_ID);
  if (existingLadder.length === 0) {
    replaceTpLadder(PRO_PROFILE_ID, PRO_TP_LADDER);
    logger.info("[elite-filter] Seeded PRO TP ladder (3 rungs)");
  }

  // Link PRO flow → pro-v1 profile
  const proFlowLink = sqlite
    .prepare("SELECT filter_profile_id FROM alert_flows WHERE id = 'PRO' LIMIT 1")
    .get() as { filter_profile_id: string | null } | undefined;
  if (!proFlowLink) {
    logger.warn("[elite-filter] PRO flow row not found — profile link skipped; re-run after flows are seeded");
  } else if (proFlowLink.filter_profile_id !== PRO_PROFILE_ID) {
    linkProfileToFlow("PRO", PRO_PROFILE_ID);
    logger.info("[elite-filter] Linked PRO flow → pro-v1");
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export function seedEliteFilterV1(): void {
  seedElite();
  seedPro();
}
