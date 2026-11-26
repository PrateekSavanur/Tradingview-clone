import { BinanceProvider } from './binance/provider.ts';
import { MockProvider } from './mock/provider.ts';
import type { MarketDataProvider } from './types.ts';
import { YahooClient } from './yahoo/client.ts';
import { INDIA, US } from './yahoo/markets.ts';
import { YahooMarketProvider } from './yahoo/provider.ts';

export interface ProvidersConfig {
  /** Comma-separated provider ids, e.g. `binance,mock`. */
  enabled: string;
  binanceRestUrl?: string;
  binanceWsUrl?: string;
  /** Poll interval per stock symbol during market hours (Yahoo-backed providers). */
  stockPollMs?: number;
  /** Minimum gap between Yahoo requests, shared by every stock provider. */
  yahooMinGapMs?: number;
}

export function createProviders(cfg: ProvidersConfig): Map<string, MarketDataProvider> {
  const out = new Map<string, MarketDataProvider>();
  let yahoo: YahooClient | null = null;
  const stocks = (def: typeof INDIA) =>
    new YahooMarketProvider(def, (yahoo ??= new YahooClient({ minGapMs: cfg.yahooMinGapMs })), { pollMs: cfg.stockPollMs });
  for (const id of cfg.enabled.split(',').map((s) => s.trim()).filter(Boolean)) {
    switch (id) {
      case 'binance':
        out.set(id, new BinanceProvider({ restUrl: cfg.binanceRestUrl, wsUrl: cfg.binanceWsUrl }));
        break;
      case 'india':
        out.set(id, stocks(INDIA));
        break;
      case 'us':
        out.set(id, stocks(US));
        break;
      case 'mock':
        out.set(id, new MockProvider());
        break;
      default:
        throw new Error(`Unknown data provider "${id}"`);
    }
  }
  if (out.size === 0) throw new Error('No data providers enabled (set PROVIDERS)');
  return out;
}
