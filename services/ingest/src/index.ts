import { createProviders } from '@chartdeck/data-providers';
import { createLogger, env, envInt, initMetrics, onShutdown, startOpsServer } from '@chartdeck/service-kit';
import { REDIS_KEYS, parseSymbolId } from '@chartdeck/shared';
import { Redis } from 'ioredis';
import { ProviderFeed } from './feed.ts';

const log = createLogger('ingest');
initMetrics('ingest');

const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.error({ err }, 'redis error'));
sub.on('error', (err) => log.error({ err }, 'redis subscriber error'));

const providers = createProviders({
  enabled: env('PROVIDERS', 'binance'),
  binanceRestUrl: process.env.BINANCE_REST_URL || undefined,
  binanceWsUrl: process.env.BINANCE_WS_URL || undefined,
});

const feeds = new Map<string, ProviderFeed>();
for (const p of providers.values()) {
  feeds.set(p.id, new ProviderFeed(p, redis, log, {
    flushMs: envInt('INGEST_FLUSH_MS', 25),
    lingerMs: envInt('INGEST_LINGER_MS', 60_000),
    hotTtlSec: envInt('HOT_CACHE_TTL_SEC', 120),
  }));
}

/** Union of every live gateway's demand set, grouped by provider. */
async function refreshDemand(): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', REDIS_KEYS.demandPattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  const ids = keys.length ? await redis.sunion(...keys) : [];
  const byProvider = new Map<string, Set<string>>([...feeds.keys()].map((k) => [k, new Set()]));
  for (const id of ids) {
    const parsed = parseSymbolId(id);
    if (parsed) byProvider.get(parsed.provider)?.add(parsed.ticker);
  }
  for (const [pid, tickers] of byProvider) feeds.get(pid)!.setDemand(tickers);
}

let refreshing = false;
let pending = false;
async function scheduleRefresh(): Promise<void> {
  if (refreshing) {
    pending = true;
    return;
  }
  refreshing = true;
  try {
    do {
      pending = false;
      await refreshDemand();
    } while (pending);
  } catch (err) {
    log.error({ err }, 'demand refresh failed');
  } finally {
    refreshing = false;
  }
}

await sub.subscribe(REDIS_KEYS.demandChanged);
sub.on('message', () => void scheduleRefresh());
const demandTimer = setInterval(() => void scheduleRefresh(), 2_000);
// Re-announce status so gateways that started after us (or missed a message) stay current.
const statusTimer = setInterval(() => feeds.forEach((f) => f.publishStatus()), 10_000);
void scheduleRefresh();

const ops = startOpsServer(envInt('INGEST_OPS_PORT', 9101), () => redis.status === 'ready', log);
log.info({ providers: [...feeds.keys()] }, 'ingest started');

onShutdown(log, async () => {
  clearInterval(demandTimer);
  clearInterval(statusTimer);
  feeds.forEach((f) => f.close());
  ops.close();
  await Promise.allSettled([redis.quit(), sub.quit()]);
});
