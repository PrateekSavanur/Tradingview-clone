import { createProviders } from '@chartdeck/data-providers';
import { createLogger, envInt, initMetrics, onShutdown } from '@chartdeck/service-kit';
import { buildApp } from './app.ts';
import { CandleStore } from './db.ts';
import { HistoryService } from './history.ts';

const log = createLogger('api');
const registry = initMetrics('api');

const providers = createProviders({
  enabled: process.env.PROVIDERS || 'binance',
  binanceRestUrl: process.env.BINANCE_REST_URL || undefined,
  binanceWsUrl: process.env.BINANCE_WS_URL || undefined,
});

let store: CandleStore | null = null;
if (process.env.DATABASE_URL) {
  store = new CandleStore(process.env.DATABASE_URL);
  for (let attempt = 1; ; attempt++) {
    try {
      await store.migrate();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ err: (err as Error).message, attempt }, 'database not ready; retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log.info('candle store ready');
} else {
  log.warn('DATABASE_URL not set; history is served straight from providers with no cache');
}

const app = await buildApp({
  providers,
  history: new HistoryService(providers, store, log),
  ready: async () => (store ? store.ping() : true),
  metrics: async () => ({ contentType: registry.contentType, body: await registry.metrics() }),
  rateLimitPerMinute: envInt('API_RATE_LIMIT_PER_MIN', 300),
  trustProxy: process.env.TRUST_PROXY === 'true',
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.listen({ port: envInt('API_PORT', 8081), host: '0.0.0.0' });

onShutdown(log, async () => {
  await app.close();
  await store?.close();
});
