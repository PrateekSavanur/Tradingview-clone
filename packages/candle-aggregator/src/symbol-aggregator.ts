import {
  TIMEFRAMES, bucketStart, nextBucket, toTuple,
  type Candle, type CandleTuple, type Timeframe,
} from '@chartdeck/shared';

export interface Trade {
  price: number;
  qty: number;
  /** Trade time, exchange clock, epoch ms. */
  time: number;
}

interface OpenCandle extends Candle {
  /** True while the bucket has seen no trades (a flat roll-over), matching the exchange's zero-volume klines. */
  empty: boolean;
}

/**
 * Folds a single symbol's trade stream into the open candle of every timeframe.
 *
 * Seeding: the exchange's current kline for each timeframe is fetched over REST while
 * trades keep arriving on the socket. Trades seen during that window are buffered and
 * replayed after the seed, skipping those at or before `cutoff` (the estimated exchange
 * time the snapshot was taken) so they are not counted twice.
 */
export class SymbolAggregator {
  private readonly open = new Map<Timeframe, OpenCandle>();
  private seeding = false;
  private buffer: Trade[] = [];
  private lastPrice: number | null = null;

  constructor(
    readonly timeframes: readonly Timeframe[] = TIMEFRAMES,
    /** Upper bound on trades buffered while seeding; beyond it trades are dropped. */
    private readonly maxBuffer = 50_000,
  ) {}

  get isSeeding(): boolean {
    return this.seeding;
  }

  /** Start buffering trades until `completeSeed` is called. Used on first subscribe and after reconnects. */
  beginSeed(): void {
    this.seeding = true;
    this.buffer = [];
  }

  completeSeed(seeds: Partial<Record<Timeframe, Candle>>, cutoff: number): void {
    for (const tf of this.timeframes) {
      const seed = seeds[tf];
      if (seed) {
        this.open.set(tf, { ...seed, empty: seed.volume === 0 });
        this.lastPrice = seed.close;
      } else {
        this.open.delete(tf);
      }
    }
    this.seeding = false;
    const buffered = this.buffer;
    this.buffer = [];
    for (const t of buffered) if (t.time > cutoff) this.applyTrade(t);
  }

  /** Returns false if the trade was only buffered. */
  applyTrade(trade: Trade): boolean {
    if (this.seeding) {
      if (this.buffer.length < this.maxBuffer) this.buffer.push(trade);
      return false;
    }
    for (const tf of this.timeframes) {
      const start = bucketStart(tf, trade.time);
      const cur = this.open.get(tf);
      if (!cur || start > cur.time) {
        this.open.set(tf, {
          time: start, open: trade.price, high: trade.price, low: trade.price,
          close: trade.price, volume: trade.qty, empty: false,
        });
      } else if (start === cur.time) {
        if (cur.empty) {
          cur.open = cur.high = cur.low = trade.price;
          cur.empty = false;
        }
        if (trade.price > cur.high) cur.high = trade.price;
        if (trade.price < cur.low) cur.low = trade.price;
        cur.close = trade.price;
        cur.volume += trade.qty;
      }
      // start < cur.time: late trade for an already-closed bucket; ignored.
    }
    this.lastPrice = trade.price;
    return true;
  }

  /**
   * Advance any candle whose bucket has ended to a flat, zero-volume candle at the bucket
   * containing `now`, the same way the exchange emits klines for intervals without trades.
   * Returns true if anything rolled.
   */
  rollTo(now: number): boolean {
    if (this.seeding) return false;
    let rolled = false;
    for (const tf of this.timeframes) {
      const cur = this.open.get(tf);
      if (!cur || now < nextBucket(tf, cur.time)) continue;
      const p = cur.close;
      this.open.set(tf, { time: bucketStart(tf, now), open: p, high: p, low: p, close: p, volume: 0, empty: true });
      rolled = true;
    }
    return rolled;
  }

  get(tf: Timeframe): Candle | undefined {
    const c = this.open.get(tf);
    return c && { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  }

  get price(): number | null {
    return this.lastPrice;
  }

  snapshot(): Partial<Record<Timeframe, CandleTuple>> {
    const out: Partial<Record<Timeframe, CandleTuple>> = {};
    for (const [tf, c] of this.open) out[tf] = toTuple(c);
    return out;
  }
}
