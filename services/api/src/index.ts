import { createProviders } from '@chartdeck/data-providers';
import { randomBytes } from 'node:crypto';
import { createLogger, env, envInt, initMetrics, mailerFromEnv, onShutdown } from '@chartdeck/service-kit';
import { Redis } from 'ioredis';
import { AlertBus } from './alert-bus.ts';
import { buildApp } from './app.ts';
import { Auth } from './auth.ts';
import { AlertStore, CandleStore, Database, DocStore, DrawingStore, UserStore } from './db.ts';
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
const users = db && new UserStore(db);
const auth = users
  ? new Auth({
      users,
      jwtSecret: new TextEncoder().encode(jwtSecret),
      allowedOrigins,
      secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : undefined,
      mailer: mailerFromEnv(log),
      // Links in emails; defaults to the first allowed origin.
      publicUrl: process.env.PUBLIC_URL || allowedOrigins.find((o) => o !== '*') || 'http://localhost:5173',
    })
  : null;

// Alerts need Redis to reach the alerts service and every api replica's open streams.
let redis: Redis | null = null;
let redisSub: Redis | null = null;
let alertBus: AlertBus | null = null;
if (db && process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  redisSub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err) => log.error({ err }, 'redis error'));
  redisSub.on('error', (err) => log.error({ err }, 'redis subscriber error'));
  alertBus = new AlertBus(redis, redisSub);
  await alertBus.start();
} else if (db) {
  log.warn('REDIS_URL not set; alerts are disabled');
}

const app = await buildApp({
  providers,
  history: new HistoryService(providers, db && new CandleStore(db), log),
  auth,
  drawings: db && new DrawingStore(db),
  docs: db && new DocStore(db),
  alerts: db && users && alertBus ? { store: new AlertStore(db), users, bus: alertBus } : null,
  ready: async () => (db ? db.ping() : true) && (!redis || redis.status === 'ready'),
  metrics: async () => ({ contentType: registry.contentType, body: await registry.metrics() }),
  rateLimitPerMinute: envInt('API_RATE_LIMIT_PER_MIN', 300),
  internalToken: process.env.INTERNAL_TOKEN || undefined,
  trustProxy: process.env.TRUST_PROXY === 'true',
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.listen({ port: envInt('API_PORT', 8081), host: '0.0.0.0' });

onShutdown(log, async () => {
  await app.close();
  await Promise.allSettled([db?.close(), redis?.quit(), redisSub?.quit()]);
});
