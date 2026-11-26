import { TIMEFRAMES, type Timeframe } from './timeframes.ts';

/**
 * Markets group providers in the UI (search tabs, watchlist sections) and decide which
 * timeframes are offered. Crypto trades around the clock; stock markets have sessions.
 */
export const MARKET_IDS = ['crypto', 'india', 'us'] as const;
export type MarketId = (typeof MARKET_IDS)[number];

export interface MarketInfo {
  id: MarketId;
  label: string;
  /** Regular session in exchange-local time, Monday to Friday. Absent for 24/7 markets. */
  session?: { tz: string; open: string; close: string };
  /** Shown next to prices from this market, e.g. "Yahoo Finance, ~1 min delayed". */
  dataNote?: string;
}

export const MARKETS: Record<MarketId, MarketInfo> = {
  crypto: { id: 'crypto', label: 'Crypto' },
  india: {
    id: 'india', label: 'India',
    session: { tz: 'Asia/Kolkata', open: '09:15', close: '15:30' },
    dataNote: 'NSE/BSE via Yahoo Finance, refreshed every minute',
  },
  us: {
    id: 'us', label: 'US',
    session: { tz: 'America/New_York', open: '09:30', close: '16:00' },
    dataNote: 'US stocks via Yahoo Finance, refreshed every minute',
  },
};

/** Provider id -> market. Unknown providers (binance, mock) are crypto. */
export function marketOfProvider(provider: string): MarketId {
  return provider === 'india' || provider === 'us' ? provider : 'crypto';
}

export const marketOfSymbol = (symbolId: string): MarketId => marketOfProvider(symbolId.split(':')[0] ?? '');

const STOCK_TIMEFRAMES = TIMEFRAMES.filter((tf) => tf !== '1s');

/** Timeframes a market's charts offer. Stock data has no sub-minute bars. */
export function marketTimeframes(market: MarketId): readonly Timeframe[] {
  return market === 'crypto' ? TIMEFRAMES : STOCK_TIMEFRAMES;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Whether the regular session is open at `now`, from the weekly schedule alone (exchange
 * holidays are not known here). Always true for 24/7 markets.
 */
export function isSessionOpen(market: MarketId, now = Date.now()): boolean {
  const s = MARKETS[market].session;
  if (!s) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: s.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = WEEKDAY[get('weekday')] ?? 0;
  if (day === 0 || day === 6) return false;
  const hm = `${get('hour')}:${get('minute')}`;
  return hm >= s.open && hm < s.close;
}
