import { SymbolAggregator } from '@chartdeck/candle-aggregator';
import type { MarketDataProvider, ProviderTrade, TradeStream } from '@chartdeck/data-providers';
import type { Logger } from '@chartdeck/service-kit';
import {
  REDIS_KEYS, type Candle, type CandleBatch, type ProviderState, type ProviderStatusMessage, type Timeframe,
} from '@chartdeck/shared';
import type { Redis } from 'ioredis';
import { metrics } from './metrics.ts';
import { Semaphore } from './semaphore.ts';

export interface FeedOptions {
  /** Minimum gap between publishes for one symbol; trades in between are coalesced. */
  flushMs: number;
  /** Keep streaming a symbol this long after the last client left, to absorb quick re-subscribes. */
  lingerMs: number;
  /** TTL of the hot-candle cache entry. */
  hotTtlSec: number;
}

interface SymbolState {
  ticker: string;
  id: string;
  agg: SymbolAggregator;
  lastPublish: number;
  timer: NodeJS.Timeout | null;
  lastEventTime: number;
  lastReceived: number;
  undemandedSince: number | null;
  reseedTimer: NodeJS.Timeout | null;
  /** Incremented per seed so a stale in-flight seed cannot overwrite a newer one. */
  seedGen: number;
}

const ROLL_INTERVAL_MS = 100;
const CLOCK_SYNC_MS = 5 * 60_000;

/** Runs one provider: upstream trade stream -> per-symbol aggregators -> Redis. */
export class ProviderFeed {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly invalid = new Set<string>();
  private readonly seedLimit = new Semaphore(6);
  private readonly stream: TradeStream;
  private state: ProviderState = 'connecting';
  /** Changes whenever continuity is broken (process start, upstream reconnect); clients backfill on change. */
  private epoch = Date.now();
  /** Exchange clock minus local clock, ms. */
  private clockOffset = 0;
  private rollTimer: NodeJS.Timeout;
  private clockTimer: NodeJS.Timeout;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly opts: FeedOptions,
  ) {
    this.stream = provider.openStream({
      onTrade: (t) => this.onTrade(t),
      onState: (s) => this.setState(s),
      onReconnected: () => this.onReconnected(),
    });
    this.rollTimer = setInterval(() => this.roll(), ROLL_INTERVAL_MS);
    this.clockTimer = setInterval(() => void this.syncClock(), CLOCK_SYNC_MS);
    void this.syncClock();
    // Warm the symbol list so the first subscribe isn't stuck behind a multi-MB download.
    provider.getSymbol('').catch((err) => log.warn({ err }, 'symbol list preload failed'));
  }

  get id(): string {
    return this.provider.id;
  }

  get isLive(): boolean {
    return this.state === 'live';
  }

  /** Called with the full set of tickers any gateway currently wants. */
  setDemand(tickers: Set<string>): void {
    const now = Date.now();
    let changed = false;
    for (const ticker of tickers) {
      if (this.invalid.has(ticker)) continue;
      const st = this.symbols.get(ticker);
      if (st) {
        st.undemandedSince = null;
      } else {
        this.add(ticker);
        changed = true;
      }
    }
    for (const st of this.symbols.values()) {
      if (tickers.has(st.ticker)) continue;
      st.undemandedSince ??= now;
      if (now - st.undemandedSince >= this.opts.lingerMs) {
        this.remove(st);
        changed = true;
      }
    }
    if (changed) this.stream.setTickers(this.symbols.keys());
  }

  close(): void {
    clearInterval(this.rollTimer);
    clearInterval(this.clockTimer);
    for (const st of this.symbols.values()) this.remove(st);
    this.stream.close();
  }

  private add(ticker: string): void {
    const st: SymbolState = {
      ticker, id: `${this.provider.id}:${ticker}`, agg: new SymbolAggregator(this.provider.timeframes),
      lastPublish: 0, timer: null, lastEventTime: 0, lastReceived: 0, undemandedSince: null, reseedTimer: null, seedGen: 0,
    };
    this.symbols.set(ticker, st);
    metrics.symbols.labels(this.provider.id).set(this.symbols.size);
    this.log.info({ symbol: st.id }, 'stream symbol');
    void this.validateAndSeed(st);
  }

  private remove(st: SymbolState): void {
    if (st.timer) clearTimeout(st.timer);
    if (st.reseedTimer) clearTimeout(st.reseedTimer);
    st.seedGen++;
    this.symbols.delete(st.ticker);
    metrics.symbols.labels(this.provider.id).set(this.symbols.size);
    this.log.info({ symbol: st.id }, 'drop symbol');
  }

  private async validateAndSeed(st: SymbolState): Promise<void> {
    try {
      const info = await this.provider.getSymbol(st.ticker);
      if (!info) {
        this.log.warn({ symbol: st.id }, 'unknown symbol requested; ignoring');
        this.invalid.add(st.ticker);
        this.remove(st);
        this.stream.setTickers(this.symbols.keys());
        return;
      }
    } catch (err) {
      // Symbol list unavailable (e.g. rate-limited); stream anyway rather than block live data.
      this.log.warn({ err, symbol: st.id }, 'symbol validation failed');
    }
    await this.seed(st);
  }

  /**
   * Fetch the exchange's current candle for every timeframe and hand it to the aggregator,
   * which has been buffering live trades meanwhile.
   */
  private async seed(st: SymbolState): Promise<void> {
    const gen = ++st.seedGen;
    st.agg.beginSeed();
    const timer = metrics.seedSeconds.labels(this.provider.id).startTimer();
    const { seeds, cutoff, failed } = await this.seedLimit.run(async () => {
      const t0 = Date.now();
      const results = await Promise.allSettled(
        this.provider.timeframes.map((tf) => this.provider.getCandles(st.ticker, tf, { limit: 1 })),
      );
      const t1 = Date.now();
      const seeds: Partial<Record<Timeframe, Candle>> = {};
      let failed = 0;
      results.forEach((r, i) => {
        const tf = this.provider.timeframes[i]!;
        if (r.status === 'fulfilled' && r.value.length) seeds[tf] = r.value[r.value.length - 1];
        else failed++;
      });
      // The snapshot was taken somewhere in [t0, t1]; the midpoint halves the expected double-count window.
      return { seeds, cutoff: (t0 + t1) / 2 + this.clockOffset, failed };
    });
    timer();
    if (gen !== st.seedGen || !this.symbols.has(st.ticker)) return;

    st.agg.completeSeed(seeds, cutoff);
    if (failed) {
      metrics.seedFailures.labels(this.provider.id).inc(failed);
      this.log.warn({ symbol: st.id, failed }, 'some timeframes failed to seed; retrying in 30s');
      st.reseedTimer = setTimeout(() => {
        st.reseedTimer = null;
        void this.seed(st);
      }, 30_000);
    }
    this.publish(st);
  }

  private onTrade(t: ProviderTrade): void {
    const st = this.symbols.get(t.ticker);
    if (!st) return;
    metrics.trades.labels(this.provider.id).inc();
    const applied = st.agg.applyTrade({ price: t.price, qty: t.qty, time: t.time });
    st.lastEventTime = t.eventTime;
    st.lastReceived = t.receivedAt;
    metrics.exchangeToIngest.labels(this.provider.id).observe(Math.max(0, t.receivedAt - (t.eventTime - this.clockOffset)));
    if (applied) this.schedulePublish(st);
  }

  /** Leading-edge throttle: publish immediately if idle, otherwise at the end of the flush window. */
  private schedulePublish(st: SymbolState): void {
    if (st.timer) return;
    const wait = st.lastPublish + this.opts.flushMs - Date.now();
    if (wait <= 0) {
      this.publish(st);
    } else {
      st.timer = setTimeout(() => {
        st.timer = null;
        this.publish(st);
      }, wait);
    }
  }

  private publish(st: SymbolState): void {
    if (st.agg.isSeeding) return;
    const pi = Date.now();
    st.lastPublish = pi;
    const batch: CandleBatch = {
      s: st.id, ep: this.epoch, c: st.agg.snapshot(),
      et: st.lastEventTime, ri: st.lastReceived, pi, xo: this.clockOffset,
    };
    const json = JSON.stringify(batch);
    this.redis
      .pipeline()
      .publish(REDIS_KEYS.candleChannel(st.id), json)
      .set(REDIS_KEYS.hot(st.id), json, 'EX', this.opts.hotTtlSec)
      .exec()
      .catch((err) => this.log.error({ err }, 'redis publish failed'));
    metrics.publishes.labels(this.provider.id).inc();
    if (st.lastReceived) metrics.ingestToPublish.labels(this.provider.id).observe(pi - st.lastReceived);
  }

  private roll(): void {
    const now = Date.now() + this.clockOffset;
    for (const st of this.symbols.values()) {
      if (st.agg.rollTo(now)) this.schedulePublish(st);
    }
  }

  private onReconnected(): void {
    metrics.reconnects.labels(this.provider.id).inc();
    this.epoch = Date.now();
    this.log.warn({ provider: this.provider.id, symbols: this.symbols.size }, 'upstream reconnected; re-seeding');
    this.publishStatus();
    for (const st of this.symbols.values()) void this.seed(st);
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

  private async syncClock(): Promise<void> {
    try {
      const t0 = Date.now();
      const server = await this.provider.serverTime();
      const t1 = Date.now();
      this.clockOffset = Math.round(server - (t0 + t1) / 2);
      metrics.clockOffset.labels(this.provider.id).set(this.clockOffset);
    } catch (err) {
      this.log.warn({ err }, 'clock sync failed');
    }
  }
}
