import type { Candle, ProviderState, SymbolInfo, Timeframe } from '@chartdeck/shared';

export interface ProviderTrade {
  ticker: string;
  price: number;
  qty: number;
  /** Trade time (exchange clock, ms). */
  time: number;
  /** Event time the exchange stamped on the message (exchange clock, ms). */
  eventTime: number;
  /** Local time the message was received (ms). */
  receivedAt: number;
}

export interface CandleQuery {
  /** Inclusive lower bound on candle open time (ms). */
  startTime?: number;
  /** Inclusive upper bound on candle open time (ms). Omit for the most recent candles. */
  endTime?: number;
  limit: number;
}

export interface StreamHandlers {
  onTrade(trade: ProviderTrade): void;
  onState(state: ProviderState): void;
  /** Fired after the upstream connection was lost and re-established; buffered state must be re-seeded. */
  onReconnected(): void;
}

/** A live trade feed. One instance multiplexes every subscribed ticker for its provider. */
export interface TradeStream {
  /** Replace the subscribed set. Implementations diff and throttle upstream subscribe calls. */
  setTickers(tickers: Iterable<string>): void;
  close(): void;
}

/**
 * The contract every data source implements. History and symbol lookups are request/response;
 * live data is a push stream of raw trades that the candle-aggregator folds into candles.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  /** Timeframes this provider can serve history for. */
  readonly timeframes: readonly Timeframe[];
  searchSymbols(query: string, limit: number): Promise<SymbolInfo[]>;
  getSymbol(ticker: string): Promise<SymbolInfo | null>;
  /** Candles in ascending time order. May include the still-open candle. */
  getCandles(ticker: string, tf: Timeframe, query: CandleQuery): Promise<Candle[]>;
  /** Provider clock (ms), used to compute the exchange clock offset. */
  serverTime(): Promise<number>;
  openStream(handlers: StreamHandlers): TradeStream;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Epoch ms after which the caller may retry; set for rate limits and bans. */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}
