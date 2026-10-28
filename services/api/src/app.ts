import type { MarketDataProvider } from '@chartdeck/data-providers';
import { ProviderError } from '@chartdeck/data-providers';
import {
  DOC_NAME_RE, DOC_SCHEMAS, DrawingSet, MAX_DOCS_PER_KIND, SINGLETON_DOC_KINDS, TIMEFRAMES, isSymbolId, parseSymbolId, toTuple,
  type DocKind, type SymbolInfo,
} from '@chartdeck/shared';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import type { DocStore, DrawingStore } from './db.ts';
import type { HistoryService } from './history.ts';

export interface AppDeps {
  providers: Map<string, MarketDataProvider>;
  history: HistoryService;
  /** Null when no database is configured; account features then answer 503. */
  auth: Auth | null;
  drawings: DrawingStore | null;
  docs: DocStore | null;
  ready: () => Promise<boolean>;
  metrics: () => Promise<{ contentType: string; body: string }>;
  rateLimitPerMinute: number;
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
    allowList: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url.split('?')[0]!),
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request', issues: err.issues });
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
  } else {
    const unavailable = async (_req: unknown, reply: { status(n: number): { send(b: unknown): unknown } }) =>
      reply.status(503).send({ error: 'accounts_unavailable', message: 'Accounts need DATABASE_URL to be configured' });
    app.all('/api/auth/*', unavailable);
    app.all('/api/drawings', unavailable);
    app.all('/api/docs/*', unavailable);
  }

  return app;
}
