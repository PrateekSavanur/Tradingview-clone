/**
 * Accounts and drawing persistence against a real Postgres/TimescaleDB.
 * Requires TEST_DATABASE_URL (default: the compose instance on 127.0.0.1:55432).
 */
import { randomBytes } from 'node:crypto';
import { MockProvider } from '@chartdeck/data-providers';
import { createLogger } from '@chartdeck/service-kit';
import type { Drawing } from '@chartdeck/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/api/src/app.ts';
import { Auth } from '../../services/api/src/auth.ts';
import { Database, DocStore, DrawingStore, UserStore } from '../../services/api/src/db.ts';
import { HistoryService } from '../../services/api/src/history.ts';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://chartdeck:chartdeck@127.0.0.1:55432/chartdeck';
const ORIGIN = 'http://localhost:5173';
const noMail = { send: async () => {} };
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  db = new Database(DB_URL);
  await db.migrate();
  const log = createLogger('test');
  log.level = 'silent';
  const providers = new Map([['mock', new MockProvider()]]);
  app = await buildApp({
    providers,
    history: new HistoryService(providers, null, log),
    auth: new Auth({ users: new UserStore(db), jwtSecret: randomBytes(32), allowedOrigins: [ORIGIN], credentialRateLimitPerMin: 1000, mailer: noMail, publicUrl: ORIGIN }),
    drawings: new DrawingStore(db),
    docs: new DocStore(db),
    alerts: null,
    ready: async () => true,
    metrics: async () => ({ contentType: 'text/plain', body: '' }),
    rateLimitPerMinute: 1000,
    trustProxy: false,
    logger: false,
  });
});

afterAll(async () => {
  await app.close();
  await db.pool.query(`DELETE FROM users WHERE email LIKE 't-%@example.com'`); // cascades tokens and drawings
  await db.close();
});

const email = () => `t-${randomBytes(6).toString('hex')}@example.com`;
const refreshCookie = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.find((c) => c.name === 'cd_refresh')?.value;

async function register(e = email(), password = 'correct horse battery') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: e, password } });
  return { res, body: res.json() as { accessToken: string; user: { id: string; email: string } }, cookie: refreshCookie(res) };
}

const sampleDrawing = (overrides: Partial<Drawing> = {}): Drawing => ({
  id: 'abc123def', type: 'trendline', updatedAt: 1,
  points: [{ time: 1_700_000_000_000, price: 100 }, { time: 1_700_000_060_000, price: 105 }],
  style: { color: '#2962ff', width: 2, dash: 'solid' },
  ...overrides,
});

describe('auth', () => {
  it('registers, sets an httpOnly refresh cookie and returns a working access token', async () => {
    const e = email();
    const { res, body } = await register(e);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'cd_refresh')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.json()).toEqual({ user: { id: body.user.id, email: e, emailVerified: false } });
  });

  it('normalises email and rejects duplicates and weak passwords', async () => {
    const e = email();
    expect((await register(e.toUpperCase())).res.statusCode).toBe(200);
    expect((await register(e)).res.statusCode).toBe(409);
    expect((await register(email(), 'short')).res.statusCode).toBe(400);
  });

  it('logs in with the right password only', async () => {
    const e = email();
    await register(e, 'a good long password');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: e, password: 'wrong password!!' } });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: email(), password: 'whatever12345' } });
    expect(unknown.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: e, password: 'a good long password' } });
    expect(ok.statusCode).toBe(200);
  });

  it('rotates refresh tokens and revokes the family when an old token is replayed', async () => {
    const { cookie: first } = await register();
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cd_refresh: first! } });
    expect(r1.statusCode).toBe(200);
    const second = refreshCookie(r1)!;
    expect(second).not.toBe(first);

    // Within the grace window a replay (two tabs refreshing together) is tolerated.
    const replayNow = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cd_refresh: first! } });
    expect(replayNow.statusCode).toBe(200);

    // Age the rotation past the grace window, then replay: the whole family dies.
    await db.pool.query(`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE used_at IS NOT NULL`);
    const replayLate = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cd_refresh: first! } });
    expect(replayLate.statusCode).toBe(401);
    const afterTheft = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cd_refresh: refreshCookie(replayNow)! } });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('logout revokes the session immediately (no grace window)', async () => {
    const { cookie } = await register();
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { cd_refresh: cookie! } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cd_refresh: cookie! } });
    expect(r.statusCode).toBe(401);
  });

  it('rate-limits credential endpoints by default', async () => {
    const { Auth: A } = await import('../../services/api/src/auth.ts');
    const log = createLogger('t');
    log.level = 'silent';
    const providers = new Map([['mock', new MockProvider()]]);
    const strictApp = await buildApp({
      providers, history: new HistoryService(providers, null, log),
      auth: new A({ users: new UserStore(db), jwtSecret: randomBytes(32), allowedOrigins: [ORIGIN], mailer: noMail, publicUrl: ORIGIN }),
      drawings: new DrawingStore(db), docs: new DocStore(db), alerts: null, ready: async () => true,
      metrics: async () => ({ contentType: 'text/plain', body: '' }), rateLimitPerMinute: 1000, trustProxy: false, logger: false,
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await strictApp.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'whatever12345' } })).statusCode);
    }
    await strictApp.close();
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('rejects cookie-authenticated calls from foreign origins', async () => {
    const { cookie } = await register();
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { origin: 'https://evil.example' }, cookies: { cd_refresh: cookie! } });
    expect(r.statusCode).toBe(403);
  });
});

describe('drawings', () => {
  it('requires auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/drawings?symbol=binance:BTCUSDT' });
    expect(r.statusCode).toBe(401);
  });

  it('stores drawings per user per symbol', async () => {
    const a = await register();
    const b = await register();
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    const put = await app.inject({
      method: 'PUT', url: '/api/drawings?symbol=binance:BTCUSDT', headers: auth(a.body.accessToken),
      payload: { drawings: [sampleDrawing()] },
    });
    expect(put.statusCode).toBe(200);

    const mine = await app.inject({ method: 'GET', url: '/api/drawings?symbol=binance:BTCUSDT', headers: auth(a.body.accessToken) });
    expect(mine.json().drawings).toEqual([sampleDrawing()]);
    const otherSymbol = await app.inject({ method: 'GET', url: '/api/drawings?symbol=binance:ETHUSDT', headers: auth(a.body.accessToken) });
    expect(otherSymbol.json().drawings).toEqual([]);
    const otherUser = await app.inject({ method: 'GET', url: '/api/drawings?symbol=binance:BTCUSDT', headers: auth(b.body.accessToken) });
    expect(otherUser.json().drawings).toEqual([]);
  });

  it('validates drawing payloads', async () => {
    const { body } = await register();
    const headers = { authorization: `Bearer ${body.accessToken}` };
    const bad = [
      sampleDrawing({ points: [{ time: 1, price: 1 }] }), // trendline needs 2 points
      sampleDrawing({ style: { color: 'red', width: 2, dash: 'solid' } }),
      sampleDrawing({ id: '../../etc' }),
      sampleDrawing({ type: 'text', points: [{ time: 1, price: 1 }], text: 'x'.repeat(501) }),
    ];
    for (const d of bad) {
      const r = await app.inject({ method: 'PUT', url: '/api/drawings?symbol=binance:BTCUSDT', headers, payload: { drawings: [d] } });
      expect(r.statusCode, JSON.stringify(d)).toBe(400);
    }
  });
});

describe('user docs (layouts, templates, watchlists, workspace)', () => {
  const btc = { id: 'binance:BTCUSDT', provider: 'binance', ticker: 'BTCUSDT', description: 'BTC / USDT', exchange: 'Binance', type: 'crypto', tickSize: 0.01 };
  const workspace = {
    layout: '2', active: 0, sync: { symbol: false, interval: false, crosshair: true, time: false },
    charts: [
      { symbol: btc, tf: '1m', chartType: 'candles', indicators: [] },
      { symbol: btc, tf: '1h', chartType: 'heikin', indicators: [{ uid: 'abcd1234', type: 'rsi', inputs: { length: 14, source: 'close' }, plots: { rsi: { color: '#7e57c2', width: 2, visible: true } }, hidden: false }] },
    ],
  };

  it('stores, lists, reads and deletes named layouts per user', async () => {
    const { body } = await register();
    const other = await register();
    const h = { authorization: `Bearer ${body.accessToken}` };
    expect((await app.inject({ method: 'PUT', url: '/api/docs/layouts/Scalping%20setup', headers: h, payload: { data: workspace } })).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/docs/layouts', headers: h });
    expect(list.json().map((d: { name: string }) => d.name)).toEqual(['Scalping setup']);
    const got = await app.inject({ method: 'GET', url: '/api/docs/layouts/Scalping%20setup', headers: h });
    expect(got.json().data).toEqual(workspace);
    const foreign = await app.inject({ method: 'GET', url: '/api/docs/layouts/Scalping%20setup', headers: { authorization: `Bearer ${other.body.accessToken}` } });
    expect(foreign.statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/docs/layouts/Scalping%20setup', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/docs/layouts/Scalping%20setup', headers: h })).statusCode).toBe(404);
  });

  it('validates each kind against its schema', async () => {
    const { body } = await register();
    const h = { authorization: `Bearer ${body.accessToken}` };
    const bad = [
      ['layouts', { ...workspace, layout: '9' }],
      ['workspace', { ...workspace, charts: [] }],
      ['templates', { indicators: [{ uid: '<script>', type: 'rsi', inputs: {}, plots: {}, hidden: false }] }],
      ['watchlists', { active: 0, lists: [{ name: 'x', symbols: [{ ...btc, id: 'not a symbol' }] }] }],
      ['watchlists', { active: 1, lists: [{ name: 'x', symbols: [] }] }],
      ['workspace', { ...workspace, active: 2 }],
    ] as const;
    for (const [kind, data] of bad) {
      const r = await app.inject({ method: 'PUT', url: `/api/docs/${kind}/current`, headers: h, payload: { data } });
      expect(r.statusCode, kind).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/docs/secrets/current', headers: h, payload: { data: {} } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/docs/workspace/other', headers: h, payload: { data: workspace } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/docs/watchlists/current', headers: h, payload: { data: { active: 0, lists: [{ name: 'Crypto', symbols: [btc] }] } } })).statusCode).toBe(200);
  });

  it('caps the number of documents per kind', async () => {
    const { body } = await register();
    const h = { authorization: `Bearer ${body.accessToken}` };
    await db.pool.query(
      `INSERT INTO user_docs (user_id, kind, name, data) SELECT $1, 'templates', 't' || g, '{"indicators":[]}' FROM generate_series(1, 100) g`,
      [body.user.id],
    );
    const r = await app.inject({ method: 'PUT', url: '/api/docs/templates/one-more', headers: h, payload: { data: { indicators: [] } } });
    expect(r.statusCode).toBe(409);
    const overwrite = await app.inject({ method: 'PUT', url: '/api/docs/templates/t1', headers: h, payload: { data: { indicators: [] } } });
    expect(overwrite.statusCode).toBe(200);
  });
});
