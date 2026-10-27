import { describe, expect, it } from 'vitest';
import { SymbolAggregator } from '../src/index.ts';

const T0 = Date.parse('2026-10-27T10:00:00Z');

describe('SymbolAggregator', () => {
  it('builds OHLCV within a bucket', () => {
    const a = new SymbolAggregator(['1m']);
    a.applyTrade({ price: 100, qty: 1, time: T0 + 1_000 });
    a.applyTrade({ price: 105, qty: 2, time: T0 + 2_000 });
    a.applyTrade({ price: 98, qty: 0.5, time: T0 + 3_000 });
    a.applyTrade({ price: 101, qty: 1.5, time: T0 + 59_999 });
    expect(a.get('1m')).toEqual({ time: T0, open: 100, high: 105, low: 98, close: 101, volume: 5 });
  });

  it('opens a new candle when a trade lands in the next bucket', () => {
    const a = new SymbolAggregator(['1m']);
    a.applyTrade({ price: 100, qty: 1, time: T0 });
    a.applyTrade({ price: 110, qty: 3, time: T0 + 60_000 });
    expect(a.get('1m')).toEqual({ time: T0 + 60_000, open: 110, high: 110, low: 110, close: 110, volume: 3 });
  });

  it('updates every timeframe from one trade stream', () => {
    const a = new SymbolAggregator(['1s', '1m', '1h', '1D']);
    a.applyTrade({ price: 50, qty: 1, time: T0 + 1_500 });
    a.applyTrade({ price: 60, qty: 1, time: T0 + 61_500 });
    expect(a.get('1s')!.time).toBe(T0 + 61_000);
    expect(a.get('1m')).toMatchObject({ time: T0 + 60_000, open: 60, volume: 1 });
    expect(a.get('1h')).toMatchObject({ time: T0, open: 50, high: 60, close: 60, volume: 2 });
    expect(a.get('1D')).toMatchObject({ time: Date.parse('2026-10-27T00:00:00Z'), volume: 2 });
  });

  it('ignores late trades for buckets that already closed', () => {
    const a = new SymbolAggregator(['1m']);
    a.applyTrade({ price: 100, qty: 1, time: T0 + 60_000 });
    a.applyTrade({ price: 1, qty: 99, time: T0 + 59_000 });
    expect(a.get('1m')).toMatchObject({ time: T0 + 60_000, low: 100, volume: 1 });
  });

  it('rolls empty intervals into flat zero-volume candles, then reopens on the first trade', () => {
    const a = new SymbolAggregator(['1s']);
    a.applyTrade({ price: 100, qty: 1, time: T0 + 200 });
    expect(a.rollTo(T0 + 999)).toBe(false);
    expect(a.rollTo(T0 + 3_100)).toBe(true);
    expect(a.get('1s')).toEqual({ time: T0 + 3_000, open: 100, high: 100, low: 100, close: 100, volume: 0 });
    a.applyTrade({ price: 103, qty: 2, time: T0 + 3_500 });
    expect(a.get('1s')).toEqual({ time: T0 + 3_000, open: 103, high: 103, low: 103, close: 103, volume: 2 });
  });

  it('buffers during seeding and replays only trades after the cutoff', () => {
    const a = new SymbolAggregator(['1m']);
    a.beginSeed();
    expect(a.applyTrade({ price: 101, qty: 1, time: T0 + 10_000 })).toBe(false); // already inside the REST snapshot
    a.applyTrade({ price: 120, qty: 2, time: T0 + 20_000 });
    expect(a.get('1m')).toBeUndefined();
    a.completeSeed({ '1m': { time: T0, open: 100, high: 102, low: 99, close: 101, volume: 7 } }, T0 + 15_000);
    expect(a.isSeeding).toBe(false);
    expect(a.get('1m')).toEqual({ time: T0, open: 100, high: 120, low: 99, close: 120, volume: 9 });
  });

  it('treats a zero-volume seed as empty so the first trade sets the open', () => {
    const a = new SymbolAggregator(['1s']);
    a.beginSeed();
    a.completeSeed({ '1s': { time: T0, open: 50, high: 50, low: 50, close: 50, volume: 0 } }, T0);
    a.applyTrade({ price: 52, qty: 1, time: T0 + 400 });
    expect(a.get('1s')).toEqual({ time: T0, open: 52, high: 52, low: 52, close: 52, volume: 1 });
  });

  it('snapshot returns compact tuples for every open timeframe', () => {
    const a = new SymbolAggregator(['1m', '5m']);
    a.applyTrade({ price: 10, qty: 1, time: T0 });
    expect(a.snapshot()).toEqual({ '1m': [T0, 10, 10, 10, 10, 1], '5m': [T0, 10, 10, 10, 10, 1] });
  });
});
