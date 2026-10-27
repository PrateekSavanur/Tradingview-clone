import type { MarketDataProvider } from '@chartdeck/data-providers';
import type { Logger } from '@chartdeck/service-kit';
import { bucketStart, nextBucket, prevBucket, type Candle, type Timeframe } from '@chartdeck/shared';

export interface CandleCache {
  before(provider: string, symbol: string, tf: Timeframe, end: number, limit: number): Promise<Candle[]>;
  upsert(provider: string, symbol: string, tf: Timeframe, candles: Candle[]): Promise<void>;
}

export interface HistoryResult {
  candles: Candle[];
  source: 'cache' | 'provider';
}

/** True if `rows` (ascending) are back-to-back buckets ending exactly at `lastOpen`. */
export function isContiguous(tf: Timeframe, rows: Candle[], lastOpen: number): boolean {
  let expect = lastOpen;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.time !== expect) return false;
    expect = prevBucket(tf, expect);
  }
  return true;
}

/**
 * History with a read-through cache. The newest page always comes from the provider (it contains
 * the open candle); older pages are served from TimescaleDB when the cached run is complete and
 * gap-free, and otherwise fetched from the provider and written back. Concurrent identical
 * requests share one upstream call.
 */
export class HistoryService {
  private readonly inflight = new Map<string, Promise<HistoryResult>>();

  constructor(
    private readonly providers: Map<string, MarketDataProvider>,
    private readonly cache: CandleCache | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get(providerId: string, ticker: string, tf: Timeframe, to: number | undefined, limit: number): Promise<HistoryResult> {
    const key = `${providerId}:${ticker}:${tf}:${to ?? 'latest'}:${limit}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(providerId, ticker, tf, to, limit).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async load(providerId: string, ticker: string, tf: Timeframe, to: number | undefined, limit: number): Promise<HistoryResult> {
    const provider = this.providers.get(providerId);
    if (!provider) throw Object.assign(new Error(`Unknown provider ${providerId}`), { statusCode: 404 });

    const now = this.now();
    const openBucket = bucketStart(tf, now);
    // `to` is exclusive: the caller already has the candle opening at `to`.
    const lastOpen = to === undefined ? openBucket : prevBucket(tf, bucketStart(tf, to));
    const wantsOpenCandle = lastOpen >= openBucket;

    if (this.cache && !wantsOpenCandle) {
      try {
        const rows = await this.cache.before(providerId, ticker, tf, lastOpen, limit);
        if (rows.length === limit && isContiguous(tf, rows, lastOpen)) return { candles: rows, source: 'cache' };
      } catch (err) {
        this.log.warn({ err }, 'candle cache read failed');
      }
    }

    const candles = await provider.getCandles(ticker, tf, { endTime: to === undefined ? undefined : lastOpen, limit });
    if (this.cache) {
      const closed = candles.filter((c) => nextBucket(tf, c.time) <= now);
      this.cache.upsert(providerId, ticker, tf, closed).catch((err) => this.log.warn({ err }, 'candle cache write failed'));
    }
    return { candles, source: 'provider' };
  }
}
