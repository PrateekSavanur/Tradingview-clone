import http from 'node:http';
import { pino, type Logger } from 'pino';
import client from 'prom-client';

export { client as prom };
export type { Logger };

export function createLogger(service: string): Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return n;
}

export function initMetrics(service: string): client.Registry {
  client.register.setDefaultLabels({ service });
  client.collectDefaultMetrics();
  return client.register;
}

export type ReadyCheck = () => boolean | Promise<boolean>;

/** Handles /healthz, /readyz and /metrics. Returns true if it answered the request. */
export async function handleOpsRequest(req: http.IncomingMessage, res: http.ServerResponse, ready: ReadyCheck): Promise<boolean> {
  const path = req.url?.split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return true;
  }
  if (path === '/readyz') {
    const ok = await Promise.resolve(ready()).catch(() => false);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ready' : 'not ready');
    return true;
  }
  if (path === '/metrics') {
    res.writeHead(200, { 'content-type': client.register.contentType }).end(await client.register.metrics());
    return true;
  }
  return false;
}

/** Standalone ops server for services that have no other HTTP surface. */
export function startOpsServer(port: number, ready: ReadyCheck, log: Logger): http.Server {
  const server = http.createServer(async (req, res) => {
    if (!(await handleOpsRequest(req, res, ready))) res.writeHead(404).end();
  });
  server.listen(port, () => log.info({ port }, 'ops server listening'));
  return server;
}

/** Run `fn` on SIGTERM/SIGINT once, then exit. */
export function onShutdown(log: Logger, fn: () => Promise<void> | void): void {
  let done = false;
  const handler = async (signal: string) => {
    if (done) return;
    done = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await fn();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
export * from './mailer.ts';
