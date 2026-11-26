import type { MarketDataProvider } from '@chartdeck/data-providers';
import { ProviderError } from '@chartdeck/data-providers';
import type { Logger } from '@chartdeck/service-kit';
import {
  REDIS_KEYS, toTuple, type CandleBatch, type CandleTuple, type ProviderState, type ProviderStatusMessage, type Timeframe,
} from '@chartdeck/shared';
import type { Redis } from 'ioredis';
import { metrics } from './metrics.ts';

export interface PolledFeedOptions {
  lingerMs: number;
  /** TTL of the hot-candle cache entry; raised to cover at least two poll intervals. */
  hotTtlSec: number;
}

interface PolledSymbol {
  ticker: string;
  id: string;
  nextPoll: number;
  undemandedSince: number | null;
  /** Last published JSON of the candles, so unchanged polls (closed market) aren't re-sent. */
  lastCandles: string;
}

/** Consecutive failed polls before the provider is reported down. */
const DOWN_AFTER_FAILURES = 3;
const TICK_MS = 1000;

/**
 * Runs a provider that has no live socket: each demanded symbol is polled with `snapshot()`
 * on the provider's cadence, and the result is published exactly like a streamed batch, so the
 * gateway, hot cache and alerts service need no special case. Polls run one at a time; the
 * provider's client paces upstream requests.
 */
export class PolledFeed {
  private readonly symbols = new Map<string, PolledSymbol>();
  private readonly invalid = new Set<string>();
  private state: ProviderState = 'connecting';
  private epoch = Date.now();
  private failures = 0;
  private busy = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly opts: PolledFeedOptions,
  ) {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  get id(): string {
    return this.provider.id;
  }

  setDemand(tickers: Set<string>): void {
    const now = Date.now();
    for (const ticker of tickers) {
      if (this.invalid.has(ticker)) continue;
      const st = this.symbols.get(ticker);
      if (st) st.undemandedSince = null;
      else {
        this.symbols.set(ticker, { ticker, id: `${this.provider.id}:${ticker}`, nextPoll: 0, undemandedSince: null, lastCandles: '' });
        this.log.info({ symbol: `${this.provider.id}:${ticker}` }, 'poll symbol');
      }
    }
    for (const st of this.symbols.values()) {
      if (tickers.has(st.ticker)) continue;
      st.undemandedSince ??= now;
      if (now - st.undemandedSince >= this.opts.lingerMs) {
        this.symbols.delete(st.ticker);
        this.log.info({ symbol: st.id }, 'drop symbol');
      }
    }
    metrics.symbols.labels(this.provider.id).set(this.symbols.size);
  }

  close(): void {
    clearInterval(this.timer);
    this.symbols.clear();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const now = Date.now();
    // Most overdue first, so a burst of new symbols can't starve the others.
    const due = [...this.symbols.values()].filter((s) => s.nextPoll <= now).sort((a, b) => a.nextPoll - b.nextPoll);
    if (!due.length) return;
    this.busy = true;
    try {
      for (const st of due) {
        if (!this.symbols.has(st.ticker)) continue;
        await this.poll(st);
      }
    } finally {
      this.busy = false;
    }
  }

  private async poll(st: PolledSymbol): Promise<void> {
    const interval = this.provider.pollIntervalMs!();
    try {
      if (st.nextPoll === 0) {
        const info = await this.provider.getSymbol(st.ticker);
        if (!info) {
          this.log.warn({ symbol: st.id }, 'unknown symbol requested; ignoring');
          this.invalid.add(st.ticker);
          this.symbols.delete(st.ticker);
          return;
        }
      }
      const snap = await this.provider.snapshot!(st.ticker);
      const receivedAt = Date.now();
      st.nextPoll = receivedAt + interval;
      this.failures = 0;
      if (this.state !== 'live') {
        // Coming back from an outage: bump the epoch so open charts backfill what they missed.
        if (this.state === 'down') this.epoch = Date.now();
        this.setState('live');
      }
      const c: Partial<Record<Timeframe, CandleTuple>> = {};
      for (const [tf, candle] of Object.entries(snap.candles)) if (candle) c[tf as Timeframe] = toTuple(candle);
      const json = JSON.stringify(c);
      if (json === st.lastCandles) return void this.refreshHot(st, interval);
      st.lastCandles = json;
      this.publish(st, c, snap.asOf, receivedAt, interval);
    } catch (err) {
      const retryAt = err instanceof ProviderError && err.retryAt ? err.retryAt : Date.now() + Math.min(interval, 30_000);
      st.nextPoll = Math.max(retryAt, Date.now() + 5_000);
      this.failures++;
      this.log.warn({ symbol: st.id, err: (err as Error).message }, 'poll failed');
      if (this.failures >= DOWN_AFTER_FAILURES && this.state !== 'down') this.setState('down');
    }
  }

  private hotTtl(interval: number): number {
    return Math.max(this.opts.hotTtlSec, Math.ceil((interval * 2.5) / 1000));
  }

  private publish(st: PolledSymbol, c: Partial<Record<Timeframe, CandleTuple>>, asOf: number, receivedAt: number, interval: number): void {
    const pi = Date.now();
    const batch: CandleBatch = { s: st.id, ep: this.epoch, c, et: asOf, ri: receivedAt, pi, xo: 0 };
    const json = JSON.stringify(batch);
    this.redis
      .pipeline()
      .publish(REDIS_KEYS.candleChannel(st.id), json)
      .set(REDIS_KEYS.hot(st.id), json, 'EX', this.hotTtl(interval))
      .exec()
      .catch((err) => this.log.error({ err }, 'redis publish failed'));
    metrics.publishes.labels(this.provider.id).inc();
  }

  /** Nothing changed (e.g. market closed): keep the hot snapshot alive for new subscribers. */
  private refreshHot(st: PolledSymbol, interval: number): void {
    this.redis.expire(REDIS_KEYS.hot(st.id), this.hotTtl(interval)).catch(() => undefined);
  }

  private setState(s: ProviderState): void {
    this.state = s;
    metrics.upstreamUp.labels(this.provider.id).set(s === 'live' ? 1 : 0);
    this.log.info({ provider: this.provider.id, state: s }, 'upstream state');
    this.publishStatus();
  }

  publishStatus(): void {
    const msg: ProviderStatusMessage = { provider: this.provider.id, state: this.state, epoch: this.epoch, at: Date.now() };
    const json = JSON.stringify(msg);
    this.redis
      .pipeline()
      .set(REDIS_KEYS.status(this.provider.id), json, 'EX', 30)
      .publish(REDIS_KEYS.statusChannel, json)
      .exec()
      .catch((err) => this.log.error({ err }, 'redis status publish failed'));
  }
}
