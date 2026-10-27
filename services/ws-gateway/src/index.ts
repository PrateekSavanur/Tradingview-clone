import http from 'node:http';
import { createLogger, env, envInt, handleOpsRequest, initMetrics, onShutdown } from '@chartdeck/service-kit';
import { Redis } from 'ioredis';
import { WebSocketServer } from 'ws';
import { Client, type ClientLimits } from './client.ts';
import { Hub } from './hub.ts';
import { metrics } from './metrics.ts';

const log = createLogger('ws-gateway');
initMetrics('ws-gateway');

const redisUrl = env('REDIS_URL', 'redis://localhost:6379');
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.error({ err }, 'redis error'));
sub.on('error', (err) => log.error({ err }, 'redis subscriber error'));

const port = envInt('GATEWAY_PORT', 8080);
const allowedOrigins = env('ALLOWED_ORIGINS', 'http://localhost:5173,http://localhost:3000').split(',').map((s) => s.trim());
const trustProxy = process.env.TRUST_PROXY === 'true';
const maxClients = envInt('GATEWAY_MAX_CLIENTS', 10_000);
const maxPerIp = envInt('GATEWAY_MAX_CLIENTS_PER_IP', 20);
const limits: ClientLimits = {
  softBufferBytes: envInt('GATEWAY_SOFT_BUFFER_BYTES', 256 * 1024),
  hardBufferBytes: envInt('GATEWAY_HARD_BUFFER_BYTES', 4 * 1024 * 1024),
  maxStallMs: envInt('GATEWAY_MAX_STALL_MS', 10_000),
  maxSubscriptions: envInt('GATEWAY_MAX_SUBSCRIPTIONS', 50),
  msgRatePerSec: 20,
  msgBurst: 40,
};

const hub = new Hub(redis, sub, log);
await hub.start();

const server = http.createServer(async (req, res) => {
  if (!(await handleOpsRequest(req, res, () => redis.status === 'ready' && sub.status === 'ready'))) {
    res.writeHead(404).end();
  }
});

// Compression is off: frames are small and per-message deflate adds latency and CPU per client.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const perIp = new Map<string, number>();

function clientIp(req: http.IncomingMessage): string {
  const fwd = trustProxy ? req.headers['x-forwarded-for'] : undefined;
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  const reject = (code: number, reason: string) => {
    metrics.rejected.labels(reason).inc();
    socket.end(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
  };
  if (req.url?.split('?')[0] !== '/ws') return reject(404, 'not_found');
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) return reject(403, 'bad_origin');
  const ip = clientIp(req);
  if (hub.clientCount >= maxClients) return reject(503, 'server_full');
  if ((perIp.get(ip) ?? 0) >= maxPerIp) return reject(429, 'too_many_connections');

  wss.handleUpgrade(req, socket, head, (ws) => {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const client = new Client(ws, ip, limits);
    hub.add(client);
    ws.on('message', (data) => hub.handleMessage(client, data));
    ws.on('pong', () => (client.alive = true));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      hub.remove(client);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
  });
});

server.listen(port, () => log.info({ port, gatewayId: hub.gatewayId }, 'ws-gateway listening'));

onShutdown(log, async () => {
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  await hub.stop();
  server.close();
  await Promise.allSettled([redis.quit(), sub.quit()]);
});
