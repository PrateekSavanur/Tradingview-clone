import { BinanceProvider } from './binance/provider.ts';
import { MockProvider } from './mock/provider.ts';
import type { MarketDataProvider } from './types.ts';

export interface ProvidersConfig {
  /** Comma-separated provider ids, e.g. `binance,mock`. */
  enabled: string;
  binanceRestUrl?: string;
  binanceWsUrl?: string;
}

export function createProviders(cfg: ProvidersConfig): Map<string, MarketDataProvider> {
  const out = new Map<string, MarketDataProvider>();
  for (const id of cfg.enabled.split(',').map((s) => s.trim()).filter(Boolean)) {
    switch (id) {
      case 'binance':
        out.set(id, new BinanceProvider({ restUrl: cfg.binanceRestUrl, wsUrl: cfg.binanceWsUrl }));
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
