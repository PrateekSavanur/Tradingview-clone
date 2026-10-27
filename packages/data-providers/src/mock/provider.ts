import type { Candle, SymbolInfo, Timeframe } from '@chartdeck/shared';
import { TIMEFRAMES, bucketStart, prevBucket } from '@chartdeck/shared';
import type { CandleQuery, MarketDataProvider, StreamHandlers, TradeStream } from '../types.ts';

export interface MockOptions {
  /** Trades per second per subscribed ticker. */
  tradesPerSecond?: number;
}

const TICKERS = ['TEST1', 'TEST2', 'FLAT'];

/** Deterministic pseudo-random in [0,1) from an integer seed (mulberry32). */
function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Synthetic provider for tests and offline development. History is a deterministic
 * random walk; the live stream emits trades on a timer. It is not market data.
 */
export class MockProvider implements MarketDataProvider {
  readonly id = 'mock';
  readonly name = 'Mock (synthetic)';
  readonly timeframes = TIMEFRAMES;

  constructor(private readonly opts: MockOptions = {}) {}

  async searchSymbols(query: string, limit: number): Promise<SymbolInfo[]> {
    const q = query.toUpperCase();
    return TICKERS.filter((t) => t.includes(q)).slice(0, limit).map((t) => this.info(t));
  }

  async getSymbol(ticker: string): Promise<SymbolInfo | null> {
    return TICKERS.includes(ticker) ? this.info(ticker) : null;
  }

  async getCandles(ticker: string, tf: Timeframe, q: CandleQuery): Promise<Candle[]> {
    if (!TICKERS.includes(ticker)) return [];
    let t = bucketStart(tf, q.endTime ?? Date.now());
    const out: Candle[] = [];
    while (out.length < q.limit && (q.startTime === undefined || t >= q.startTime)) {
      const r = rand(Math.floor(t / 1000) ^ ticker.length);
      const mid = 100 + 10 * Math.sin(t / 3.6e6) + r * 2;
      const flat = ticker === 'FLAT';
      out.push({
        time: t,
        open: mid, high: flat ? mid : mid + r, low: flat ? mid : mid - (1 - r), close: flat ? mid : mid + (r - 0.5),
        volume: flat ? 0 : Math.round(r * 1000),
      });
      t = prevBucket(tf, t);
    }
    return out.reverse();
  }

  async serverTime(): Promise<number> {
    return Date.now();
  }

  openStream(handlers: StreamHandlers): TradeStream {
    const rate = this.opts.tradesPerSecond ?? 20;
    let tickers: string[] = [];
    const price = new Map<string, number>();
    handlers.onState('live');
    const timer = setInterval(() => {
      const now = Date.now();
      for (const ticker of tickers) {
        if (ticker === 'FLAT') continue;
        const p = (price.get(ticker) ?? 100) * (1 + (Math.random() - 0.5) * 0.002);
        price.set(ticker, p);
        handlers.onTrade({ ticker, price: p, qty: Math.random(), time: now, eventTime: now, receivedAt: now });
      }
    }, 1000 / rate);
    return {
      setTickers: (t) => {
        tickers = [...t];
      },
      close: () => clearInterval(timer),
    };
  }

  private info(ticker: string): SymbolInfo {
    return {
      id: `mock:${ticker}`, provider: 'mock', ticker, description: `Synthetic ${ticker}`,
      exchange: 'Mock', type: 'crypto', tickSize: 0.01,
    };
  }
}
