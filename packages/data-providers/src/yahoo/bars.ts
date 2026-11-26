import { bucketStart, type Candle, type Timeframe } from '@chartdeck/shared';

/** The parts of Yahoo's `/v8/finance/chart` result this adapter reads. */
export interface ChartResult {
  meta: ChartMeta;
  timestamp?: number[];
  indicators: {
    quote: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

export interface ChartMeta {
  symbol: string;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  exchangeTimezoneName?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Yahoo sends float32-ish prices (1180.0999755859375); 4 decimals is finer than any tick here. */
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Bars from a chart result, ascending, with Yahoo's null rows (no trades or bad ticks) dropped. */
export function parseBars(r: ChartResult): Candle[] {
  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0] ?? {};
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    out.push({ time: ts[i]! * 1000, open: round(open), high: round(high), low: round(low), close: round(close), volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

/**
 * UTC offset of `tz` at `t`, in ms (IST is +5:30). Cached per hour, which is finer than any
 * real DST transition granularity.
 */
const offsetCache = new Map<string, number>();
export function tzOffsetMs(tz: string, t: number): number {
  const key = `${tz}|${Math.floor(t / 3_600_000)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(t);
    const n = (type: string) => Number(p.find((x) => x.type === type)!.value);
    const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
    off = Math.round((asUtc - Math.floor(t / MIN) * MIN) / MIN) * MIN;
    if (offsetCache.size > 50_000) offsetCache.clear();
    offsetCache.set(key, off);
  }
  return off;
}

export interface Session {
  tz: string;
  /** Regular-session open, exchange-local "HH:MM". */
  open: string;
}

/** UTC midnight of the exchange-local calendar date containing `t`: how daily bars are keyed. */
export function localDate(t: number, tz: string): number {
  return Math.floor((t + tzOffsetMs(tz, t)) / DAY) * DAY;
}

/** Epoch ms of the session open on the exchange-local date containing `t`. */
export function sessionOpen(t: number, s: Session): number {
  const [h, m] = s.open.split(':').map(Number) as [number, number];
  const local = localDate(t, s.tz) + (h * 60 + m) * MIN;
  // Resolve the local wall time with the offset in force at that moment.
  return local - tzOffsetMs(s.tz, local - tzOffsetMs(s.tz, t));
}

/**
 * Start of the session-anchored intraday bucket of length `len` containing `t`. Exchanges
 * (and Yahoo) open hourly bars at the session open, e.g. 09:15, 10:15 for NSE, not on the hour.
 */
export function intradayBucket(t: number, len: number, s: Session): number {
  const open = sessionOpen(t, s);
  return open + Math.floor((t - open) / len) * len;
}

/** Fold `c` into `into` (same bucket, `c` later in time). */
function merge(into: Candle, c: Candle): void {
  if (c.high > into.high) into.high = c.high;
  if (c.low < into.low) into.low = c.low;
  into.close = c.close;
  into.volume += c.volume;
}

/** Combine ascending bars into buckets keyed by `keyOf`, OHLCV-merged. */
export function resample(bars: Candle[], keyOf: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const k = keyOf(b.time);
    const last = out[out.length - 1];
    if (last && last.time === k) merge(last, b);
    else if (!last || k > last.time) out.push({ ...b, time: k });
    // k < last.time cannot happen for ascending input
  }
  return out;
}

/**
 * Re-key bars that already have the target granularity, keeping the later bar on a clash.
 * Yahoo appends the in-progress bar stamped with the last trade time rather than the bar's
 * open (and sometimes repeats it), so the last row needs both treatments.
 */
export function rekey(bars: Candle[], keyOf: (t: number) => number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const k = keyOf(b.time);
    const last = out[out.length - 1];
    if (last && last.time === k) out[out.length - 1] = { ...b, time: k };
    else if (!last || k > last.time) out.push({ ...b, time: k });
  }
  return out;
}

/** Key function for `tf`'s buckets: session-anchored intraday, exchange-local dates for 1D+. */
export function bucketKey(tf: Timeframe, s: Session, len: number): (t: number) => number {
  if (tf === '1D') return (t) => localDate(t, s.tz);
  if (tf === '1W' || tf === '1M') return (t) => bucketStart(tf, localDate(t, s.tz));
  return (t) => intradayBucket(t, len, s);
}

/** The single candle covering `bars` (ascending, same bucket), keyed at `time`. */
export function combine(bars: Candle[], time: number): Candle | undefined {
  if (!bars.length) return undefined;
  const c = { ...bars[0]!, time };
  for (let i = 1; i < bars.length; i++) merge(c, bars[i]!);
  return c;
}
