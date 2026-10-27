import { z } from 'zod';
import { TIMEFRAMES, type Timeframe } from './timeframes.ts';
import { isSymbolId } from './symbols.ts';
import type { CandleTuple, ProviderState } from './types.ts';

// ---------- client -> gateway ----------

const symbolId = z.string().refine(isSymbolId, 'invalid symbol id');
const timeframe = z.enum(TIMEFRAMES);

export const ClientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), symbol: symbolId, tf: timeframe }),
  z.object({ op: z.literal('unsub'), symbol: symbolId, tf: timeframe }),
  /** App-level ping used for clock sync and RTT; `ct` = client send time (ms). */
  z.object({ op: z.literal('ping'), ct: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- gateway -> client ----------

/** Pipeline timestamps carried with every candle update, used by the latency panel. */
export interface LatencyStamps {
  /** Exchange event time of the newest trade folded into this update (exchange clock, ms). */
  et: number;
  /** Ingest-local time that trade was received. */
  ri: number;
  /** Ingest-local time the update was published to Redis. */
  pi: number;
  /** Exchange clock minus ingest clock (ms), measured against the provider's time endpoint. */
  xo: number;
  /** Gateway-local time the frame was written to the socket. */
  sg: number;
}

export type ServerMessage =
  | { t: 'hello'; v: 1; serverTime: number }
  /** Open-candle update. `ep` is the provider epoch; a change means continuity broke and history must be backfilled. */
  | { t: 'c'; s: string; tf: Timeframe; ep: number; c: CandleTuple; lat: LatencyStamps }
  | { t: 'pong'; ct: number; st: number }
  | { t: 'status'; provider: string; state: ProviderState; epoch: number }
  | { t: 'subscribed'; s: string; tf: Timeframe }
  | { t: 'error'; code: string; message: string };

// ---------- ingest -> gateway (Redis) ----------

/** Published on `cd:c:<symbolId>`: the open candle of every timeframe for one symbol. */
export interface CandleBatch {
  s: string;
  /** Provider epoch: increments every time the upstream stream reconnects and re-seeds. */
  ep: number;
  c: Partial<Record<Timeframe, CandleTuple>>;
  et: number;
  ri: number;
  pi: number;
  xo: number;
}

export interface ProviderStatusMessage {
  provider: string;
  state: ProviderState;
  epoch: number;
  at: number;
}

export const REDIS_KEYS = {
  candleChannel: (symbol: string) => `cd:c:${symbol}`,
  candleChannelPattern: 'cd:c:*',
  hot: (symbol: string) => `cd:hot:${symbol}`,
  statusChannel: 'cd:status',
  status: (provider: string) => `cd:status:${provider}`,
  /** Per-gateway set of demanded symbols; expires if that gateway dies. */
  demand: (gatewayId: string) => `cd:demand:${gatewayId}`,
  demandPattern: 'cd:demand:*',
  demandChanged: 'cd:demand-changed',
} as const;
