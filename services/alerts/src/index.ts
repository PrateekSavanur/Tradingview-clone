import { createLogger, env, envInt, initMetrics, mailerFromEnv, onShutdown, startOpsServer } from '@chartdeck/service-kit';
import { fromTuple, type CandleTuple, type Timeframe } from '@chartdeck/shared';
import { Redis } from 'ioredis';
import { AlertService } from './service.ts';
import { AlertDb } from './store.ts';

const log = createLogger('alerts');
initMetrics('alerts');

const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.error({ err }, 'redis error'));
sub.on('error', (err) => log.error({ err }, 'redis subscriber error'));

const db = new AlertDb(env('DATABASE_URL'));
for (let attempt = 1; ; attempt++) {
  const ok = await db.ready().catch(() => false);
  if (ok) break;
  if (attempt >= 60) throw new Error('alert tables missing; is the api (which runs migrations) up?');
  log.warn({ attempt }, 'waiting for the database schema');
  await new Promise((r) => setTimeout(r, 2000));
}

// History comes through the api so it shares its candle cache and provider rate budgeting.
const apiUrl = env('API_URL', 'http://localhost:8081').replace(/\/$/, '');
const internalToken = process.env.INTERNAL_TOKEN;
async function history(symbol: string, tf: Timeframe, limit: number) {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) });
  const res = await fetch(`${apiUrl}/api/history?${qs}`, {
    headers: internalToken ? { 'x-internal-token': internalToken } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`history ${symbol} ${tf}: ${res.status}`);
  return ((await res.json()) as { candles: CandleTuple[] }).candles.map(fromTuple);
}

const service = new AlertService({
  redis, sub, db, history, log,
  mailer: mailerFromEnv(log),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5173',
});
await service.start();

const ops = startOpsServer(envInt('ALERTS_OPS_PORT', 9102), () => redis.status === 'ready' && sub.status === 'ready', log);
log.info({ active: service.activeCount }, 'alerts service started');

onShutdown(log, async () => {
  await service.stop();
  ops.close();
  await Promise.allSettled([redis.quit(), sub.quit(), db.close()]);
});
