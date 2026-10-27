export const TIMEFRAMES = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const W = 7 * D;
/** 1970-01-05 was the first Monday after the epoch; weeks open Monday 00:00 UTC. */
const WEEK_ANCHOR = 4 * D;

/** Fixed bucket length in ms. `1M` is calendar-based, so this is only an upper bound for it. */
export const TF_MS: Record<Timeframe, number> = {
  '1s': S, '1m': M, '3m': 3 * M, '5m': 5 * M, '15m': 15 * M, '30m': 30 * M,
  '1h': H, '2h': 2 * H, '4h': 4 * H, '1D': D, '1W': W, '1M': 31 * D,
};

export const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);

/** Open time (epoch ms, UTC) of the bucket containing `ts`. */
export function bucketStart(tf: Timeframe, ts: number): number {
  if (tf === '1M') {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (tf === '1W') return Math.floor((ts - WEEK_ANCHOR) / W) * W + WEEK_ANCHOR;
  const len = TF_MS[tf];
  return Math.floor(ts / len) * len;
}

/** Open time of the bucket after the one opening at `start`. */
export function nextBucket(tf: Timeframe, start: number): number {
  if (tf === '1M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + TF_MS[tf];
}

/** Open time of the bucket before the one opening at `start`. */
export function prevBucket(tf: Timeframe, start: number): number {
  if (tf === '1M') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  }
  return start - TF_MS[tf];
}
