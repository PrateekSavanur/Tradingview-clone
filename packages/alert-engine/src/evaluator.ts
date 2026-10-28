import { INDICATOR_BY_ID, Runner, type Output } from '@chartdeck/indicators';
import type { AlertOperator, AlertSpec, AlertTarget, Candle } from '@chartdeck/shared';
import { seriesKey } from './spec.ts';

/** Source (x) and target (y) at one point in time. */
export interface Pair {
  x: number;
  y: number;
}

/** A met condition. `bar` is the open time of the bar it was met on. */
export interface Fire {
  bar: number;
  price: number;
  x: number;
  y: number;
}

/** Pine's ta.crossover / ta.crossunder: strictly past the target now, at or on the other side before. */
export function conditionMet(op: AlertOperator, prev: Pair | null, cur: Pair): boolean {
  switch (op) {
    case 'greater':
      return cur.x > cur.y;
    case 'less':
      return cur.x < cur.y;
    case 'crossing_up':
      return !!prev && prev.x <= prev.y && cur.x > cur.y;
    case 'crossing_down':
      return !!prev && prev.x >= prev.y && cur.x < cur.y;
    case 'crossing':
      return !!prev && ((prev.x <= prev.y && cur.x > cur.y) || (prev.x >= prev.y && cur.x < cur.y));
  }
}

/**
 * Evaluates one alert over its symbol's candles on the alert timeframe. Feed it history once
 * (`warm`), then every live update of the open candle (`update`). Crossings are measured
 * tick to tick for intrabar alerts, and bar close to bar close for `once_per_bar_close`.
 */
export class AlertEvaluator {
  private readonly runners = new Map<string, Runner>();
  private outputs = new Map<string, Output>();
  private barTime = -Infinity;
  private lastPrice = NaN;
  /** Values after the latest update of the current bar. */
  private tick: Pair | null = null;
  /** Values at the close of the previous bar. */
  private closed: Pair | null = null;
  private firedBar = -Infinity;

  constructor(private readonly spec: AlertSpec) {
    for (const s of [spec.source, spec.target]) {
      if (s.kind !== 'indicator') continue;
      const key = seriesKey(s);
      const meta = INDICATOR_BY_ID.get(s.type);
      if (!this.runners.has(key) && meta?.create) this.runners.set(key, new Runner(meta.create(s.inputs, { tf: spec.tf })));
    }
  }

  /** Bars of history needed before values are meaningful (0 for price against a constant). */
  get needsHistory(): boolean {
    return this.runners.size > 0 || this.spec.frequency === 'once_per_bar_close';
  }

  /** Last bar open time seen; live updates older than this are ignored. */
  get lastBar(): number {
    return this.barTime;
  }

  /** Compute over history (ascending; the last bar may still be open). Resets all state. */
  warm(bars: readonly Candle[]): void {
    const n = bars.length;
    this.tick = this.closed = null;
    this.barTime = -Infinity;
    if (!n) return;
    const all = new Map<string, Output[]>();
    for (const [key, r] of this.runners) all.set(key, r.compute(bars));
    const at = (i: number): Pair | null => {
      this.outputs = new Map([...all].map(([k, outs]) => [k, outs[i]!]));
      return this.pair(bars[i]!.close);
    };
    this.closed = n > 1 ? at(n - 2) : null;
    this.tick = at(n - 1);
    this.barTime = bars[n - 1]!.time;
    this.lastPrice = bars[n - 1]!.close;
  }

  /** Feed the latest state of the open candle (or a new one). Returns a fire, or null. */
  update(c: Candle): Fire | null {
    if (c.time < this.barTime) return null;
    let fire: Fire | null = null;
    if (c.time > this.barTime && this.barTime !== -Infinity) {
      // The previous bar closed with the values of its last update.
      if (this.spec.frequency === 'once_per_bar_close' && this.tick && conditionMet(this.spec.operator, this.closed, this.tick)) {
        fire = { bar: this.barTime, price: this.lastPrice, ...this.tick };
      }
      this.closed = this.tick;
    }
    this.barTime = c.time;
    this.lastPrice = c.close;
    for (const [key, r] of this.runners) {
      const out = r.update(c);
      if (out) this.outputs.set(key, out);
    }
    const cur = this.pair(c.close);
    if (!cur) return fire;
    if (this.spec.frequency !== 'once_per_bar_close' && this.firedBar !== c.time && conditionMet(this.spec.operator, this.tick, cur)) {
      this.firedBar = c.time;
      fire = { bar: c.time, price: c.close, ...cur };
    }
    this.tick = cur;
    return fire;
  }

  private value(s: AlertSpec['source'] | AlertTarget, close: number): number | null {
    if (s.kind === 'price') return close;
    if (s.kind === 'value') return s.value;
    const v = this.outputs.get(seriesKey(s))?.[s.plot];
    return v === undefined || v === null || !Number.isFinite(v) ? null : v;
  }

  private pair(close: number): Pair | null {
    const x = this.value(this.spec.source, close);
    const y = this.value(this.spec.target, close);
    return x === null || y === null ? null : { x, y };
  }
}
