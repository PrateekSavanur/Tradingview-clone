/**
 * End-to-end WebSocket flow: real ingest + ws-gateway processes, the mock provider, and Redis.
 * Requires Redis at TEST_REDIS_URL (default: the compose instance on 127.0.0.1:56379, DB 15).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import type { ServerMessage } from '@chartdeck/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/15';
const GW_PORT = 18080;
const INGEST_PORT = 19101;
const ORIGIN = 'http://localhost:5173';

const procs: ChildProcess[] = [];

function startService(dir: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'services', dir),
    env: { ...process.env, REDIS_URL, PROVIDERS: 'mock', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(child);
  return child;
}

async function waitReady(url: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} not ready`);
}

/** WebSocket client that records messages and lets tests await specific ones. */
class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];

  constructor(origin = ORIGIN) {
    this.ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/ws`, { headers: { origin } });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  opened(): Promise<unknown> {
    return once(this.ws, 'open');
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeoutMs = 5000) {
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${t}"`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  /** Like `next`, but also matches a message that already arrived. */
  seen<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeoutMs = 5000) {
    const hit = this.messages.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
    return hit ? Promise.resolve(hit as Extract<ServerMessage, { t: T }>) : this.next(t, pred, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  startService('ingest', { INGEST_OPS_PORT: String(INGEST_PORT), INGEST_LINGER_MS: '0' });
  startService('ws-gateway', { GATEWAY_PORT: String(GW_PORT), ALLOWED_ORIGINS: ORIGIN });
  await Promise.all([waitReady(`http://127.0.0.1:${INGEST_PORT}/readyz`), waitReady(`http://127.0.0.1:${GW_PORT}/readyz`)]);
});

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => (p.exitCode === null ? once(p, 'exit') : null)));
});

describe('ws-gateway', () => {
  it('greets, reports provider status and streams live candles after subscribe', async () => {
    const c = new TestClient();
    const hello = c.next('hello');
    await c.opened();
    expect((await hello).v).toBe(1);

    c.send({ op: 'sub', symbol: 'mock:TEST1', tf: '1s' });
    await c.next('subscribed', (m) => m.s === 'mock:TEST1' && m.tf === '1s');
    await c.seen('status', (m) => m.provider === 'mock' && m.state === 'live', 10_000);

    // First frame may be the post-seed snapshot; wait for two to prove it's streaming.
    const a = await c.next('c', (m) => m.s === 'mock:TEST1', 10_000);
    const b = await c.next('c', (m) => m.s === 'mock:TEST1' && m.lat.pi > a.lat.pi);
    for (const m of [a, b]) {
      const [time, open, high, low, close, volume] = m.c;
      expect(time % 1000).toBe(0);
      expect(high).toBeGreaterThanOrEqual(Math.max(open, close));
      expect(low).toBeLessThanOrEqual(Math.min(open, close));
      expect(volume).toBeGreaterThanOrEqual(0);
      expect(m.lat.sg).toBeGreaterThanOrEqual(m.lat.pi);
    }
    c.close();
  });

  it('delivers each subscribed timeframe separately and stops after unsubscribe', async () => {
    const c = new TestClient();
    await c.opened();
    c.send({ op: 'sub', symbol: 'mock:TEST2', tf: '1m' });
    c.send({ op: 'sub', symbol: 'mock:TEST2', tf: '1h' });
    const m1 = await c.next('c', (m) => m.s === 'mock:TEST2' && m.tf === '1m', 10_000);
    const h1 = await c.next('c', (m) => m.s === 'mock:TEST2' && m.tf === '1h', 10_000);
    expect(m1.c[0] % 60_000).toBe(0);
    expect(h1.c[0] % 3_600_000).toBe(0);

    c.send({ op: 'unsub', symbol: 'mock:TEST2', tf: '1m' });
    c.send({ op: 'unsub', symbol: 'mock:TEST2', tf: '1h' });
    await new Promise((r) => setTimeout(r, 300)); // let in-flight frames drain
    const before = c.messages.length;
    await new Promise((r) => setTimeout(r, 1000));
    expect(c.messages.slice(before).filter((m) => m.t === 'c')).toEqual([]);
    c.close();
  });

  it('answers pings with server time for clock sync', async () => {
    const c = new TestClient();
    await c.opened();
    const ct = Date.now();
    c.send({ op: 'ping', ct });
    const pong = await c.next('pong');
    expect(pong.ct).toBe(ct);
    expect(Math.abs(pong.st - Date.now())).toBeLessThan(1000);
    c.close();
  });

  it('rejects invalid messages and rate-limits floods', async () => {
    const c = new TestClient();
    await c.opened();
    c.send({ op: 'sub', symbol: 'not a symbol', tf: '1s' });
    expect((await c.next('error')).code).toBe('invalid_message');
    c.send({ op: 'sub', symbol: 'mock:TEST1', tf: '7m' });
    expect((await c.next('error')).code).toBe('invalid_message');

    for (let i = 0; i < 100; i++) c.send({ op: 'ping', ct: i });
    await c.next('error', (m) => m.code === 'rate_limited');
    c.close();
  });

  it('rejects connections from disallowed origins', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/ws`, { headers: { origin: 'https://evil.example' } });
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }];
    expect(res.statusCode).toBe(403);
  });

  it('changes the provider epoch when ingest restarts, so clients know to backfill', async () => {
    const c = new TestClient();
    await c.opened();
    c.send({ op: 'sub', symbol: 'mock:TEST1', tf: '1s' });
    const first = await c.next('c', () => true, 10_000);

    const ingest = procs[0]!;
    ingest.kill('SIGTERM');
    await once(ingest, 'exit');
    procs[0] = startService('ingest', { INGEST_OPS_PORT: String(INGEST_PORT), INGEST_LINGER_MS: '0' });

    const after = await c.next('c', (m) => m.ep !== first.ep, 20_000);
    expect(after.ep).toBeGreaterThan(first.ep);
    c.close();
  });
});
