import {
  MARKETS, TF_MS, bucketStart, isSessionOpen, marketTimeframes,
  type Candle, type SymbolInfo, type Timeframe,
} from '@chartdeck/shared';
import type { CandleQuery, MarketDataProvider, ProviderSnapshot } from '../types.ts';
import { ProviderError } from '../types.ts';
import { bucketKey, combine, localDate, parseBars, rekey, resample, type ChartMeta, type Session } from './bars.ts';
import type { SearchQuote, YahooClient } from './client.ts';
import { POPULAR, type MarketDef } from './markets.ts';

/** Which Yahoo series each timeframe is built from. `resample` marks timeframes Yahoo lacks. */
const SERIES: Record<Exclude<Timeframe, '1s'>, { interval: string; range: string; resample?: true }> = {
  '1m': { interval: '1m', range: '7d' },
  '3m': { interval: '1m', range: '7d', resample: true },
  '5m': { interval: '5m', range: '60d' },
  '15m': { interval: '15m', range: '60d' },
  '30m': { interval: '30m', range: '60d' },
  '1h': { interval: '60m', range: '730d' },
  '2h': { interval: '60m', range: '730d', resample: true },
  '4h': { interval: '60m', range: '730d', resample: true },
  '1D': { interval: '1d', range: 'max' },
  '1W': { interval: '1wk', range: 'max' },
  '1M': { interval: '1mo', range: 'max' },
};

const INTRADAY: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];

export interface YahooMarketOptions {
  /** Poll interval per symbol while the session is open. */
  pollMs?: number;
  /** Poll interval while closed: just enough to notice holidays ending or late prints. */
  closedPollMs?: number;
}

/**
 * Stocks and indices for one market (India: NSE/BSE, US: NYSE/Nasdaq) from Yahoo Finance.
 * There is no free socket, so live data is polled: one request per watched symbol per minute
 * returns today's 1-minute bars, from which every timeframe's open candle is built.
 */
export class YahooMarketProvider implements MarketDataProvider {
  readonly id: string;
  readonly name: string;
  readonly timeframes: readonly Timeframe[];
  readonly cacheHistory = false;
  private readonly session: Session;
  private readonly known = new Map<string, SymbolInfo>();
  private readonly pollMs: number;
  private readonly closedPollMs: number;

  constructor(
    private readonly market: MarketDef,
    private readonly yahoo: YahooClient,
    opts: YahooMarketOptions = {},
  ) {
    this.id = market.id;
    this.name = `${MARKETS[market.id].label} stocks (Yahoo Finance)`;
    this.timeframes = marketTimeframes(market.id);
    this.session = MARKETS[market.id].session!;
    this.pollMs = opts.pollMs ?? 60_000;
    this.closedPollMs = opts.closedPollMs ?? 15 * 60_000;
    for (const p of POPULAR[market.id]) this.known.set(p.ticker, this.info(p.ticker, p.name, p.exchange, p.type));
  }

  pollIntervalMs(): number {
    return isSessionOpen(this.market.id) ? this.pollMs : this.closedPollMs;
  }

  async serverTime(): Promise<number> {
    return Date.now();
  }

  // ---------------------------------------------------------------- symbols

  async searchSymbols(query: string, limit: number): Promise<SymbolInfo[]> {
    const q = query.trim();
    const popular = POPULAR[this.market.id].map((p) => this.known.get(p.ticker)!);
    if (q.length < 2) {
      const up = q.toUpperCase();
      return popular.filter((s) => !up || s.ticker.startsWith(up) || s.description.toUpperCase().includes(up)).slice(0, limit);
    }
    const quotes = await this.yahoo.search(q);
    const out: SymbolInfo[] = [];
    for (const quote of quotes) {
      const info = this.fromQuote(quote);
      if (!info) continue;
      this.known.set(info.ticker, info);
      out.push(info);
    }
    // Prefer NSE over BSE for the same company; they are otherwise equal.
    out.sort((a, b) => Number(a.exchange === 'BSE') - Number(b.exchange === 'BSE'));
    return out.slice(0, limit);
  }

  async getSymbol(ticker: string): Promise<SymbolInfo | null> {
    if (!ticker) return null;
    const hit = this.known.get(ticker);
    if (hit) return hit;
    try {
      const r = await this.yahoo.chart(ticker, { interval: '1d', range: '5d' }, 60 * 60_000);
      const info = this.fromMeta(r.meta);
      if (info) this.known.set(ticker, info);
      return info;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private fromQuote(q: SearchQuote): SymbolInfo | null {
    if (!q.exchange || !this.market.exchanges[q.exchange]) return null;
    const type = q.quoteType === 'INDEX' ? 'index' : q.quoteType === 'EQUITY' || q.quoteType === 'ETF' ? 'stock' : null;
    if (!type) return null;
    return this.info(q.symbol, q.longname ?? q.shortname ?? q.symbol, this.market.exchanges[q.exchange]!, type);
  }

  private fromMeta(m: ChartMeta): SymbolInfo | null {
    const exchange = m.exchangeName && this.market.exchanges[m.exchangeName];
    if (!exchange) return null;
    const type = m.instrumentType === 'INDEX' ? 'index' : 'stock';
    return this.info(m.symbol, m.longName ?? m.shortName ?? m.symbol, exchange, type);
  }

  private info(ticker: string, description: string, exchange: string, type: 'stock' | 'index'): SymbolInfo {
    return {
      id: `${this.id}:${ticker}`, provider: this.id, ticker, description: description.slice(0, 120), exchange, type,
      tickSize: this.market.tickSize,
    };
  }

  // ---------------------------------------------------------------- history

  async getCandles(ticker: string, tf: Timeframe, q: CandleQuery): Promise<Candle[]> {
    if (tf === '1s') return [];
    // A few recent days (watchlist previous close) reuse the small series snapshots already cache.
    const recentDays = tf === '1D' && q.endTime === undefined && q.startTime === undefined && q.limit <= 40;
    const spec = recentDays ? { interval: '1d', range: '3mo' } : SERIES[tf];
    // The newest page carries the open candle, so it refreshes as often as polling would.
    const ttl = isSessionOpen(this.market.id) ? Math.min(this.pollMs, 60_000) : 10 * 60_000;
    const r = await this.yahoo.chart(ticker, spec, ttl);
    const raw = parseBars(r);
    const key = bucketKey(tf, this.session, TF_MS[tf]);
    let bars = 'resample' in spec && spec.resample ? resample(raw, key) : rekey(raw, key);
    if (q.startTime !== undefined) bars = bars.filter((c) => c.time >= q.startTime!);
    if (q.endTime !== undefined) bars = bars.filter((c) => c.time <= q.endTime!);
    return bars.slice(-q.limit);
  }

  // ---------------------------------------------------------------- live

  async snapshot(ticker: string): Promise<ProviderSnapshot> {
    const ttl = Math.max(5_000, this.pollIntervalMs() / 2);
    const today = await this.yahoo.chart(ticker, { interval: '1m', range: '1d' }, ttl);
    const minutes = parseBars(today);
    const m = today.meta;
    const candles: ProviderSnapshot['candles'] = {};
    if (!minutes.length) return { candles, asOf: (m.regularMarketTime ?? 0) * 1000 };

    const last = minutes[minutes.length - 1]!;
    for (const tf of INTRADAY) {
      const key = bucketKey(tf, this.session, TF_MS[tf]);
      const start = key(last.time);
      candles[tf] = combine(minutes.filter((b) => key(b.time) === start), start);
    }

    // The day's candle: 1-minute bars can miss prints, so prefer the exchange's day stats.
    const dayKey = localDate(last.time, this.session.tz);
    const day = combine(minutes.filter((b) => localDate(b.time, this.session.tz) === dayKey), dayKey)!;
    if (m.regularMarketDayHigh) day.high = Math.max(day.high, m.regularMarketDayHigh);
    if (m.regularMarketDayLow) day.low = Math.min(day.low, m.regularMarketDayLow);
    if (m.regularMarketPrice) day.close = m.regularMarketPrice;
    if (m.regularMarketVolume) day.volume = m.regularMarketVolume;
    candles['1D'] = day;

    // Week and month: completed days this period from daily history, plus today.
    const daily = parseBars(await this.yahoo.chart(ticker, { interval: '1d', range: '3mo' }, 60 * 60_000))
      .map((b) => ({ ...b, time: localDate(b.time, this.session.tz) }))
      .filter((b) => b.time < dayKey);
    // `daily` and `dayKey` are already exchange-local dates, so bucket them directly.
    for (const tf of ['1W', '1M'] as const) {
      const start = bucketStart(tf, dayKey);
      candles[tf] = combine([...daily.filter((b) => bucketStart(tf, b.time) === start), day], start);
    }
    return { candles, asOf: (m.regularMarketTime ?? last.time / 1000) * 1000 };
  }
}
