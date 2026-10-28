import type { AlertSpec, Candle } from '@chartdeck/shared';
import { describe, expect, it } from 'vitest';
import { AlertEvaluator, AlertSpecError, conditionMet, describeAlert, normalizeSpec } from '../src/index.ts';

const M = 60_000;
const T0 = Date.parse('2026-10-28T10:00:00Z');
const btc = { id: 'binance:BTCUSDT', provider: 'binance', ticker: 'BTCUSDT', description: 'BTC / USDT', exchange: 'Binance', type: 'crypto' as const, tickSize: 0.01 };
const candle = (i: number, close: number, open = close): Candle => ({ time: T0 + i * M, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 });

const spec = (patch: Partial<AlertSpec> = {}): AlertSpec => ({
  symbol: btc, tf: '1m', source: { kind: 'price' }, operator: 'crossing_up', target: { kind: 'value', value: 100 },
  frequency: 'once_per_bar', expiresAt: null, message: '', notify: { email: false }, ...patch,
});

/** Feed live ticks, collecting fires. */
function run(ev: AlertEvaluator, ticks: Array<[bar: number, close: number]>) {
  return ticks.map(([i, c]) => ev.update(candle(i, c))).filter((f) => f !== null);
}

describe('conditionMet', () => {
  it('follows Pine crossover/crossunder: touching then moving past counts once', () => {
    expect(conditionMet('crossing_up', { x: 99, y: 100 }, { x: 101, y: 100 })).toBe(true);
    expect(conditionMet('crossing_up', { x: 100, y: 100 }, { x: 101, y: 100 })).toBe(true);
    expect(conditionMet('crossing_up', { x: 99, y: 100 }, { x: 100, y: 100 })).toBe(false);
    expect(conditionMet('crossing_up', null, { x: 101, y: 100 })).toBe(false);
    expect(conditionMet('crossing_down', { x: 101, y: 100 }, { x: 99, y: 100 })).toBe(true);
    expect(conditionMet('crossing', { x: 101, y: 100 }, { x: 99, y: 100 })).toBe(true);
    expect(conditionMet('greater', null, { x: 101, y: 100 })).toBe(true);
    expect(conditionMet('less', null, { x: 101, y: 100 })).toBe(false);
  });
});

describe('AlertEvaluator', () => {
  it('fires intrabar when price crosses, at most once per bar', () => {
    const ev = new AlertEvaluator(spec());
    ev.warm([candle(0, 95), candle(1, 98)]);
    const fires = run(ev, [[1, 99], [1, 101], [1, 99], [1, 102], [2, 99], [2, 103]]);
    expect(fires.map((f) => [(f.bar - T0) / M, f.price])).toEqual([[1, 101], [2, 103]]);
  });

  it('carries the price path across a bar boundary', () => {
    const ev = new AlertEvaluator(spec({ operator: 'crossing_down' }));
    ev.warm([candle(0, 105)]);
    // Last tick of bar 0 was 105; first tick of bar 1 at 97 is a cross.
    expect(run(ev, [[1, 97]])).toHaveLength(1);
  });

  it('needs a previous value before a crossing can fire', () => {
    const ev = new AlertEvaluator(spec());
    expect(run(ev, [[0, 101]])).toHaveLength(0);
    expect(run(ev, [[0, 99], [0, 101]])).toHaveLength(1);
  });

  it('on bar close, compares closed bars only and ignores intrabar excursions', () => {
    const ev = new AlertEvaluator(spec({ frequency: 'once_per_bar_close' }));
    ev.warm([candle(0, 95), candle(1, 96)]);
    // Bar 1 spikes above 100 intrabar but closes at 98: nothing. Bar 2 closes at 101: fire when bar 3 opens.
    expect(run(ev, [[1, 104], [1, 98], [2, 99], [2, 101]])).toHaveLength(0);
    const [f] = run(ev, [[3, 101]]);
    expect(f && [(f.bar - T0) / M, f.price, f.x]).toEqual([2, 101, 101]);
  });

  it('ignores updates older than the current bar', () => {
    const ev = new AlertEvaluator(spec({ operator: 'greater' }));
    ev.warm([candle(5, 95)]);
    expect(run(ev, [[4, 120]])).toHaveLength(0);
    expect(run(ev, [[5, 120]])).toHaveLength(1);
  });

  it('evaluates indicator plots incrementally, matching a full recompute', () => {
    // SMA(3) crossing up through price: price falls below its 3-bar average.
    const s = spec({ source: { kind: 'indicator', type: 'sma', inputs: { length: 3, source: 'close' }, plot: 'ma' }, target: { kind: 'price' } });
    const ev = new AlertEvaluator(s);
    ev.warm([candle(0, 10), candle(1, 11), candle(2, 12), candle(3, 13)]);
    // SMA at bar 4 with close 9 → (12+13+9)/3 = 11.33 > 9: SMA crossed above price.
    const [f] = run(ev, [[4, 14], [4, 9]]);
    expect(f?.price).toBe(9);
    expect(f?.x).toBeCloseTo((12 + 13 + 9) / 3, 10);
  });

  it('compares two plots of one indicator through one computation', () => {
    const macd = (plot: string) => ({ kind: 'indicator' as const, type: 'macd', inputs: { fast: 3, slow: 6, signal: 3, source: 'close' }, plot });
    const ev = new AlertEvaluator(spec({ source: macd('macd'), target: macd('signal'), operator: 'crossing', frequency: 'once_per_bar_close' }));
    const bars = Array.from({ length: 40 }, (_, i) => candle(i, 100 + 10 * Math.sin(i / 3)));
    ev.warm(bars.slice(0, 20));
    const fires = bars.slice(20).map((b) => ev.update(b)).filter(Boolean);
    expect(fires.length).toBeGreaterThan(0);
  });
});

describe('normalizeSpec', () => {
  const now = T0;
  it('clamps indicator inputs and rejects unknown indicators, plots and shifted plots', () => {
    const s = normalizeSpec(spec({ source: { kind: 'indicator', type: 'rsi', inputs: { length: 99999, source: 'close' }, plot: 'rsi' } }), now);
    expect(s.source.kind === 'indicator' && s.source.inputs.length).toBe(1000);
    expect(() => normalizeSpec(spec({ source: { kind: 'indicator', type: 'nope', inputs: {}, plot: 'x' } }), now)).toThrow(AlertSpecError);
    expect(() => normalizeSpec(spec({ source: { kind: 'indicator', type: 'rsi', inputs: {}, plot: 'nope' } }), now)).toThrow(AlertSpecError);
    expect(() => normalizeSpec(spec({ source: { kind: 'indicator', type: 'ichimoku', inputs: {}, plot: 'spanA' } }), now)).toThrow(AlertSpecError);
    expect(() => normalizeSpec(spec({ source: { kind: 'indicator', type: 'vpvr', inputs: {}, plot: 'poc' } }), now)).toThrow(AlertSpecError);
  });

  it('checks expiry and rejects price against price', () => {
    expect(() => normalizeSpec(spec({ expiresAt: now - 1 }), now)).toThrow(AlertSpecError);
    expect(() => normalizeSpec(spec({ expiresAt: now + 400 * 86_400_000 }), now)).toThrow(AlertSpecError);
    expect(normalizeSpec(spec({ expiresAt: now + 86_400_000 }), now).expiresAt).toBe(now + 86_400_000);
    expect(() => normalizeSpec(spec({ target: { kind: 'price' } }), now)).toThrow();
  });

  it('describes alerts readably', () => {
    expect(describeAlert(spec())).toBe('BTCUSDT 1m: Price crossing up 100');
    const macd = { kind: 'indicator' as const, type: 'macd', inputs: { fast: 12, slow: 26, signal: 9, source: 'close' }, plot: 'macd' };
    expect(describeAlert(spec({ source: macd, target: { ...macd, plot: 'signal' }, operator: 'crossing' }))).toBe(
      'BTCUSDT 1m: MACD(12, 26, 9, close) · MACD crossing MACD(12, 26, 9, close) · Signal',
    );
  });
});
