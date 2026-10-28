import { createProviders } from '@chartdeck/data-providers';
import { randomBytes } from 'node:crypto';
import { createLogger, env, envInt, initMetrics, onShutdown } from '@chartdeck/service-kit';
import { buildApp } from './app.ts';
import { Auth } from './auth.ts';
import { CandleStore, Database, DocStore, DrawingStore, UserStore } from './db.ts';
import { HistoryService } from './history.ts';

const log = createLogger('api');
const registry = initMetrics('api');

const providers = createProviders({
  enabled: process.env.PROVIDERS || 'binance',
  binanceRestUrl: process.env.BINANCE_REST_URL || undefined,
  binanceWsUrl: process.env.BINANCE_WS_URL || undefined,
});

let db: Database | null = null;
if (process.env.DATABASE_URL) {
  db = new Database(process.env.DATABASE_URL);
  for (let attempt = 1; ; attempt++) {
    try {
      await db.migrate();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ err: (err as Error).message, attempt }, 'database not ready; retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log.info('database ready');
} else {
  log.warn('DATABASE_URL not set; history is uncached and accounts/drawing sync are disabled');
}

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  // Fine for one replica: access tokens just stop verifying on restart and clients refresh.
  // Multiple replicas must share a secret.
  jwtSecret = randomBytes(32).toString('base64');
  log.warn('JWT_SECRET not set; using a random per-process secret');
} else if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
const allowedOrigins = env('ALLOWED_ORIGINS', 'http://localhost:5173,http://localhost:3000').split(',').map((s) => s.trim());
const auth = db
  ? new Auth({
      users: new UserStore(db),
      jwtSecret: new TextEncoder().encode(jwtSecret),
      allowedOrigins,
      secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : undefined,
    })
  : null;

const app = await buildApp({
  providers,
  history: new HistoryService(providers, db && new CandleStore(db), log),
  auth,
  drawings: db && new DrawingStore(db),
  docs: db && new DocStore(db),
  ready: async () => (db ? db.ping() : true),
  metrics: async () => ({ contentType: registry.contentType, body: await registry.metrics() }),
  rateLimitPerMinute: envInt('API_RATE_LIMIT_PER_MIN', 300),
  trustProxy: process.env.TRUST_PROXY === 'true',
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.listen({ port: envInt('API_PORT', 8081), host: '0.0.0.0' });

onShutdown(log, async () => {
  await app.close();
  await db?.close();
});
