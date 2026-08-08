/**
 * Market Observation Bus
 *
 * Single source of truth for all market data observations in Alpha.
 * Publishers call marketBus.publish(); subscribers react independently.
 *
 * Publishers: DexScreener poller, simPoller market fetcher
 * Subscribers: positionTracker, liveSellTracker
 */

import { EventEmitter } from "events";

export interface MarketObservation {
  chain: string;
  token_address: string;
  pair_address?: string;
  timestamp: number;
  market_cap?: number;
  liquidity?: number;
  volume_24h?: number;
  volume_6h?: number;
  volume_1h?: number;
  volume_5m?: number;
  buys?: number;
  sells?: number;
  price_usd?: string;
  pair_created_at?: number;
  boosts?: number;
  provider: string;
}

export type ObservationHandler = (obs: MarketObservation) => void;

class MarketObservationBus extends EventEmitter {
  private static readonly EVENT = "observation" as const;

  publish(obs: MarketObservation): void {
    this.emit(MarketObservationBus.EVENT, obs);
  }

  subscribe(handler: ObservationHandler): void {
    this.on(MarketObservationBus.EVENT, handler);
  }

  unsubscribe(handler: ObservationHandler): void {
    this.off(MarketObservationBus.EVENT, handler);
  }
}

export const marketBus = new MarketObservationBus();
marketBus.setMaxListeners(20);
