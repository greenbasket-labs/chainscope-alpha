/**
 * Elite Filter Routes
 *
 * Full CRUD for profiles, weights, gold dataset tokens, and loser dataset tokens.
 * Admin editing — no auth required (same trust model as other admin routes).
 *
 * Routes (all under /elite-filter):
 *   GET    /profiles                   — list all profiles
 *   GET    /profiles/active            — active profile + weights + gold + loser tokens
 *   GET    /profiles/:id               — profile detail + weights + gold + loser tokens
 *   POST   /profiles                   — create new profile
 *   POST   /profiles/:id/duplicate     — duplicate a profile
 *   POST   /profiles/:id/activate      — set as active
 *   PUT    /profiles/:id               — update gates/thresholds/metadata
 *   DELETE /profiles/:id               — delete profile
 *   GET    /profiles/:id/weights       — list weights
 *   PUT    /profiles/:id/weights       — bulk-update weights
 *   GET    /profiles/:id/gold          — list gold (winner) tokens
 *   POST   /profiles/:id/gold          — add gold token
 *   DELETE /profiles/:id/gold/:tid     — remove gold token
 *   GET    /profiles/:id/losers        — list loser tokens
 *   POST   /profiles/:id/losers        — add loser token
 *   DELETE /profiles/:id/losers/:lid   — remove loser token
 *   POST   /evaluate                   — evaluate a candidate (debug)
 */

import { Router } from "express";
import {
  listProfiles,
  getActiveProfile,
  getProfileById,
  createProfile,
  updateProfile,
  activateProfile,
  deleteProfile,
  duplicateProfile,
  getWeightsForProfile,
  bulkUpsertWeights,
  getGoldTokensForProfile,
  addGoldToken,
  removeGoldToken,
  getLoserTokensForProfile,
  addLoserToken,
  removeLoserToken,
  getTpLadderForProfile,
  upsertTpLadderRung,
  deleteTpLadderRung,
  replaceTpLadder,
} from "../eliteFilter/db.js";
import { evaluateEliteFilter, invalidateEliteFilterCache } from "../eliteFilter/engine.js";
import type { CandidateSignals } from "../eliteFilter/types.js";

const router: import('express').Router = Router();

// ── List all profiles ─────────────────────────────────────────────────────────

router.get("/elite-filter/profiles", (_req, res) => {
  try {
    const profiles = listProfiles();
    res.json(profiles);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Active profile (full detail) ──────────────────────────────────────────────

router.get("/elite-filter/profiles/active", (_req, res) => {
  try {
    const profile = getActiveProfile();
    if (!profile) return void res.json(null);
    const weights      = getWeightsForProfile(profile.id);
    const goldTokens   = getGoldTokensForProfile(profile.id);
    const loserTokens  = getLoserTokensForProfile(profile.id);
    res.json({ profile, weights, goldTokens, loserTokens });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Single profile detail ─────────────────────────────────────────────────────

router.get("/elite-filter/profiles/:id", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    const weights      = getWeightsForProfile(profile.id);
    const goldTokens   = getGoldTokensForProfile(profile.id);
    const loserTokens  = getLoserTokensForProfile(profile.id);
    res.json({ profile, weights, goldTokens, loserTokens });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Create profile ────────────────────────────────────────────────────────────

router.post("/elite-filter/profiles", (req, res) => {
  try {
    const { id, name, ...rest } = req.body as { id?: string; name?: string; [k: string]: unknown };
    if (!name) return void res.status(400).json({ error: "name is required" });
    const newId = (id as string) || `profile-${Date.now()}`;
    const profile = createProfile({ id: newId, name: name as string, ...rest });
    invalidateEliteFilterCache();
    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Duplicate profile ─────────────────────────────────────────────────────────

router.post("/elite-filter/profiles/:id/duplicate", (req, res) => {
  try {
    const { newId, newName } = req.body as { newId?: string; newName?: string };
    const targetId   = newId   || `profile-${Date.now()}`;
    const targetName = newName || `Copy of ${req.params.id}`;
    const profile = duplicateProfile(req.params.id!, targetId, targetName);
    if (!profile) return void res.status(404).json({ error: "Source profile not found" });
    invalidateEliteFilterCache();
    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Activate profile ──────────────────────────────────────────────────────────

router.post("/elite-filter/profiles/:id/activate", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    activateProfile(req.params.id!);
    invalidateEliteFilterCache();
    res.json({ ok: true, active: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Update profile gates/thresholds/metadata ──────────────────────────────────

router.put("/elite-filter/profiles/:id", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    updateProfile(req.params.id!, req.body);
    invalidateEliteFilterCache();
    res.json(getProfileById(req.params.id!));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Delete profile ────────────────────────────────────────────────────────────

router.delete("/elite-filter/profiles/:id", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    if (profile.is_active) return void res.status(400).json({ error: "Cannot delete the active profile — activate another first" });
    deleteProfile(req.params.id!);
    invalidateEliteFilterCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Get weights ───────────────────────────────────────────────────────────────

router.get("/elite-filter/profiles/:id/weights", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    res.json(getWeightsForProfile(req.params.id!));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Bulk-update weights ───────────────────────────────────────────────────────

router.put("/elite-filter/profiles/:id/weights", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    const weights = req.body as Array<{ signal: string; weight: number; enabled?: number }>;
    if (!Array.isArray(weights)) return void res.status(400).json({ error: "Body must be an array of { signal, weight, enabled? }" });
    bulkUpsertWeights(req.params.id!, weights);
    invalidateEliteFilterCache();
    res.json(getWeightsForProfile(req.params.id!));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Gold (winner) tokens ──────────────────────────────────────────────────────

router.get("/elite-filter/profiles/:id/gold", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    res.json(getGoldTokensForProfile(req.params.id!));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/elite-filter/profiles/:id/gold", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    const body = req.body as {
      contract_address: string;
      token_name?:      string;
      mc?:              number;
      vol_mc?:          number;
      pair_age_minutes?: number;
      buy_ratio?:       number;
      liquidity?:       number;
      has_hev?:         boolean;
      has_bp?:          boolean;
      has_sp?:          boolean;
      has_np?:          boolean;
      ath_x?:           number;
    };
    if (!body.contract_address) return void res.status(400).json({ error: "contract_address is required" });
    const token = addGoldToken({
      profileId:       req.params.id!,
      contractAddress: body.contract_address,
      tokenName:       body.token_name,
      mc:              body.mc,
      volMc:           body.vol_mc,
      pairAgeMinutes:  body.pair_age_minutes,
      buyRatio:        body.buy_ratio,
      liquidity:       body.liquidity,
      hasHev:          body.has_hev ?? false,
      hasBp:           body.has_bp  ?? false,
      hasSp:           body.has_sp  ?? false,
      hasNp:           body.has_np  ?? false,
      athX:            body.ath_x,
    });
    invalidateEliteFilterCache();
    res.status(201).json(token);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/elite-filter/profiles/:id/gold/:tid", (req, res) => {
  try {
    removeGoldToken(parseInt(req.params.tid!, 10));
    invalidateEliteFilterCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Loser tokens ──────────────────────────────────────────────────────────────

router.get("/elite-filter/profiles/:id/losers", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    res.json(getLoserTokensForProfile(req.params.id!));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/elite-filter/profiles/:id/losers", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return void res.status(404).json({ error: "Profile not found" });
    const body = req.body as {
      contract_address: string;
      token_name?:      string;
      mc?:              number;
      vol_mc?:          number;
      pair_age_minutes?: number;
      buy_ratio?:       number;
      liquidity?:       number;
      has_hev?:         boolean;
      has_bp?:          boolean;
      has_sp?:          boolean;
      has_np?:          boolean;
      ath_x?:           number;
    };
    if (!body.contract_address) return void res.status(400).json({ error: "contract_address is required" });
    const token = addLoserToken({
      profileId:       req.params.id!,
      contractAddress: body.contract_address,
      tokenName:       body.token_name,
      mc:              body.mc,
      volMc:           body.vol_mc,
      pairAgeMinutes:  body.pair_age_minutes,
      buyRatio:        body.buy_ratio,
      liquidity:       body.liquidity,
      hasHev:          body.has_hev ?? false,
      hasBp:           body.has_bp  ?? false,
      hasSp:           body.has_sp  ?? false,
      hasNp:           body.has_np  ?? false,
      athX:            body.ath_x,
    });
    invalidateEliteFilterCache();
    res.status(201).json(token);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/elite-filter/profiles/:id/losers/:lid", (req, res) => {
  try {
    removeLoserToken(parseInt(req.params.lid!, 10));
    invalidateEliteFilterCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── TP Ladder ─────────────────────────────────────────────────────────────────
//
//   GET    /elite-filter/profiles/:id/tp-ladder          — list rungs
//   POST   /elite-filter/profiles/:id/tp-ladder          — upsert a single rung
//   PUT    /elite-filter/profiles/:id/tp-ladder          — replace entire ladder
//   DELETE /elite-filter/profiles/:id/tp-ladder/:rid     — remove a rung

router.get("/elite-filter/profiles/:id/tp-ladder", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const rungs = getTpLadderForProfile(req.params.id!);
    res.json(rungs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/elite-filter/profiles/:id/tp-ladder", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const b = req.body as {
      multiplier:  number;
      sell_pct:    number;
      is_moon_bag?: number;
      enabled?:    number;
      sort_order?: number;
    };
    if (b.multiplier == null || b.sell_pct == null)
      return res.status(400).json({ error: "multiplier and sell_pct are required" });
    upsertTpLadderRung(
      req.params.id!,
      b.multiplier,
      b.sell_pct,
      b.is_moon_bag ?? 0,
      b.enabled     ?? 1,
      b.sort_order  ?? 0,
    );
    res.json({ ok: true, rungs: getTpLadderForProfile(req.params.id!) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Replace the entire ladder in one atomic operation.
router.put("/elite-filter/profiles/:id/tp-ladder", (req, res) => {
  try {
    const profile = getProfileById(req.params.id!);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const rungs = req.body as Array<{
      multiplier:  number;
      sell_pct:    number;
      is_moon_bag?: number;
      enabled?:    number;
      sort_order?: number;
    }>;
    if (!Array.isArray(rungs))
      return res.status(400).json({ error: "body must be an array of rungs" });
    replaceTpLadder(
      req.params.id!,
      rungs.map((r, i) => ({
        multiplier:  r.multiplier,
        sell_pct:    r.sell_pct,
        is_moon_bag: r.is_moon_bag ?? 0,
        enabled:     r.enabled     ?? 1,
        sort_order:  r.sort_order  ?? i,
      })),
    );
    res.json({ ok: true, rungs: getTpLadderForProfile(req.params.id!) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/elite-filter/profiles/:id/tp-ladder/:rid", (req, res) => {
  try {
    deleteTpLadderRung(parseInt(req.params.rid!, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Evaluate (debug) ──────────────────────────────────────────────────────────

router.post("/elite-filter/evaluate", (req, res) => {
  try {
    const signals = req.body as CandidateSignals;
    const result = evaluateEliteFilter(signals);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
