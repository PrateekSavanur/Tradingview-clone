import { timingSafeEqual } from 'node:crypto';
import { AlertSpecError, normalizeSpec } from '@chartdeck/alert-engine';
import type { MarketDataProvider } from '@chartdeck/data-providers';
import { ProviderError } from '@chartdeck/data-providers';
import {
  DOC_NAME_RE, DOC_SCHEMAS, DrawingSet, MAX_ALERTS_PER_USER, MAX_DOCS_PER_KIND, SINGLETON_DOC_KINDS, TIMEFRAMES, isSymbolId, parseSymbolId, toTuple,
  type DocKind, type SymbolInfo,
} from '@chartdeck/shared';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlertBus } from './alert-bus.ts';
import type { Auth } from './auth.ts';
import type { AlertStore, DocStore, DrawingStore, UserStore } from './db.ts';
import type { HistoryService } from './history.ts';

export interface AppDeps {
  providers: Map<string, MarketDataProvider>;
  history: HistoryService;
  /** Null when no database is configured; account features then answer 503. */
  auth: Auth | null;
  drawings: DrawingStore | null;
  docs: DocStore | null;
  /** Alerts need the database and Redis; without either they answer 503. */
  alerts: { store: AlertStore; users: UserStore; bus: AlertBus } | null;
  ready: () => Promise<boolean>;
  metrics: () => Promise<{ contentType: string; body: string }>;
  rateLimitPerMinute: number;
  /** Requests carrying this in `x-internal-token` (the alerts service) skip the rate limit. */
  internalToken?: string;
  trustProxy: boolean;
  logger: boolean | object;
}

const HistoryQuery = z.object({
  symbol: z.string().refine((s) => parseSymbolId(s) !== null, 'invalid symbol id'),
  tf: z.enum(TIMEFRAMES),
  to: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const SymbolQuery = z.object({ symbol: z.string().refine(isSymbolId, 'invalid symbol id') });
const DrawingsBody = z.object({ drawings: DrawingSet });
const DocParams = z
  .object({
    kind: z.enum(Object.keys(DOC_SCHEMAS) as [DocKind, ...DocKind[]]),
    name: z.string().regex(DOC_NAME_RE).optional(),
  })
  .refine((p) => p.name === undefined || !SINGLETON_DOC_KINDS.includes(p.kind) || p.name === 'current', {
    message: 'this kind only has the document "current"',
    path: ['name'],
  });

const AlertParams = z.object({ id: z.uuid() });
const AlertStatusBody = z.object({ status: z.enum(['active', 'paused']) });
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});
/** Open alert streams per user (tabs × devices). */
const MAX_STREAMS_PER_USER = 10;

const SearchQuery = z.object({
  q: z.string().max(40).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger, trustProxy: deps.trustProxy });

  await app.register(cookie);
  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url.split('?')[0]!) || isInternal(req.headers['x-internal-token'], deps.internalToken),
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request', issues: err.issues });
    if (err instanceof AlertSpecError) return reply.status(400).send({ error: 'invalid_alert', message: err.message });
    if (err instanceof ProviderError) {
      if (err.retryAt) reply.header('retry-after', Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)));
      return reply.status(err.status === 429 ? 503 : err.status).send({ error: 'provider_error', message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : err.message });
  });

  app.get('/healthz', async () => 'ok');
  app.get('/readyz', async (_req, reply) => ((await deps.ready().catch(() => false)) ? 'ready' : reply.status(503).send('not ready')));
  app.get('/metrics', async (_req, reply) => {
    const m = await deps.metrics();
    return reply.header('content-type', m.contentType).send(m.body);
  });

  app.get('/api/providers', async () =>
    [...deps.providers.values()].map((p) => ({ id: p.id, name: p.name, timeframes: p.timeframes })),
  );

  app.get('/api/symbols/search', async (req) => {
    const { q, limit } = SearchQuery.parse(req.query);
    const results = await Promise.allSettled([...deps.providers.values()].map((p) => p.searchSymbols(q, limit)));
    const merged: SymbolInfo[] = [];
    for (const r of results) if (r.status === 'fulfilled') merged.push(...r.value);
    if (!merged.length && results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    return merged.slice(0, limit);
  });

  app.get<{ Params: { id: string } }>('/api/symbols/:id', async (req, reply) => {
    const parsed = parseSymbolId(req.params.id);
    const provider = parsed && deps.providers.get(parsed.provider);
    const info = provider && (await provider.getSymbol(parsed.ticker));
    return info ?? reply.status(404).send({ error: 'unknown_symbol' });
  });

  app.get('/api/history', async (req, reply) => {
    const q = HistoryQuery.parse(req.query);
    const { provider, ticker } = parseSymbolId(q.symbol)!;
    const res = await deps.history.get(provider, ticker, q.tf, q.to, q.limit);
    reply.header('x-history-source', res.source);
    reply.header('cache-control', 'no-store');
    return { symbol: q.symbol, tf: q.tf, candles: res.candles.map(toTuple) };
  });

  if (deps.auth && deps.drawings && deps.docs) {
    const { auth, drawings, docs } = deps;
    auth.register(app);

    app.get('/api/drawings', { preHandler: auth.requireUser }, async (req) => {
      const { symbol } = SymbolQuery.parse(req.query);
      const row = await drawings.get(req.user!.id, symbol);
      return { symbol, drawings: row?.drawings ?? [], updatedAt: row?.updatedAt ?? null };
    });

    app.put('/api/drawings', { preHandler: auth.requireUser, bodyLimit: 512 * 1024 }, async (req) => {
      const { symbol } = SymbolQuery.parse(req.query);
      const body = DrawingsBody.parse(req.body);
      const updatedAt = await drawings.put(req.user!.id, symbol, body.drawings);
      return { symbol, updatedAt };
    });

    app.get('/api/docs/:kind', { preHandler: auth.requireUser }, async (req) => {
      const { kind } = DocParams.parse(req.params);
      return docs.list(req.user!.id, kind);
    });

    app.get('/api/docs/:kind/:name', { preHandler: auth.requireUser }, async (req, reply) => {
      const { kind, name } = DocParams.parse(req.params);
      const doc = await docs.get(req.user!.id, kind, name!);
      return doc ?? reply.status(404).send({ error: 'not_found' });
    });

    app.put('/api/docs/:kind/:name', { preHandler: auth.requireUser, bodyLimit: 256 * 1024 }, async (req, reply) => {
      const { kind, name } = DocParams.parse(req.params);
      const data = DOC_SCHEMAS[kind].parse((req.body as { data?: unknown } | null)?.data);
      const updatedAt = await docs.put(req.user!.id, kind, name!, data, MAX_DOCS_PER_KIND);
      if (updatedAt === null) return reply.status(409).send({ error: 'limit_reached', message: `At most ${MAX_DOCS_PER_KIND} ${kind}` });
      return { name, updatedAt };
    });

    app.delete('/api/docs/:kind/:name', { preHandler: auth.requireUser }, async (req, reply) => {
      const { kind, name } = DocParams.parse(req.params);
      return (await docs.delete(req.user!.id, kind, name!)) ? { ok: true } : reply.status(404).send({ error: 'not_found' });
    });
    if (deps.alerts) registerAlerts(app, auth, deps.alerts);
    else {
      const noAlerts = async (_req: unknown, reply: { status(n: number): { send(b: unknown): unknown } }) =>
        reply.status(503).send({ error: 'alerts_unavailable', message: 'Alerts need REDIS_URL to be configured' });
      app.all('/api/alerts', noAlerts);
      app.all('/api/alerts/*', noAlerts);
    }
  } else {
    const unavailable = async (_req: unknown, reply: { status(n: number): { send(b: unknown): unknown } }) =>
      reply.status(503).send({ error: 'accounts_unavailable', message: 'Accounts need DATABASE_URL to be configured' });
    app.all('/api/auth/*', unavailable);
    app.all('/api/drawings', unavailable);
    app.all('/api/docs/*', unavailable);
    app.all('/api/alerts', unavailable);
    app.all('/api/alerts/*', unavailable);
  }

  return app;
}

function isInternal(header: string | string[] | undefined, token: string | undefined): boolean {
  if (!token || typeof header !== 'string' || header.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(token));
}

function registerAlerts(app: FastifyInstance, auth: Auth, { store, users, bus }: NonNullable<AppDeps['alerts']>): void {
  const guard = { preHandler: auth.requireUser };

  /** Email notifications only go to confirmed addresses, so nobody can point alert mail at someone else. */
  const parseSpec = async (userId: string, body: unknown) => {
    const spec = normalizeSpec((body as { spec?: unknown } | null)?.spec);
    if (spec.notify.email && !(await users.byId(userId))?.email_verified_at) {
      throw new AlertSpecError('Confirm your email address to get alerts by email');
    }
    return spec;
  };

  app.get('/api/alerts', guard, async (req) => ({ alerts: await store.list(req.user!.id) }));

  app.post('/api/alerts', guard, async (req, reply) => {
    const userId = req.user!.id;
    const alert = await store.create(userId, await parseSpec(userId, req.body), MAX_ALERTS_PER_USER);
    if (!alert) return reply.status(409).send({ error: 'limit_reached', message: `At most ${MAX_ALERTS_PER_USER} alerts` });
    await bus.changed(userId, alert.id);
    return reply.status(201).send(alert);
  });

  app.put('/api/alerts/:id', guard, async (req, reply) => {
    const userId = req.user!.id;
    const { id } = AlertParams.parse(req.params);
    const alert = await store.update(userId, id, await parseSpec(userId, req.body));
    if (!alert) return reply.status(404).send({ error: 'not_found' });
    await bus.changed(userId, id);
    return alert;
  });

  app.post('/api/alerts/:id/status', guard, async (req, reply) => {
    const userId = req.user!.id;
    const { id } = AlertParams.parse(req.params);
    const { status } = AlertStatusBody.parse(req.body);
    const current = await store.get(userId, id);
    if (!current) return reply.status(404).send({ error: 'not_found' });
    if (status === 'active' && current.expiresAt !== null && current.expiresAt <= Date.now()) {
      return reply.status(400).send({ error: 'expired', message: 'This alert has expired; edit it to set a new expiry' });
    }
    const alert = await store.setStatus(userId, id, status);
    await bus.changed(userId, id);
    return alert;
  });

  app.delete('/api/alerts/:id', guard, async (req, reply) => {
    const userId = req.user!.id;
    const { id } = AlertParams.parse(req.params);
    if (!(await store.delete(userId, id))) return reply.status(404).send({ error: 'not_found' });
    await bus.changed(userId, id);
    return { ok: true };
  });

  app.get('/api/alerts/events', guard, async (req) => {
    const q = EventsQuery.parse(req.query);
    return store.events(req.user!.id, q.limit, q.before);
  });

  app.post('/api/alerts/events/read', guard, async (req) => {
    await store.markRead(req.user!.id);
    return { ok: true };
  });

  app.delete('/api/alerts/events', guard, async (req) => {
    await store.clearEvents(req.user!.id);
    return { ok: true };
  });

  // Server-sent events: fired alerts and "changed" notices for this user, from any replica.
  const open = new Set<() => void>();
  const perUser = new Map<string, number>();
  // Before the server stops accepting: it waits for open connections, and streams never go idle.
  app.addHook('preClose', async () => open.forEach((end) => end()));

  app.get('/api/alerts/stream', guard, async (req, reply) => {
    const userId = req.user!.id;
    if ((perUser.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) return reply.status(429).send({ error: 'too_many_streams' });
    perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: don't buffer the stream
    });
    res.write('retry: 5000\n: connected\n\n');
    const off = bus.listen(userId, (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
    // Comments keep proxies from timing the connection out and reveal dead clients.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const end = () => {
      if (!open.delete(end)) return;
      off();
      clearInterval(ping);
      const n = (perUser.get(userId) ?? 1) - 1;
      if (n > 0) perUser.set(userId, n);
      else perUser.delete(userId);
      res.end();
    };
    open.add(end);
    req.raw.on('close', end);
  });
}
