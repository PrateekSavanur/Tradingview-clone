/**
 * Email verification, password reset, the alerts API and the alerts service end to end, against
 * the compose Postgres (TEST_DATABASE_URL) and Redis (TEST_REDIS_URL). Candle batches are
 * published straight to Redis, standing in for ingest.
 *
 * Uses its own database: an alerts service from `npm run dev` shares Redis pub/sub (channels
 * ignore the DB number) and would otherwise pick up and fire this test's alerts.
 */
import { randomBytes } from 'node:crypto';
import { MockProvider } from '@chartdeck/data-providers';
import { createLogger, type Mail } from '@chartdeck/service-kit';
import {
  ALERT_REDIS_KEYS, MAX_ALERTS_PER_USER, REDIS_KEYS, toTuple,
  type AlertSpec, type AlertStreamMessage, type Candle, type CandleBatch,
} from '@chartdeck/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertService } from '../../services/alerts/src/service.ts';
import { AlertDb } from '../../services/alerts/src/store.ts';
import { AlertBus } from '../../services/api/src/alert-bus.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { Auth } from '../../services/api/src/auth.ts';
import { AlertStore, Database, DocStore, DrawingStore, UserStore } from '../../services/api/src/db.ts';
import { HistoryService } from '../../services/api/src/history.ts';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://chartdeck:chartdeck@127.0.0.1:55432/chartdeck';
const DB_NAME = 'chartdeck_alerts_test';
const DB_URL = ADMIN_URL.replace(/\/[^/?]+(\?.*)?$/, `/${DB_NAME}$1`);
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/15';
const ORIGIN = 'http://localhost:5173';
const SYMBOL = `mock:AL${randomBytes(3).toString('hex').toUpperCase()}`;
const T0 = Date.UTC(2026, 9, 28, 10, 0);

const log = createLogger('test');
log.level = 'silent';
const mails: Mail[] = [];
const mailer = { send: async (m: Mail) => void mails.push(m) };
const redises: Redis[] = [];
const newRedis = () => {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  redises.push(r);
  return r;
};

let db: Database;
let app: FastifyInstance;
let baseUrl: string;
let service: AlertService;
let alertDb: AlertDb;
const redis = newRedis();

beforeAll(async () => {
  const admin = new pg.Client(ADMIN_URL);
  await admin.connect();
  const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]);
  if (!rowCount) await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  db = new Database(DB_URL);
  await db.migrate();
  const providers = new Map([['mock', new MockProvider()]]);
  const users = new UserStore(db);
  const bus = new AlertBus(newRedis(), newRedis());
  await bus.start();
  app = await buildApp({
    providers,
    history: new HistoryService(providers, null, log),
    auth: new Auth({ users, jwtSecret: randomBytes(32), allowedOrigins: [ORIGIN], credentialRateLimitPerMin: 1000, mailer, publicUrl: ORIGIN }),
    drawings: new DrawingStore(db),
    docs: new DocStore(db),
    alerts: { store: new AlertStore(db), users, bus },
    ready: async () => true,
    metrics: async () => ({ contentType: 'text/plain', body: '' }),
    rateLimitPerMinute: 10_000,
    trustProxy: false,
    logger: false,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  alertDb = new AlertDb(DB_URL);
  service = new AlertService({
    redis: newRedis(), sub: newRedis(), db: alertDb, mailer, log, publicUrl: ORIGIN,
    // History for the test symbol: one closed bar below the alert level.
    history: async () => [bar(0, 95)],
  });
  await service.start();
});

afterAll(async () => {
  await service.stop();
  await app.close();
  await db.pool.query(`DELETE FROM users WHERE email LIKE 'al-%@example.com'`);
  await Promise.allSettled([db.close(), alertDb.close(), ...redises.map((r) => r.quit())]);
});

const bar = (i: number, close: number): Candle => ({ time: T0 + i * 60_000, open: close, high: close, low: close, close, volume: 1 });
const email = () => `al-${randomBytes(6).toString('hex')}@example.com`;

async function register(e = email(), password = 'correct horse battery') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: e, password } });
  const body = res.json() as { accessToken: string; user: { id: string; email: string; emailVerified: boolean } };
  const cookie = res.cookies.find((c) => c.name === 'cd_refresh')?.value;
  return { ...body, email: e, cookie, h: { authorization: `Bearer ${body.accessToken}` } };
}

const tokenFrom = (kind: 'verify' | 'reset', to: string) => {
  const m = [...mails].reverse().find((x) => x.to === to && x.text.includes(`?${kind}=`));
  return m?.text.match(new RegExp(`\\?${kind}=([A-Za-z0-9_-]+)`))?.[1];
};

const spec = (patch: Partial<AlertSpec> = {}): AlertSpec => ({
  symbol: { id: SYMBOL, provider: 'mock', ticker: SYMBOL.slice(5), description: 'Test', exchange: 'Mock', type: 'crypto', tickSize: 0.01 },
  tf: '1m', source: { kind: 'price' }, operator: 'crossing_up', target: { kind: 'value', value: 100 },
  frequency: 'once', expiresAt: null, message: '', notify: { email: false }, ...patch,
});

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('email verification and password reset', () => {
  it('verifies an address with the emailed one-time link', async () => {
    const u = await register();
    expect(u.user.emailVerified).toBe(false);
    const token = await until(() => tokenFrom('verify', u.email), 'verification email');
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } })).statusCode).toBe(400);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: u.h });
    expect(me.json().user.emailVerified).toBe(true);
  });

  it('resets a password, signs out every session and gives no hint about unknown emails', async () => {
    const u = await register();
    await until(() => tokenFrom('verify', u.email), 'signup verification email');
    const before = mails.length;
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', headers: { origin: ORIGIN }, payload: { email: email() } });
    expect(unknown.statusCode).toBe(200);
    expect(mails.length).toBe(before);

    expect((await app.inject({ method: 'POST', url: '/api/auth/password/forgot', headers: { origin: ORIGIN }, payload: { email: u.email } })).statusCode).toBe(200);
    const token = await until(() => tokenFrom('reset', u.email), 'reset email');
    const reset = (password: string) => app.inject({ method: 'POST', url: '/api/auth/password/reset', headers: { origin: ORIGIN }, payload: { token, password } });
    expect((await reset('short')).statusCode).toBe(400);
    expect((await reset('a brand new password')).statusCode).toBe(200);
    expect((await reset('another new password')).statusCode).toBe(400);

    const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { origin: ORIGIN }, cookies: { cd_refresh: u.cookie! } });
    expect(refresh.statusCode).toBe(401);
    const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: u.email, password } });
    expect((await login('correct horse battery')).statusCode).toBe(401);
    const ok = await login('a brand new password');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.emailVerified).toBe(true);
  });
});

describe('alerts api', () => {
  it('creates, lists, pauses, resumes and deletes alerts per user', async () => {
    const u = await register();
    const other = await register();
    const created = await app.inject({ method: 'POST', url: '/api/alerts', headers: u.h, payload: { spec: spec({ frequency: 'once_per_bar' }) } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: u.h })).json().alerts.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: other.h })).json().alerts).toEqual([]);

    for (const [method, url, payload] of [
      ['PUT', `/api/alerts/${id}`, { spec: spec() }],
      ['POST', `/api/alerts/${id}/status`, { status: 'paused' }],
      ['DELETE', `/api/alerts/${id}`, undefined],
    ] as const) {
      expect((await app.inject({ method, url, headers: other.h, payload })).statusCode, `${method} ${url}`).toBe(404);
    }

    const paused = await app.inject({ method: 'POST', url: `/api/alerts/${id}/status`, headers: u.h, payload: { status: 'paused' } });
    expect(paused.json().status).toBe('paused');
    const edited = await app.inject({ method: 'PUT', url: `/api/alerts/${id}`, headers: u.h, payload: { spec: spec({ operator: 'greater' }) } });
    expect(edited.json()).toMatchObject({ status: 'active', operator: 'greater' });
    expect((await app.inject({ method: 'DELETE', url: `/api/alerts/${id}`, headers: u.h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/alerts/${id}`, headers: u.h })).statusCode).toBe(404);
  });

  it('validates conditions and only allows email for verified addresses', async () => {
    const u = await register();
    const bad = [
      spec({ source: { kind: 'indicator', type: 'nope', inputs: {}, plot: 'x' } }),
      spec({ source: { kind: 'indicator', type: 'ichimoku', inputs: {}, plot: 'spanA' } }),
      spec({ target: { kind: 'price' } }),
      spec({ expiresAt: Date.now() - 1000 }),
      { ...spec(), symbol: { ...spec().symbol, id: 'not a symbol' } },
    ];
    for (const s of bad) expect((await app.inject({ method: 'POST', url: '/api/alerts', headers: u.h, payload: { spec: s } })).statusCode).toBe(400);
    const mail = await app.inject({ method: 'POST', url: '/api/alerts', headers: u.h, payload: { spec: spec({ notify: { email: true } }) } });
    expect(mail.statusCode).toBe(400);
    expect(mail.json().message).toMatch(/Confirm your email/);
  });

  it('caps alerts per user', async () => {
    const u = await register();
    await db.pool.query(
      `INSERT INTO alerts (user_id, symbol, spec, status) SELECT $1, $2, $3, 'paused' FROM generate_series(1, $4)`,
      [u.user.id, SYMBOL, JSON.stringify(spec()), MAX_ALERTS_PER_USER],
    );
    const r = await app.inject({ method: 'POST', url: '/api/alerts', headers: u.h, payload: { spec: spec() } });
    expect(r.statusCode).toBe(409);
  });
});

describe('alerts service', () => {
  it('streams the symbol, fires on a crossing, logs it, pushes it to the browser and emails it', async () => {
    const u = await register();
    await db.pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.user.id]);

    // The browser's stream.
    const ctrl = new AbortController();
    const stream = await fetch(`${baseUrl}/api/alerts/stream`, { headers: u.h, signal: ctrl.signal });
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const received: AlertStreamMessage[] = [];
    void (async () => {
      const reader = stream.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (data) received.push(JSON.parse(data.slice(6)) as AlertStreamMessage);
          }
        }
      } catch {
        // aborted
      }
    })();

    const res = await app.inject({ method: 'POST', url: '/api/alerts', headers: u.h, payload: { spec: spec({ notify: { email: true }, message: 'Above 100!' }) } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;

    // The service picks it up from the change notice, asks ingest for the symbol and listens to it.
    await until(async () => (await redis.smembers(ALERT_REDIS_KEYS.demand)).includes(SYMBOL), 'demand registration');
    await until(async () => ((await redis.pubsub('NUMSUB', REDIS_KEYS.candleChannel(SYMBOL))) as [string, number])[1] > 0, 'candle subscription');

    const publish = (close: number) => {
      const batch: CandleBatch = { s: SYMBOL, ep: 1, c: { '1m': toTuple(bar(1, close)) }, et: Date.now(), ri: Date.now(), pi: Date.now(), xo: 0 };
      return redis.publish(REDIS_KEYS.candleChannel(SYMBOL), JSON.stringify(batch));
    };
    await publish(99);
    await publish(101);
    await publish(103); // a one-shot alert must not fire twice

    const fired = await until(() => received.find((m) => m.type === 'fired'), 'fired message on the stream');
    expect(fired).toMatchObject({ type: 'fired', alertId: id, status: 'triggered', event: { message: 'Above 100!', price: 101, value: 101, target: 100 } });

    const alerts = (await app.inject({ method: 'GET', url: '/api/alerts', headers: u.h })).json().alerts;
    expect(alerts[0]).toMatchObject({ id, status: 'triggered', fireCount: 1 });
    const events = (await app.inject({ method: 'GET', url: '/api/alerts/events', headers: u.h })).json();
    expect(events.unread).toBe(1);
    expect(events.events).toHaveLength(1);
    await app.inject({ method: 'POST', url: '/api/alerts/events/read', headers: u.h });
    expect((await app.inject({ method: 'GET', url: '/api/alerts/events', headers: u.h })).json().unread).toBe(0);

    const mail = await until(() => mails.find((m) => m.to === u.email && m.subject.includes('Above 100!')), 'alert email');
    expect(mail.text).toContain('101.00');
    // Triggered: the symbol is no longer needed.
    await until(async () => !(await redis.smembers(ALERT_REDIS_KEYS.demand)).includes(SYMBOL), 'demand released');
    ctrl.abort();
  });
});
