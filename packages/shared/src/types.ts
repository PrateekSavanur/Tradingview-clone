/** OHLCV candle. `time` is the bucket open time in epoch milliseconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Compact wire form: [time, open, high, low, close, volume]. */
export type CandleTuple = [number, number, number, number, number, number];

export const toTuple = (c: Candle): CandleTuple => [c.time, c.open, c.high, c.low, c.close, c.volume];
export const fromTuple = (t: CandleTuple): Candle => ({
  time: t[0], open: t[1], high: t[2], low: t[3], close: t[4], volume: t[5],
});

export interface SymbolInfo {
  /** Globally unique id, `<provider>:<ticker>`, e.g. `binance:BTCUSDT`. */
  id: string;
  provider: string;
  ticker: string;
  description: string;
  exchange: string;
  type: 'crypto' | 'stock' | 'index' | 'fx' | 'future';
  /** Smallest price increment, used for price formatting. */
  tickSize: number;
}

export type ProviderState = 'connecting' | 'live' | 'reconnecting' | 'down';
