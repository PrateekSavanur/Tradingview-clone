import { afterEach, describe, expect, it, vi } from 'vitest';
import { YahooClient, YahooMarketProvider } from '../src/index.ts';
import {
  intradayBucket, localDate, parseBars, rekey, resample, sessionOpen, type ChartResult,
} from '../src/yahoo/bars.ts';
import { INDIA, US } from '../src/yahoo/markets.ts';

const NSE = { tz: 'Asia/Kolkata', open: '09:15' };
const NY = { tz: 'America/New_York', open: '09:30' };
const MIN = 60_000;
const H = 60 * MIN;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

/** A chart result from bars given as [epoch ms, o, h, l, c, v]. */
function chart(rows: Array<[number, number, number, number, number, number]>, meta: Partial<ChartResult['meta']> = {}): ChartResult {
  return {
    meta: { symbol: 'X', exchangeName: 'NSI', ...meta },
    timestamp: rows.map((r) => r[0] / 1000),
    indicators: {
      quote: [{
        open: rows.map((r) => r[1]), high: rows.map((r) => r[2]), low: rows.map((r) => r[3]),
        close: rows.map((r) => r[4]), volume: rows.map((r) => r[5]),
      }],
    },
  };
}

describe('session maths', () => {
  it('finds the session open in UTC, following US daylight saving', () => {
    expect(sessionOpen(utc(2026, 11, 26, 8), NSE)).toBe(utc(2026, 11, 26, 3, 45));
    expect(sessionOpen(utc(2026, 11, 25, 18), NY)).toBe(utc(2026, 11, 25, 14, 30)); // EST
    expect(sessionOpen(utc(2026, 7, 15, 18), NY)).toBe(utc(2026, 7, 15, 13, 30)); // EDT
  });

  it('anchors intraday buckets at the session open, not the hour', () => {
    // NSE 10:20 IST is in the 10:15 hourly bar.
    expect(intradayBucket(utc(2026, 11, 26, 4, 50), H, NSE)).toBe(utc(2026, 11, 26, 4, 45));
    // NYSE 15:45 EDT is in the 15:30 two-hour bar (09:30, 11:30, 13:30, 15:30).
    expect(intradayBucket(utc(2026, 7, 15, 19, 45), 2 * H, NY)).toBe(utc(2026, 7, 15, 19, 30));
    expect(intradayBucket(utc(2026, 11, 26, 3, 47), 15 * MIN, NSE)).toBe(utc(2026, 11, 26, 3, 45));
  });

  it('keys daily bars by the exchange-local date at UTC midnight', () => {
    expect(localDate(utc(2026, 11, 26, 3, 45), NSE.tz)).toBe(utc(2026, 11, 26));
    expect(localDate(utc(2026, 11, 25, 14, 30), NY.tz)).toBe(utc(2026, 11, 25));
    // 20:00 EST is still the 25th in New York though it is the 26th in UTC.
    expect(localDate(utc(2026, 11, 26, 1, 0), NY.tz)).toBe(utc(2026, 11, 25));
  });
});

describe('bar shaping', () => {
  it('drops null rows', () => {
    const r = chart([[utc(2026, 11, 26, 3, 45), 1, 2, 0.5, 1.5, 10]]);
    r.timestamp!.push(utc(2026, 11, 26, 3, 46) / 1000);
    for (const k of ['open', 'high', 'low', 'close', 'volume'] as const) r.indicators.quote[0]![k]!.push(null);
    expect(parseBars(r)).toHaveLength(1);
  });

  it('re-keys the in-progress bar Yahoo stamps with the last trade time', () => {
    const key = (t: number) => intradayBucket(t, H, NSE);
    const bars = parseBars(chart([
      [utc(2026, 11, 26, 3, 45), 100, 105, 99, 104, 1000],
      [utc(2026, 11, 26, 4, 45), 104, 106, 103, 105, 800],
      [utc(2026, 11, 26, 5, 12), 104, 107, 103, 106, 900], // same 10:15 bar, later snapshot
    ]));
    const out = rekey(bars, key);
    expect(out.map((b) => b.time)).toEqual([utc(2026, 11, 26, 3, 45), utc(2026, 11, 26, 4, 45)]);
    expect(out[1]).toMatchObject({ close: 106, volume: 900 });
  });

  it('resamples 1-minute bars into session-anchored 3-minute bars', () => {
    const t0 = utc(2026, 11, 26, 3, 45);
    const bars = parseBars(chart([0, 1, 2, 3].map((i) => [t0 + i * MIN, 10 + i, 11 + i, 9 + i, 10.5 + i, 100] as [number, number, number, number, number, number])));
    const out = resample(bars, (t) => intradayBucket(t, 3 * MIN, NSE));
    expect(out).toEqual([
      { time: t0, open: 10, high: 13, low: 9, close: 12.5, volume: 300 },
      { time: t0 + 3 * MIN, open: 13, high: 14, low: 12, close: 13.5, volume: 100 },
    ]);
  });
});

/** A YahooClient stand-in answering from canned chart results keyed by interval|range. */
function fakeClient(charts: Record<string, ChartResult>) {
  const calls: string[] = [];
  const client = {
    chart: async (_s: string, p: { interval: string; range: string }) => {
      calls.push(`${p.interval}|${p.range}`);
      const r = charts[`${p.interval}|${p.range}`];
      if (!r) throw new Error(`no fixture for ${p.interval}|${p.range}`);
      return r;
    },
    search: async () => [
      { symbol: 'TCS.BO', shortname: 'TCS', exchange: 'BSE', quoteType: 'EQUITY' },
      { symbol: 'TCS.NS', longname: 'Tata Consultancy Services Limited', exchange: 'NSI', quoteType: 'EQUITY' },
      { symbol: 'TCS', shortname: 'TCS US', exchange: 'NYQ', quoteType: 'EQUITY' },
      { symbol: 'TCSMF', exchange: 'NSI', quoteType: 'MUTUALFUND' },
    ],
  } as unknown as YahooClient;
  return { client, calls };
}

describe('YahooMarketProvider', () => {
  it('filters search results to its market and prefers NSE listings', async () => {
    const { client } = fakeClient({});
    const india = new YahooMarketProvider(INDIA, client);
    const us = new YahooMarketProvider(US, client);
    expect((await india.searchSymbols('tcs', 10)).map((s) => s.id)).toEqual(['india:TCS.NS', 'india:TCS.BO']);
    expect((await us.searchSymbols('tcs', 10)).map((s) => s.id)).toEqual(['us:TCS']);
    expect((await india.searchSymbols('', 3)).map((s) => s.ticker)).toEqual(['^NSEI', '^BSESN', '^NSEBANK']);
  });

  it('builds 2h history from hourly bars and honours endTime', async () => {
    const d = (h: number, m: number) => utc(2026, 11, 26, h, m);
    const { client } = fakeClient({
      '60m|730d': chart([
        [d(3, 45), 100, 101, 99, 100.5, 10], [d(4, 45), 100.5, 103, 100, 102, 20],
        [d(5, 45), 102, 102, 98, 99, 30], [d(6, 45), 99, 100, 97, 98, 40],
      ]),
    });
    const p = new YahooMarketProvider(INDIA, client);
    const bars = await p.getCandles('RELIANCE.NS', '2h', { limit: 10 });
    expect(bars).toEqual([
      { time: d(3, 45), open: 100, high: 103, low: 99, close: 102, volume: 30 },
      { time: d(5, 45), open: 102, high: 102, low: 97, close: 98, volume: 70 },
    ]);
    expect(await p.getCandles('RELIANCE.NS', '2h', { limit: 10, endTime: d(4, 0) })).toHaveLength(1);
  });

  it('snapshots every timeframe from one day of 1-minute bars plus cached daily history', async () => {
    const t0 = utc(2026, 11, 25, 14, 30); // Wed 09:30 EST
    const minutes = Array.from({ length: 90 }, (_, i) => [t0 + i * MIN, 100 + i * 0.1, 100.2 + i * 0.1, 99.9 + i * 0.1, 100.1 + i * 0.1, 10] as [number, number, number, number, number, number]);
    const { client } = fakeClient({
      '1m|1d': chart(minutes, { exchangeName: 'NMS', regularMarketPrice: 109.05, regularMarketDayHigh: 112, regularMarketDayLow: 99, regularMarketVolume: 5000, regularMarketTime: (t0 + 89 * MIN) / 1000 }),
      '1d|3mo': chart([
        [utc(2026, 11, 23, 14, 30), 95, 97, 94, 96, 3000], // Mon
        [utc(2026, 11, 24, 14, 30), 96, 99, 95, 98, 3500], // Tue
        [utc(2026, 11, 25, 14, 30), 98, 108, 97, 107, 4000], // today again (stale): must be ignored
      ]),
    });
    const snap = await new YahooMarketProvider(US, client).snapshot('AAPL');
    // Last minute is 10:59 EST, inside the 10:30 hourly bar and the 09:30 4h bar.
    expect(snap.candles['1h']!.time).toBe(utc(2026, 11, 25, 15, 30));
    expect(snap.candles['1h']!.volume).toBe(300);
    expect(snap.candles['4h']!.time).toBe(t0);
    expect(snap.candles['1m']!.time).toBe(t0 + 89 * MIN);
    expect(snap.candles['1D']).toEqual({ time: utc(2026, 11, 25), open: 100, high: 112, low: 99, close: 109.05, volume: 5000 });
    expect(snap.candles['1W']).toEqual({ time: utc(2026, 11, 23), open: 95, high: 112, low: 94, close: 109.05, volume: 11500 });
    expect(snap.candles['1M']!.time).toBe(utc(2026, 11, 1));
    expect(snap.asOf).toBe(t0 + 89 * MIN);
  });
});

describe('YahooClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('backs off on 429 and fails fast without calling Yahoo again', async () => {
    const fetchMock = vi.fn(async () => new Response('Too Many Requests', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new YahooClient({ minGapMs: 0 });
    await expect(c.chart('AAPL', { interval: '1d', range: '5d' }, 0)).rejects.toMatchObject({ status: 429 });
    await expect(c.chart('MSFT', { interval: '1d', range: '5d' }, 0)).rejects.toThrow(/retrying in/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.backedOffUntil).toBeGreaterThan(Date.now() + 50_000);
  });

  it('shares one request between identical concurrent calls and caches the result', async () => {
    const body = { chart: { result: [chart([[utc(2026, 11, 26, 3, 45), 1, 1, 1, 1, 1]])], error: null } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetchMock);
    const c = new YahooClient({ minGapMs: 0 });
    await Promise.all([c.chart('A', { interval: '1d', range: '5d' }, 60_000), c.chart('A', { interval: '1d', range: '5d' }, 60_000)]);
    await c.chart('A', { interval: '1d', range: '5d' }, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
