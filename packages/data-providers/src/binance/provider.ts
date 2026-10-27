import type { Candle, SymbolInfo, Timeframe } from '@chartdeck/shared';
import { TIMEFRAMES } from '@chartdeck/shared';
import type { CandleQuery, MarketDataProvider, StreamHandlers, TradeStream } from '../types.ts';
import { BinanceRest } from './rest.ts';
import { BinanceTradeStream } from './stream.ts';

export interface BinanceOptions {
  restUrl?: string;
  wsUrl?: string;
}

const INTERVAL: Record<Timeframe, string> = {
  '1s': '1s', '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M',
};

type RawKline = [number, string, string, string, string, string, ...unknown[]];

interface ExchangeInfo {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<{ filterType: string; tickSize?: string }>;
  }>;
}

const SYMBOLS_TTL_MS = 60 * 60 * 1000;
/** Quote assets ranked first in search results, in order. */
const QUOTE_RANK = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'EUR', 'TRY', 'BRL', 'JPY'];

export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance';
  readonly name = 'Binance';
  readonly timeframes = TIMEFRAMES;
  private readonly rest: BinanceRest;
  private readonly wsUrl: string;
  private symbols: Map<string, SymbolInfo> | null = null;
  private symbolsLoadedAt = 0;
  private symbolsLoading: Promise<Map<string, SymbolInfo>> | null = null;

  constructor(opts: BinanceOptions = {}) {
    this.rest = new BinanceRest(opts.restUrl ?? 'https://api.binance.com');
    this.wsUrl = opts.wsUrl ?? 'wss://stream.binance.com:9443';
  }

  async getCandles(ticker: string, tf: Timeframe, q: CandleQuery): Promise<Candle[]> {
    const rows = await this.rest.get<RawKline[]>('/api/v3/klines', {
      symbol: ticker,
      interval: INTERVAL[tf],
      startTime: q.startTime,
      endTime: q.endTime,
      limit: Math.min(1000, Math.max(1, q.limit)),
    }, 2);
    return rows.map((r) => ({
      time: r[0], open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
    }));
  }

  async serverTime(): Promise<number> {
    const r = await this.rest.get<{ serverTime: number }>('/api/v3/time', {}, 1);
    return r.serverTime;
  }

  async getSymbol(ticker: string): Promise<SymbolInfo | null> {
    return (await this.loadSymbols()).get(ticker.toUpperCase()) ?? null;
  }

  async searchSymbols(query: string, limit: number): Promise<SymbolInfo[]> {
    const q = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const all = await this.loadSymbols();
    if (!q) return [...all.values()].filter((s) => s.ticker.endsWith('USDT')).slice(0, limit);
    const scored: Array<[number, SymbolInfo]> = [];
    for (const s of all.values()) {
      const base = s.description.split(' / ')[0]!;
      let score: number;
      if (s.ticker === q) score = 0;
      else if (base === q) score = 1;
      else if (s.ticker.startsWith(q)) score = 2;
      else if (s.ticker.includes(q)) score = 4;
      else continue;
      const quote = s.description.split(' / ')[1]!;
      const qr = QUOTE_RANK.indexOf(quote);
      scored.push([score + (qr === -1 ? 0.99 : qr / 100), s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].ticker.length - b[1].ticker.length);
    return scored.slice(0, limit).map(([, s]) => s);
  }

  openStream(handlers: StreamHandlers): TradeStream {
    return new BinanceTradeStream(this.wsUrl, handlers);
  }

  private async loadSymbols(): Promise<Map<string, SymbolInfo>> {
    const fresh = this.symbols && Date.now() - this.symbolsLoadedAt < SYMBOLS_TTL_MS;
    if (fresh) return this.symbols!;
    this.symbolsLoading ??= this.rest
      .get<ExchangeInfo>('/api/v3/exchangeInfo', { symbolStatus: 'TRADING', permissions: 'SPOT' }, 20)
      .then((info) => {
        const map = new Map<string, SymbolInfo>();
        for (const s of info.symbols) {
          const tick = Number(s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? '0.01');
          map.set(s.symbol, {
            id: `binance:${s.symbol}`,
            provider: 'binance',
            ticker: s.symbol,
            description: `${s.baseAsset} / ${s.quoteAsset}`,
            exchange: 'Binance',
            type: 'crypto',
            tickSize: tick > 0 ? tick : 0.01,
          });
        }
        this.symbols = map;
        this.symbolsLoadedAt = Date.now();
        return map;
      })
      .catch((err) => {
        // Serve stale data if we have it rather than failing search.
        if (this.symbols) return this.symbols;
        throw err;
      })
      .finally(() => {
        this.symbolsLoading = null;
      });
    return this.symbolsLoading;
  }
}
