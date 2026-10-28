import { bucketStart, TF_MS, type Timeframe } from '@chartdeck/shared';
import {
  avgPush, ema, full, highest, lowest, mean, push, rma, smaPush, source, stdev, sum, trueRange, win, wmean,
  type Avg, type Bar, type IndicatorImpl, type Output, type Source, type Win,
} from './core.ts';

/** Context the host passes to indicators that depend on the chart, e.g. pivots. */
export interface IndicatorContext {
  tf: Timeframe;
}


// ================================================================ moving averages

export const sma = (p: { length: number; source: Source }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length) }),
  step: (s, b) => ({ ma: smaPush(s.w, source(b, p.source)) }),
});

export const emaInd = (p: { length: number; source: Source }): IndicatorImpl<{ a: Avg }> => ({
  init: () => ({ a: ema(p.length) }),
  step: (s, b) => ({ ma: avgPush(s.a, source(b, p.source)) }),
});

export const wma = (p: { length: number; source: Source }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length) }),
  step: (s, b) => {
    push(s.w, source(b, p.source));
    return { ma: full(s.w) ? wmean(s.w) : null };
  },
});

export const vwma = (p: { length: number; source: Source }): IndicatorImpl<{ pv: Win; v: Win }> => ({
  init: () => ({ pv: win(p.length), v: win(p.length) }),
  step: (s, b) => {
    push(s.pv, source(b, p.source) * b.volume);
    push(s.v, b.volume);
    return { ma: full(s.v) && sum(s.v) > 0 ? sum(s.pv) / sum(s.v) : null };
  },
});

/** Hull MA: WMA(2·WMA(n/2) − WMA(n), √n). */
export const hma = (p: { length: number; source: Source }): IndicatorImpl<{ half: Win; whole: Win; out: Win }> => ({
  init: () => ({ half: win(Math.floor(p.length / 2)), whole: win(p.length), out: win(Math.round(Math.sqrt(p.length))) }),
  step: (s, b) => {
    const x = source(b, p.source);
    push(s.half, x);
    push(s.whole, x);
    if (!full(s.whole)) return { ma: null };
    push(s.out, 2 * wmean(s.half) - wmean(s.whole));
    return { ma: full(s.out) ? wmean(s.out) : null };
  },
});

// ================================================================ VWAP

const ANCHOR_TF: Record<'session' | 'week' | 'month', Timeframe> = { session: '1D', week: '1W', month: '1M' };

export const vwap = (p: { anchor: 'session' | 'week' | 'month'; source: Source; mult: number }): IndicatorImpl<{
  period: number; pv: number; v: number; pv2: number;
}> => ({
  init: () => ({ period: -1, pv: 0, v: 0, pv2: 0 }),
  step: (s, b) => {
    const period = bucketStart(ANCHOR_TF[p.anchor], b.time);
    if (period !== s.period) Object.assign(s, { period, pv: 0, v: 0, pv2: 0 });
    const x = source(b, p.source);
    s.pv += x * b.volume;
    s.v += b.volume;
    s.pv2 += x * x * b.volume;
    if (s.v === 0) return { vwap: null, upper: null, lower: null };
    const vw = s.pv / s.v;
    const sd = Math.sqrt(Math.max(0, s.pv2 / s.v - vw * vw));
    return { vwap: vw, upper: vw + p.mult * sd, lower: vw - p.mult * sd };
  },
});

// ================================================================ bands & channels

export const bollinger = (p: { length: number; source: Source; mult: number }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length) }),
  step: (s, b) => {
    push(s.w, source(b, p.source));
    if (!full(s.w)) return { basis: null, upper: null, lower: null };
    const m = mean(s.w);
    const d = p.mult * stdev(s.w);
    return { basis: m, upper: m + d, lower: m - d };
  },
});

export const keltner = (p: { length: number; mult: number; atrLength: number }): IndicatorImpl<{ mid: Avg; range: Avg; pc: number | null }> => ({
  init: () => ({ mid: ema(p.length), range: ema(p.atrLength), pc: null }),
  step: (s, b) => {
    const mid = avgPush(s.mid, b.close);
    const r = avgPush(s.range, trueRange(b, s.pc));
    s.pc = b.close;
    if (mid === null || r === null) return { basis: mid, upper: null, lower: null };
    return { basis: mid, upper: mid + p.mult * r, lower: mid - p.mult * r };
  },
});

export const donchian = (p: { length: number }): IndicatorImpl<{ h: Win; l: Win }> => ({
  init: () => ({ h: win(p.length), l: win(p.length) }),
  step: (s, b) => {
    push(s.h, b.high);
    push(s.l, b.low);
    if (!full(s.h)) return { upper: null, lower: null, basis: null };
    const u = highest(s.h);
    const l = lowest(s.l);
    return { upper: u, lower: l, basis: (u + l) / 2 };
  },
});

// ================================================================ oscillators

interface RsiState {
  prev: number | null;
  up: Avg;
  down: Avg;
}

const rsiInit = (length: number): RsiState => ({ prev: null, up: rma(length), down: rma(length) });

function rsiStep(s: RsiState, x: number): number | null {
  if (s.prev === null) {
    s.prev = x;
    return null;
  }
  const ch = x - s.prev;
  s.prev = x;
  const up = avgPush(s.up, Math.max(ch, 0));
  const down = avgPush(s.down, Math.max(-ch, 0));
  if (up === null || down === null) return null;
  return down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
}

export const rsi = (p: { length: number; source: Source }): IndicatorImpl<RsiState> => ({
  init: () => rsiInit(p.length),
  step: (s, b) => ({ rsi: rsiStep(s, source(b, p.source)) }),
});

export const macd = (p: { fast: number; slow: number; signal: number; source: Source }): IndicatorImpl<{ f: Avg; s: Avg; sig: Avg }> => ({
  init: () => ({ f: ema(p.fast), s: ema(p.slow), sig: ema(p.signal) }),
  step: (st, b) => {
    const x = source(b, p.source);
    const f = avgPush(st.f, x);
    const sl = avgPush(st.s, x);
    if (f === null || sl === null) return { macd: null, signal: null, hist: null };
    const m = f - sl;
    const sig = avgPush(st.sig, m);
    return { macd: m, signal: sig, hist: sig === null ? null : m - sig };
  },
});

export const stochastic = (p: { kLength: number; kSmooth: number; dSmooth: number }): IndicatorImpl<{ h: Win; l: Win; k: Win; d: Win }> => ({
  init: () => ({ h: win(p.kLength), l: win(p.kLength), k: win(p.kSmooth), d: win(p.dSmooth) }),
  step: (s, b) => {
    push(s.h, b.high);
    push(s.l, b.low);
    if (!full(s.h)) return { k: null, d: null };
    const hh = highest(s.h);
    const ll = lowest(s.l);
    if (hh === ll) return { k: null, d: null };
    const k = smaPush(s.k, (100 * (b.close - ll)) / (hh - ll));
    const d = k === null ? null : smaPush(s.d, k);
    return { k, d };
  },
});

export const stochRsi = (p: { rsiLength: number; stochLength: number; kSmooth: number; dSmooth: number; source: Source }): IndicatorImpl<{
  r: RsiState; w: Win; k: Win; d: Win;
}> => ({
  init: () => ({ r: rsiInit(p.rsiLength), w: win(p.stochLength), k: win(p.kSmooth), d: win(p.dSmooth) }),
  step: (s, b) => {
    const r = rsiStep(s.r, source(b, p.source));
    if (r === null) return { k: null, d: null };
    push(s.w, r);
    if (!full(s.w)) return { k: null, d: null };
    const hh = highest(s.w);
    const ll = lowest(s.w);
    if (hh === ll) return { k: null, d: null };
    const k = smaPush(s.k, (100 * (r - ll)) / (hh - ll));
    return { k, d: k === null ? null : smaPush(s.d, k) };
  },
});

export const cci = (p: { length: number; source: Source }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length) }),
  step: (s, b) => {
    const x = source(b, p.source);
    push(s.w, x);
    if (!full(s.w)) return { cci: null };
    const m = mean(s.w);
    const dev = s.w.buf.reduce((a, v) => a + Math.abs(v - m), 0) / s.w.len;
    return { cci: dev === 0 ? null : (x - m) / (0.015 * dev) };
  },
});

export const williamsR = (p: { length: number }): IndicatorImpl<{ h: Win; l: Win }> => ({
  init: () => ({ h: win(p.length), l: win(p.length) }),
  step: (s, b) => {
    push(s.h, b.high);
    push(s.l, b.low);
    if (!full(s.h)) return { r: null };
    const hh = highest(s.h);
    const ll = lowest(s.l);
    return { r: hh === ll ? null : (100 * (b.close - hh)) / (hh - ll) };
  },
});

export const mfi = (p: { length: number }): IndicatorImpl<{ prev: number | null; pos: Win; neg: Win }> => ({
  init: () => ({ prev: null, pos: win(p.length), neg: win(p.length) }),
  step: (s, b) => {
    const tp = (b.high + b.low + b.close) / 3;
    if (s.prev === null) {
      s.prev = tp;
      return { mfi: null };
    }
    const ch = tp - s.prev;
    s.prev = tp;
    push(s.pos, ch > 0 ? tp * b.volume : 0);
    push(s.neg, ch < 0 ? tp * b.volume : 0);
    if (!full(s.pos)) return { mfi: null };
    const up = sum(s.pos);
    const dn = sum(s.neg);
    return { mfi: dn === 0 ? 100 : 100 - 100 / (1 + up / dn) };
  },
});

export const roc = (p: { length: number; source: Source }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length + 1) }),
  step: (s, b) => {
    const x = source(b, p.source);
    push(s.w, x);
    if (!full(s.w)) return { roc: null };
    const then = s.w.buf[0]!;
    return { roc: then === 0 ? null : (100 * (x - then)) / then };
  },
});

export const momentum = (p: { length: number; source: Source }): IndicatorImpl<{ w: Win }> => ({
  init: () => ({ w: win(p.length + 1) }),
  step: (s, b) => {
    const x = source(b, p.source);
    push(s.w, x);
    return { mom: full(s.w) ? x - s.w.buf[0]! : null };
  },
});

export const aroon = (p: { length: number }): IndicatorImpl<{ h: Win; l: Win }> => ({
  init: () => ({ h: win(p.length + 1), l: win(p.length + 1) }),
  step: (s, b) => {
    push(s.h, b.high);
    push(s.l, b.low);
    if (!full(s.h)) return { up: null, down: null };
    // Bars since the extreme; the most recent occurrence wins ties.
    const since = (w: Win, hi: boolean) => {
      let best = 0;
      w.buf.forEach((v, i) => {
        if (hi ? v >= w.buf[best]! : v <= w.buf[best]!) best = i;
      });
      return w.buf.length - 1 - best;
    };
    return { up: (100 * (p.length - since(s.h, true))) / p.length, down: (100 * (p.length - since(s.l, false))) / p.length };
  },
});

// ================================================================ volatility & trend

export const atr = (p: { length: number }): IndicatorImpl<{ pc: number | null; a: Avg }> => ({
  init: () => ({ pc: null, a: rma(p.length) }),
  step: (s, b) => {
    const tr = trueRange(b, s.pc);
    s.pc = b.close;
    return { atr: avgPush(s.a, tr) };
  },
});

/** DMI / ADX as Pine's ta.dmi. */
export const adx = (p: { diLength: number; adxSmoothing: number }): IndicatorImpl<{
  prev: Bar | null; tr: Avg; plus: Avg; minus: Avg; adx: Avg;
}> => ({
  init: () => ({ prev: null, tr: rma(p.diLength), plus: rma(p.diLength), minus: rma(p.diLength), adx: rma(p.adxSmoothing) }),
  step: (s, b) => {
    const prev = s.prev;
    s.prev = { ...b };
    if (!prev) return { adx: null, plusDI: null, minusDI: null };
    const up = b.high - prev.high;
    const down = prev.low - b.low;
    const trur = avgPush(s.tr, trueRange(b, prev.close));
    const plusSm = avgPush(s.plus, up > down && up > 0 ? up : 0);
    const minusSm = avgPush(s.minus, down > up && down > 0 ? down : 0);
    if (trur === null || plusSm === null || minusSm === null || trur === 0) return { adx: null, plusDI: null, minusDI: null };
    const plus = (100 * plusSm) / trur;
    const minus = (100 * minusSm) / trur;
    const total = plus + minus;
    const a = avgPush(s.adx, Math.abs(plus - minus) / (total === 0 ? 1 : total));
    return { adx: a === null ? null : 100 * a, plusDI: plus, minusDI: minus };
  },
});

export const obv = (): IndicatorImpl<{ pc: number | null; v: number }> => ({
  init: () => ({ pc: null, v: 0 }),
  step: (s, b) => {
    if (s.pc !== null) s.v += Math.sign(b.close - s.pc) * b.volume;
    s.pc = b.close;
    return { obv: s.v };
  },
});

export const cmf = (p: { length: number }): IndicatorImpl<{ mfv: Win; v: Win }> => ({
  init: () => ({ mfv: win(p.length), v: win(p.length) }),
  step: (s, b) => {
    const range = b.high - b.low;
    push(s.mfv, range === 0 ? 0 : (((b.close - b.low) - (b.high - b.close)) / range) * b.volume);
    push(s.v, b.volume);
    if (!full(s.v)) return { cmf: null };
    const v = sum(s.v);
    return { cmf: v === 0 ? null : sum(s.mfv) / v };
  },
});

/** Port of Pine's documented ta.supertrend. Direction −1 is an uptrend. */
export const supertrend = (p: { atrLength: number; factor: number }): IndicatorImpl<{
  pc: number | null; atr: Avg; atrPrevValid: boolean; upper: number | null; lower: number | null; st: number | null;
}> => ({
  init: () => ({ pc: null, atr: rma(p.atrLength), atrPrevValid: false, upper: null, lower: null, st: null }),
  step: (s, b) => {
    const a = avgPush(s.atr, trueRange(b, s.pc));
    const prevClose = s.pc;
    s.pc = b.close;
    if (a === null) {
      s.atrPrevValid = false;
      return { up: null, down: null };
    }
    const src = (b.high + b.low) / 2;
    let upper = src + p.factor * a;
    let lower = src - p.factor * a;
    const prevLower = s.lower ?? 0;
    const prevUpper = s.upper ?? 0;
    lower = lower > prevLower || (prevClose ?? 0) < prevLower ? lower : prevLower;
    upper = upper < prevUpper || (prevClose ?? 0) > prevUpper ? upper : prevUpper;
    let dir: 1 | -1;
    if (!s.atrPrevValid) dir = 1;
    else if (s.st === prevUpper) dir = b.close > upper ? -1 : 1;
    else dir = b.close < lower ? 1 : -1;
    const st = dir === -1 ? lower : upper;
    Object.assign(s, { upper, lower, st, atrPrevValid: true });
    return { up: dir === -1 ? st : null, down: dir === 1 ? st : null };
  },
});

/** Port of Pine's documented ta.sar. */
export const psar = (p: { start: number; increment: number; max: number }): IndicatorImpl<{
  i: number; result: number | null; maxMin: number; acc: number; below: boolean; prev: Bar[];
}> => ({
  init: () => ({ i: 0, result: null, maxMin: 0, acc: 0, below: false, prev: [] }),
  step: (s, b) => {
    const [b1, b2] = [s.prev[s.prev.length - 1], s.prev[s.prev.length - 2]];
    const idx = s.i++;
    const remember = () => {
      s.prev.push({ ...b });
      if (s.prev.length > 2) s.prev.shift();
    };
    if (idx === 0) {
      remember();
      return { sar: null };
    }
    let first = false;
    if (idx === 1) {
      if (b.close > b1!.close) {
        s.below = true;
        s.maxMin = b.high;
        s.result = b1!.low;
      } else {
        s.below = false;
        s.maxMin = b.low;
        s.result = b1!.high;
      }
      first = true;
      s.acc = p.start;
    }
    let r = s.result! + s.acc * (s.maxMin - s.result!);
    if (s.below) {
      if (r > b.low) {
        first = true;
        s.below = false;
        r = Math.max(b.high, s.maxMin);
        s.maxMin = b.low;
        s.acc = p.start;
      }
    } else if (r < b.high) {
      first = true;
      s.below = true;
      r = Math.min(b.low, s.maxMin);
      s.maxMin = b.high;
      s.acc = p.start;
    }
    if (!first) {
      if (s.below) {
        if (b.high > s.maxMin) {
          s.maxMin = b.high;
          s.acc = Math.min(s.acc + p.increment, p.max);
        }
      } else if (b.low < s.maxMin) {
        s.maxMin = b.low;
        s.acc = Math.min(s.acc + p.increment, p.max);
      }
    }
    if (s.below) {
      r = Math.min(r, b1!.low);
      if (idx > 1) r = Math.min(r, b2!.low);
    } else {
      r = Math.max(r, b1!.high);
      if (idx > 1) r = Math.max(r, b2!.high);
    }
    s.result = r;
    remember();
    return { sar: r };
  },
});

export const ichimoku = (p: { conversion: number; base: number; spanB: number }): IndicatorImpl<{
  ch: Win; cl: Win; bh: Win; bl: Win; sh: Win; sl: Win;
}> => ({
  init: () => ({ ch: win(p.conversion), cl: win(p.conversion), bh: win(p.base), bl: win(p.base), sh: win(p.spanB), sl: win(p.spanB) }),
  step: (s, b) => {
    for (const [h, l] of [[s.ch, s.cl], [s.bh, s.bl], [s.sh, s.sl]] as const) {
      push(h, b.high);
      push(l, b.low);
    }
    const mid = (h: Win, l: Win) => (full(h) ? (highest(h) + lowest(l)) / 2 : null);
    const conv = mid(s.ch, s.cl);
    const base = mid(s.bh, s.bl);
    return {
      conversion: conv,
      base,
      spanA: conv !== null && base !== null ? (conv + base) / 2 : null,
      spanB: mid(s.sh, s.sl),
      lagging: b.close,
    };
  },
});

// ================================================================ pivots

export type PivotKind = 'traditional' | 'fibonacci' | 'camarilla';
export type PivotAnchor = 'auto' | 'day' | 'week' | 'month';

export function pivotLevels(kind: PivotKind, h: number, l: number, c: number): Output {
  const p = (h + l + c) / 3;
  const r = h - l;
  switch (kind) {
    case 'fibonacci':
      return { p, r1: p + 0.382 * r, r2: p + 0.618 * r, r3: p + r, s1: p - 0.382 * r, s2: p - 0.618 * r, s3: p - r };
    case 'camarilla':
      return { p, r1: c + (1.1 * r) / 12, r2: c + (1.1 * r) / 6, r3: c + (1.1 * r) / 4, s1: c - (1.1 * r) / 12, s2: c - (1.1 * r) / 6, s3: c - (1.1 * r) / 4 };
    default:
      return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + r, s2: p - r, r3: h + 2 * (p - l), s3: l - 2 * (h - p) };
  }
}

function pivotPeriodTf(anchor: PivotAnchor, tf: Timeframe): Timeframe {
  if (anchor === 'day') return '1D';
  if (anchor === 'week') return '1W';
  if (anchor === 'month') return '1M';
  return TF_MS[tf] < TF_MS['1D'] ? '1D' : tf === '1D' ? '1W' : '1M';
}

const EMPTY_PIVOTS: Output = { p: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };

/** Levels for each bar come from the previous anchor period's high, low and close. */
export const pivots = (p: { kind: PivotKind; anchor: PivotAnchor }, ctx: IndicatorContext): IndicatorImpl<{
  period: number; h: number; l: number; c: number; prev: [number, number, number] | null;
}> => {
  const ptf = pivotPeriodTf(p.anchor, ctx.tf);
  return {
    init: () => ({ period: -1, h: -Infinity, l: Infinity, c: 0, prev: null }),
    step: (s, b) => {
      const period = bucketStart(ptf, b.time);
      if (period !== s.period) {
        if (s.period !== -1) s.prev = [s.h, s.l, s.c];
        Object.assign(s, { period, h: -Infinity, l: Infinity });
      }
      s.h = Math.max(s.h, b.high);
      s.l = Math.min(s.l, b.low);
      s.c = b.close;
      return s.prev ? pivotLevels(p.kind, ...s.prev) : EMPTY_PIVOTS;
    },
  };
};

// ================================================================ volume profile (visible range)

export interface ProfileRow {
  low: number;
  high: number;
  up: number;
  down: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  poc: number;
  vaLow: number;
  vaHigh: number;
  maxVolume: number;
}

/**
 * Volume by price over `bars`. Each bar's volume is spread evenly across the rows its
 * high-low range covers; the value area grows outward from the point of control until it holds
 * `valueArea` of the total.
 */
export function volumeProfile(bars: readonly Bar[], rowCount: number, valueArea = 0.7): VolumeProfile | null {
  if (!bars.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
  }
  if (!(hi > lo)) hi = lo + 1e-9;
  const step = (hi - lo) / rowCount;
  const rows: ProfileRow[] = Array.from({ length: rowCount }, (_, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, up: 0, down: 0 }));
  for (const b of bars) {
    const a = Math.min(rowCount - 1, Math.floor((b.low - lo) / step));
    const z = Math.min(rowCount - 1, Math.floor((b.high - lo) / step));
    const share = b.volume / (z - a + 1);
    for (let i = a; i <= z; i++) {
      if (b.close >= b.open) rows[i]!.up += share;
      else rows[i]!.down += share;
    }
  }
  const vol = rows.map((r) => r.up + r.down);
  const total = vol.reduce((x, y) => x + y, 0);
  let poc = 0;
  vol.forEach((v, i) => {
    if (v > vol[poc]!) poc = i;
  });
  let vaLow = poc;
  let vaHigh = poc;
  let acc = vol[poc]!;
  while (acc < total * valueArea && (vaLow > 0 || vaHigh < rowCount - 1)) {
    const below = vaLow > 0 ? vol[vaLow - 1]! : -1;
    const above = vaHigh < rowCount - 1 ? vol[vaHigh + 1]! : -1;
    if (above >= below) acc += vol[++vaHigh]!;
    else acc += vol[--vaLow]!;
  }
  return { rows, poc, vaLow, vaHigh, maxVolume: vol[poc]! };
}

