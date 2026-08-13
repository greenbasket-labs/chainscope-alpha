import { alertBus, type NewAlertEvent } from "./alertBus.js";
import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";

const enabled = process.env.MINTLINE_BRIDGE_ENABLED === "true";
const baseUrl = (process.env.MINTLINE_API_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.MINTLINE_API_KEY ?? "";
const walletBalanceSol = Number(process.env.MINTLINE_EXTERNAL_WALLET_BALANCE_SOL ?? "1");

let started = false;
const sent = new Set<string>();

async function forward(event: NewAlertEvent): Promise<void> {
  if (!enabled || !baseUrl) return;
  if (!event.tokenAddress) return;

  const key = event.tokenAddress;
  if (sent.has(key)) return;

  const row = sqlite
    .prepare("SELECT price_usd FROM alpha_candidates WHERE id = ? LIMIT 1")
    .get(event.tokenId) as { price_usd: number | null } | undefined;
  const buyPrice = Number(row?.price_usd ?? 0);

  if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
    logger.warn({ token: key }, "MINTLINE bridge skipped: no valid current price");
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/api/intake/ca`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-Mintline-API-Key": apiKey } : {}),
      },
      body: JSON.stringify({
        ca: event.tokenAddress,
        buyPrice,
        walletBalanceSol,
        source: "chainscope-alpha",
        alertId: event.alertId,
        flowId: event.flowId,
        evidenceScore: event.evidenceScore,
        confidence: event.confidence,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger.warn({ token: key, status: response.status, data }, "MINTLINE bridge rejected CA");
      return;
    }

    sent.add(key);
    logger.info({ token: key, result: data }, "CA forwarded to MINTLINE");
  } catch (err) {
    logger.warn({ err, token: key }, "MINTLINE bridge request failed");
  }
}

export function startMintlineBridge(): void {
  if (started) return;
  started = true;

  if (!enabled) {
    logger.info("MINTLINE bridge disabled");
    return;
  }

  if (!baseUrl) {
    logger.warn("MINTLINE bridge enabled but MINTLINE_API_URL is missing");
    return;
  }

  alertBus.subscribe((event) => {
    void forward(event);
  });

  logger.info({ baseUrl }, "MINTLINE bridge enabled");
}
