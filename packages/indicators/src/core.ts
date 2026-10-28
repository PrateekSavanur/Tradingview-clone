import type { Candle } from '@chartdeck/shared';

export type Bar = Candle;
/** One value per plot; null where the indicator has no value yet (warm-up). */
export type Output = Record<string, number | null>;

/**
 * An indicator is a pure step function over plain-data state. Plain data lets the runner
 * snapshot state with structuredClone, which is what makes live revisions O(1).
 */
export interface IndicatorImpl<S> {
  init(): S;
  step(state: S, bar: Bar): Output;
}

/**
 * Feeds bars to an indicator. A bar with a new time commits the previous one; a bar with the
 * same time as the last is a revision of the still-open candle, so state is restored to just
 * before that bar and the step re-run. Live ticks therefore cost one step, never a recompute.
 */
export class Runner<S = unknown> {
  private state: S;
  private before: S | null = null;
  private lastTime = -Infinity;

  constructor(private readonly impl: IndicatorImpl<S>) {
    this.state = impl.init();
  }

  /** Full computation over history. Only the last bar is snapshotted, since only it can change. */
  compute(bars: readonly Bar[]): Output[] {
    this.state = this.impl.init();
    this.before = null;
    this.lastTime = -Infinity;
    const out = new Array<Output>(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      if (i === bars.length - 1) this.before = structuredClone(this.state);
      out[i] = this.impl.step(this.state, bar);
      this.lastTime = bar.time;
    }
    return out;
  }

  /** Incremental update with the latest bar (new or revised). Returns null for out-of-order bars. */
  update(bar: Bar): Output | null {
    if (bar.time === this.lastTime && this.before) {
      this.state = structuredClone(this.before);
    } else if (bar.time > this.lastTime) {
      this.before = structuredClone(this.state);
      this.lastTime = bar.time;
    } else {
      return null;
    }
    return this.impl.step(this.state, bar);
  }
}

// ---------------------------------------------------------------- sources

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;
export type Source = (typeof SOURCES)[number];

export function source(bar: Bar, src: Source): number {
  switch (src) {
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return bar.close;
  }
}

// ---------------------------------------------------------------- state helpers (plain data)

/** Fixed-length window of the most recent values. */
export interface Win {
  len: number;
  buf: number[];
}

export const win = (len: number): Win => ({ len: Math.max(1, Math.floor(len)), buf: [] });

export function push(w: Win, x: number): void {
  w.buf.push(x);
  if (w.buf.length > w.len) w.buf.shift();
}

export const full = (w: Win) => w.buf.length === w.len;
export const sum = (w: Win) => w.buf.reduce((a, b) => a + b, 0);
export const mean = (w: Win) => sum(w) / w.buf.length;
export const highest = (w: Win) => Math.max(...w.buf);
export const lowest = (w: Win) => Math.min(...w.buf);

/** Population standard deviation, as Pine's ta.stdev (biased). */
export function stdev(w: Win): number {
  const m = mean(w);
  return Math.sqrt(w.buf.reduce((a, b) => a + (b - m) ** 2, 0) / w.buf.length);
}

/** Linearly weighted mean: newest value has weight `len`. */
export function wmean(w: Win): number {
  let num = 0;
  let den = 0;
  w.buf.forEach((x, i) => {
    num += (i + 1) * x;
    den += i + 1;
  });
  return num / den;
}

/**
 * Exponential averages seeded with the SMA of the first `len` values, as Pine does.
 * EMA: alpha = 2/(len+1). RMA (Wilder): alpha = 1/len.
 */
export interface Avg {
  alpha: number;
  value: number | null;
  seed: Win;
}

export const ema = (len: number): Avg => ({ alpha: 2 / (Math.floor(len) + 1), value: null, seed: win(len) });
export const rma = (len: number): Avg => ({ alpha: 1 / Math.floor(len), value: null, seed: win(len) });

export function avgPush(a: Avg, x: number): number | null {
  if (a.value === null) {
    push(a.seed, x);
    if (full(a.seed)) a.value = mean(a.seed);
    return a.value;
  }
  a.value = a.alpha * x + (1 - a.alpha) * a.value;
  return a.value;
}

/** Simple moving average helper with the same push-and-read shape as Avg. */
export function smaPush(w: Win, x: number): number | null {
  push(w, x);
  return full(w) ? mean(w) : null;
}

export function trueRange(bar: Bar, prevClose: number | null): number {
  if (prevClose === null) return bar.high - bar.low;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}
