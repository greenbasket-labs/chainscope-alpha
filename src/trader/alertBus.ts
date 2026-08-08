/**
 * Alert Bus — Internal pub/sub for new alert events.
 *
 * Emitted synchronously by createAlert() after the SQLite transaction commits.
 * Simulation engine and any future engines subscribe here instead of polling.
 *
 * Fire-and-forget: the alertCenter/service does not await handlers.
 * Handlers must manage their own error boundaries.
 */

import { EventEmitter } from "events";

// ── Event payload ─────────────────────────────────────────────────────────────

export interface NewAlertEvent {
  alertId:         number;
  tokenId:         number;
  tokenAddress:    string;
  investigationId: number | null;
  evidenceScore:   number;
  confidence:      number;
  alertProfile:    Record<string, unknown> | null;
  /** Flow that claimed this alert — null = global/fallback bot */
  flowId:          string | null;
  createdAt:       number;
}

// ── Bus ────────────────────────────────────────────────────────────────────────

class AlertEventBus extends EventEmitter {
  private static readonly EVENT = "alert" as const;

  emit(event: "alert", data: NewAlertEvent): boolean {
    return super.emit(event, data);
  }

  subscribe(handler: (event: NewAlertEvent) => void): void {
    this.on(AlertEventBus.EVENT, handler);
  }

  unsubscribe(handler: (event: NewAlertEvent) => void): void {
    this.off(AlertEventBus.EVENT, handler);
  }
}

export const alertBus = new AlertEventBus();
alertBus.setMaxListeners(20);
