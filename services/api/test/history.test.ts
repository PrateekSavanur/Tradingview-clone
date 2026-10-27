import type { MarketDataProvider } from '@chartdeck/data-providers';
import { createLogger } from '@chartdeck/service-kit';
import type { Candle, Timeframe } from '@chartdeck/shared';
import { describe, expect, it, vi } from 'vitest';
import { HistoryService, isContiguous, type CandleCache } from '../src/history.ts';

const M = 60_000;
const NOW = Date.parse('2026-10-27T10:30:30Z');
const c = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const log = createLogger('test');
log.level = 'silent';

function setup(cached: Candle[] = []) {
  const getCandles = vi.fn(async (_t: string, _tf: Timeframe, q: { endTime?: number; limit: number }) => {
    const end = q.endTime ?? Math.floor(NOW / M) * M;
    return Array.from({ length: q.limit }, (_, i) => c(end - (q.limit - 1 - i) * M));
  });
  const provider = { id: 'x', getCandles } as unknown as MarketDataProvider;
  const upsert = vi.fn(async () => {});
  const cache: CandleCache = {
    before: async (_p, _s, _tf, end, limit) => cached.filter((k) => k.time <= end).slice(-limit),
    upsert,
  };
  const svc = new HistoryService(new Map([['x', provider]]), cache, log, () => NOW);
  return { svc, getCandles, upsert };
}

describe('isContiguous', () => {
  it('detects gaps and a wrong last bucket', () => {
    expect(isContiguous('1m', [c(0), c(M), c(2 * M)], 2 * M)).toBe(true);
    expect(isContiguous('1m', [c(0), c(2 * M)], 2 * M)).toBe(false);
    expect(isContiguous('1m', [c(0), c(M)], 2 * M)).toBe(false);
  });
});

describe('HistoryService', () => {
  it('always fetches the latest page from the provider and caches only closed candles', async () => {
    const { svc, getCandles, upsert } = setup();
    const res = await svc.get('x', 'T', '1m', undefined, 3);
    expect(res.source).toBe('provider');
    expect(getCandles).toHaveBeenCalledWith('T', '1m', { endTime: undefined, limit: 3 });
    const written = (upsert.mock.calls[0] as unknown as [string, string, string, Candle[]])[3];
    expect(written.map((k) => k.time)).toEqual([NOW - 30_000 - 2 * M, NOW - 30_000 - M]);
  });

  it('serves an older page from cache when it is complete and contiguous', async () => {
    const to = Date.parse('2026-10-27T10:00:00Z');
    const cached = [c(to - 3 * M), c(to - 2 * M), c(to - M)];
    const { svc, getCandles } = setup(cached);
    const res = await svc.get('x', 'T', '1m', to, 3);
    expect(res).toEqual({ source: 'cache', candles: cached });
    expect(getCandles).not.toHaveBeenCalled();
  });

  it('falls back to the provider when the cached run has a gap', async () => {
    const to = Date.parse('2026-10-27T10:00:00Z');
    const { svc, getCandles } = setup([c(to - 4 * M), c(to - 2 * M), c(to - M)]);
    const res = await svc.get('x', 'T', '1m', to, 3);
    expect(res.source).toBe('provider');
    expect(getCandles).toHaveBeenCalledWith('T', '1m', { endTime: to - M, limit: 3 });
  });

  it('coalesces concurrent identical requests', async () => {
    const { svc, getCandles } = setup();
    await Promise.all([svc.get('x', 'T', '1m', undefined, 5), svc.get('x', 'T', '1m', undefined, 5)]);
    expect(getCandles).toHaveBeenCalledTimes(1);
  });
});
