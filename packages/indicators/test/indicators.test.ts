import type { Candle } from '@chartdeck/shared';
import * as TI from 'technicalindicators';
import { describe, expect, it } from 'vitest';
import {
  INDICATORS, Runner, defaultInputs, pivotLevels, sanitizeInputs, volumeProfile,
  type IndicatorImpl, type Output,
} from '../src/index.ts';
import * as L from '../src/library.ts';

/** Deterministic OHLCV random walk. */
function series(n: number, seed = 7): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Candle[] = [];
  let price = 100;
  const t0 = Date.parse('2026-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + (rnd() - 0.5) * 0.04);
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    out.push({ time: t0 + i * 3_600_000, open, high, low, close, volume: Math.round(100 + rnd() * 900) });
    price = close;
  }
  return out;
}

const bars = series(400);
const run = <S>(impl: IndicatorImpl<S>) => new Runner(impl).compute(bars);
const col = (out: Output[], key: string) => out.map((o) => o[key]).filter((v): v is number => v !== null);
const c = (k: keyof Candle) => bars.map((b) => b[k]);

/** Compare the tail of two series (the oracle may start at a different warm-up index). */
function expectTail(ours: number[], theirs: number[], digits = 8, count = 200) {
  const a = ours.slice(-count);
  const b = theirs.slice(-count);
  expect(a.length).toBe(count);
  a.forEach((v, i) => expect(v, `index ${i} of last ${count}`).toBeCloseTo(b[i]!, digits));
}

describe('hand-computed references', () => {
  const flat = (closes: number[]): Candle[] => closes.map((x, i) => ({ time: i * 60_000, open: x, high: x, low: x, close: x, volume: 10 }));

  it('SMA and EMA (EMA seeded with the SMA of the first N values, as Pine)', () => {
    const b = flat([1, 2, 3, 4, 5, 6]);
    expect(new Runner(L.sma({ length: 3, source: 'close' })).compute(b).map((o) => o.ma)).toEqual([null, null, 2, 3, 4, 5]);
    // alpha = 0.5: seed 2, then 0.5*4 + 0.5*2 = 3, 0.5*5 + 0.5*3 = 4, 0.5*6 + 0.5*4 = 5
    expect(new Runner(L.emaInd({ length: 3, source: 'close' })).compute(b).map((o) => o.ma)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('WMA weights the newest bar most', () => {
    const out = new Runner(L.wma({ length: 3, source: 'close' })).compute(flat([1, 2, 6]));
    expect(out[2]!.ma).toBeCloseTo((1 * 1 + 2 * 2 + 3 * 6) / 6);
  });

  it('RSI is 100 for a rising-only series and 0 for a falling-only one', () => {
    expect(new Runner(L.rsi({ length: 3, source: 'close' })).compute(flat([1, 2, 3, 4, 5])).at(-1)!.rsi).toBe(100);
    expect(new Runner(L.rsi({ length: 3, source: 'close' })).compute(flat([5, 4, 3, 2, 1])).at(-1)!.rsi).toBe(0);
  });

  it('RSI on a known sequence: gains avg 2/3, losses avg 1/3 -> 66.67', () => {
    // changes: +1, +1, -1 -> avg gain 2/3, avg loss 1/3, RS 2, RSI 66.666…
    expect(new Runner(L.rsi({ length: 3, source: 'close' })).compute(flat([10, 11, 12, 11])).at(-1)!.rsi).toBeCloseTo(66.6667, 3);
  });

  it('OBV adds volume on up closes and subtracts on down closes', () => {
    expect(new Runner(L.obv()).compute(flat([1, 2, 2, 1, 3])).map((o) => o.obv)).toEqual([0, 10, 10, 0, 10]);
  });

  it('traditional pivots', () => {
    const p = pivotLevels('traditional', 110, 90, 100);
    expect(p).toMatchObject({ p: 100, r1: 110, s1: 90, r2: 120, s2: 80, r3: 130, s3: 70 });
  });

  it('pivots use the previous day on intraday charts', () => {
    const day = 86_400_000;
    const b: Candle[] = [
      { time: 0, open: 95, high: 110, low: 90, close: 100, volume: 1 },
      { time: day / 2, open: 100, high: 105, low: 95, close: 100, volume: 1 },
      { time: day, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ];
    const out = new Runner(L.pivots({ kind: 'traditional', anchor: 'auto' }, { tf: '1h' })).compute(b);
    expect(out[0]!.p).toBeNull();
    expect(out[2]).toMatchObject({ p: 100, r1: 110, s1: 90 });
  });

  it('VWAP resets at the anchor boundary', () => {
    const day = 86_400_000;
    const b: Candle[] = [
      { time: day - 60_000, open: 10, high: 10, low: 10, close: 10, volume: 5 },
      { time: day, open: 20, high: 20, low: 20, close: 20, volume: 1 },
    ];
    const out = new Runner(L.vwap({ anchor: 'session', source: 'close', mult: 1 })).compute(b);
    expect(out.map((o) => o.vwap)).toEqual([10, 20]);
  });

  it('volume profile finds the POC and a value area around it', () => {
    const b: Candle[] = [
      { time: 0, open: 1, high: 1.05, low: 0.95, close: 1, volume: 100 },
      { time: 1, open: 1, high: 1.05, low: 0.95, close: 1.01, volume: 100 },
      { time: 2, open: 2, high: 2, low: 1.95, close: 1.96, volume: 10 },
    ];
    const vp = volumeProfile(b, 10)!;
    expect(vp.rows[vp.poc]!.low).toBeLessThan(1.05);
    expect(vp.vaHigh).toBeLessThan(5); // value area stays down where the volume is
  });
});

describe('agreement with an independent library (technicalindicators)', () => {
  const close = c('close');
  const high = c('high');
  const low = c('low');
  const volume = c('volume');

  it('SMA', () => expectTail(col(run(L.sma({ length: 20, source: 'close' })), 'ma'), TI.SMA.calculate({ period: 20, values: close })));
  it('EMA', () => expectTail(col(run(L.emaInd({ length: 20, source: 'close' })), 'ma'), TI.EMA.calculate({ period: 20, values: close })));
  it('WMA', () => expectTail(col(run(L.wma({ length: 20, source: 'close' })), 'ma'), TI.WMA.calculate({ period: 20, values: close })));
  it('RSI', () => expectTail(col(run(L.rsi({ length: 14, source: 'close' })), 'rsi'), TI.RSI.calculate({ period: 14, values: close }), 2));
  it('Bollinger Bands', () => {
    const ours = run(L.bollinger({ length: 20, source: 'close', mult: 2 }));
    const theirs = TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: close });
    expectTail(col(ours, 'upper'), theirs.map((x) => x.upper));
    expectTail(col(ours, 'lower'), theirs.map((x) => x.lower));
  });
  it('MACD', () => {
    const ours = run(L.macd({ fast: 12, slow: 26, signal: 9, source: 'close' }));
    const theirs = TI.MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: close, SimpleMAOscillator: false, SimpleMASignal: false });
    expectTail(col(ours, 'macd'), theirs.map((x) => x.MACD!));
    expectTail(col(ours, 'signal'), theirs.filter((x) => x.signal !== undefined).map((x) => x.signal!));
  });
  it('Stochastic', () => {
    const ours = run(L.stochastic({ kLength: 14, kSmooth: 1, dSmooth: 3 }));
    const theirs = TI.Stochastic.calculate({ period: 14, signalPeriod: 3, high, low, close });
    expectTail(col(ours, 'k'), theirs.map((x) => x.k), 6);
    expectTail(col(ours, 'd'), theirs.filter((x) => x.d !== undefined).map((x) => x.d), 6);
  });
  it('ATR', () => expectTail(col(run(L.atr({ length: 14 })), 'atr'), TI.ATR.calculate({ period: 14, high, low, close }), 6));
  it('CCI', () => expectTail(col(run(L.cci({ length: 20, source: 'hlc3' })), 'cci'), TI.CCI.calculate({ period: 20, high, low, close }), 6));
  it('Williams %R', () => expectTail(col(run(L.williamsR({ length: 14 })), 'r'), TI.WilliamsR.calculate({ period: 14, high, low, close }), 6));
  it('MFI', () => expectTail(col(run(L.mfi({ length: 14 })), 'mfi'), TI.MFI.calculate({ period: 14, high, low, close, volume }), 2));
  it('ROC', () => expectTail(col(run(L.roc({ length: 9, source: 'close' })), 'roc'), TI.ROC.calculate({ period: 9, values: close })));
  it('OBV', () => expectTail(col(run(L.obv()), 'obv'), TI.OBV.calculate({ close, volume })));
  it('ADX', () => expectTail(col(run(L.adx({ diLength: 14, adxSmoothing: 14 })), 'adx'), TI.ADX.calculate({ period: 14, high, low, close }).map((x) => x.adx), 6));
  it('Parabolic SAR', () => expectTail(col(run(L.psar({ start: 0.02, increment: 0.02, max: 0.2 })), 'sar'), TI.PSAR.calculate({ step: 0.02, max: 0.2, high, low }), 8));
});

describe('incremental updates equal full recomputation', () => {
  // Every catalog indicator: stream each bar as several live revisions of the open candle,
  // then the final version, and require the same outputs as computing all bars at once.
  const live = series(250, 11);
  for (const meta of INDICATORS) {
    if (!meta.create) continue;
    it(meta.name, () => {
      const impl = meta.create!(defaultInputs(meta), { tf: '1h' });
      const batch = new Runner(impl).compute(live);
      const r = new Runner(meta.create!(defaultInputs(meta), { tf: '1h' }));
      live.forEach((b, i) => {
        // Partial versions of the bar as ticks would build it.
        r.update({ ...b, high: b.open, low: b.open, close: b.open, volume: b.volume * 0.2 });
        r.update({ ...b, close: (b.open + b.close) / 2, volume: b.volume * 0.6 });
        const out = r.update(b)!;
        for (const [k, v] of Object.entries(batch[i]!)) {
          if (v === null) expect(out[k], `${k} @${i}`).toBeNull();
          else expect(out[k], `${k} @${i}`).toBeCloseTo(v, 9);
        }
      });
    });
  }

  it('ignores out-of-order bars', () => {
    const r = new Runner(L.sma({ length: 2, source: 'close' }));
    r.update(live[1]!);
    expect(r.update(live[0]!)).toBeNull();
  });
});

describe('inputs', () => {
  it('sanitizes types and ranges', () => {
    const meta = INDICATORS.find((m) => m.id === 'bb')!;
    expect(sanitizeInputs(meta, { length: '5000', source: 'evil', mult: -3 })).toEqual({ length: 1000, source: 'close', mult: 0 });
  });
});
