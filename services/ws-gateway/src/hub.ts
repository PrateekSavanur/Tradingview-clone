import { randomUUID } from 'node:crypto';
import type { Logger } from '@chartdeck/service-kit';
import {
  ClientMessage, REDIS_KEYS,
  type CandleBatch, type ProviderStatusMessage, type ServerMessage, type Timeframe,
} from '@chartdeck/shared';
import type { Redis } from 'ioredis';
import type { RawData } from 'ws';
import type { Client } from './client.ts';
import { metrics } from './metrics.ts';

const DEMAND_TTL_SEC = 30;
const DEMAND_REFRESH_MS = 10_000;
const DRAIN_INTERVAL_MS = 50;
const HEARTBEAT_MS = 15_000;
/** If ingest goes quiet for this long, tell clients the feed is down. */
const STATUS_STALE_MS = 25_000;

/**
 * Connects clients to Redis candle channels. Each symbol is subscribed in Redis once per
 * gateway no matter how many clients watch it, and each (symbol, tf) frame is serialised once
 * per batch and written to every interested socket.
 */
export class Hub {
  readonly gatewayId = randomUUID();
  private readonly clients = new Set<Client>();
  private readonly watchers = new Map<string, Set<Client>>();
  private readonly status = new Map<string, ProviderStatusMessage>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly sub: Redis,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.sub.on('message', (channel: string, message: string) => {
      if (channel === REDIS_KEYS.statusChannel) this.onStatus(message);
      else this.onBatch(message);
    });
    await this.sub.subscribe(REDIS_KEYS.statusChannel);
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', REDIS_KEYS.status('*'), 'COUNT', 100);
      cursor = next;
      for (const v of keys.length ? await this.redis.mget(...keys) : []) if (v) this.onStatus(v);
    } while (cursor !== '0');
    this.timers.push(
      setInterval(() => void this.refreshDemand(), DEMAND_REFRESH_MS),
      setInterval(() => this.drainAll(), DRAIN_INTERVAL_MS),
      setInterval(() => this.checkStale(), 5_000),
      setInterval(() => this.heartbeat(), HEARTBEAT_MS),
    );
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.redis.del(REDIS_KEYS.demand(this.gatewayId)).catch(() => {});
    await this.redis.publish(REDIS_KEYS.demandChanged, this.gatewayId).catch(() => {});
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(client: Client): void {
    this.clients.add(client);
    metrics.clients.set(this.clients.size);
    client.sendControl({ t: 'hello', v: 1, serverTime: Date.now() });
    for (const s of this.status.values()) {
      client.sendControl({ t: 'status', provider: s.provider, state: s.state, epoch: s.epoch });
    }
  }

  remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const [symbol, tfs] of client.subs) {
      for (const tf of [...tfs]) this.unsubscribe(client, symbol, tf);
    }
    metrics.clients.set(this.clients.size);
  }

  handleMessage(client: Client, raw: RawData): void {
    if (!client.takeToken()) {
      metrics.rejected.labels('rate_limited').inc();
      client.sendControl({ t: 'error', code: 'rate_limited', message: 'Too many messages' });
      return;
    }
    let parsed: ClientMessage;
    try {
      parsed = ClientMessage.parse(JSON.parse(raw.toString()));
    } catch {
      metrics.rejected.labels('invalid').inc();
      client.sendControl({ t: 'error', code: 'invalid_message', message: 'Malformed or invalid message' });
      return;
    }
    switch (parsed.op) {
      case 'ping':
        client.sendControl({ t: 'pong', ct: parsed.ct, st: Date.now() });
        break;
      case 'sub':
        void this.subscribe(client, parsed.symbol, parsed.tf);
        break;
      case 'unsub':
        this.unsubscribe(client, parsed.symbol, parsed.tf);
        break;
    }
  }

  private async subscribe(client: Client, symbol: string, tf: Timeframe): Promise<void> {
    let tfs = client.subs.get(symbol);
    if (tfs?.has(tf)) return;
    if (client.subCount >= client.limits.maxSubscriptions) {
      metrics.rejected.labels('too_many_subs').inc();
      client.sendControl({ t: 'error', code: 'too_many_subscriptions', message: `Limit is ${client.limits.maxSubscriptions}` });
      return;
    }
    if (!tfs) client.subs.set(symbol, (tfs = new Set()));
    tfs.add(tf);
    client.subCount++;
    metrics.subscriptions.inc();

    let set = this.watchers.get(symbol);
    if (!set) {
      this.watchers.set(symbol, (set = new Set()));
      metrics.symbols.set(this.watchers.size);
      await this.sub.subscribe(REDIS_KEYS.candleChannel(symbol));
      await this.redis
        .pipeline()
        .sadd(REDIS_KEYS.demand(this.gatewayId), symbol)
        .expire(REDIS_KEYS.demand(this.gatewayId), DEMAND_TTL_SEC)
        .publish(REDIS_KEYS.demandChanged, this.gatewayId)
        .exec();
    }
    set.add(client);
    client.sendControl({ t: 'subscribed', s: symbol, tf });

    // Prime the client with the hot candle so it doesn't wait for the next trade.
    const hot = await this.redis.get(REDIS_KEYS.hot(symbol));
    if (hot && client.subs.get(symbol)?.has(tf)) {
      const batch = JSON.parse(hot) as CandleBatch;
      const c = batch.c[tf];
      if (c) client.sendCandle(`${symbol}|${tf}`, this.frame(batch, tf, Date.now()));
    }
  }

  private unsubscribe(client: Client, symbol: string, tf: Timeframe): void {
    const tfs = client.subs.get(symbol);
    if (!tfs?.delete(tf)) return;
    client.subCount--;
    client.pending.delete(`${symbol}|${tf}`);
    metrics.subscriptions.dec();
    if (tfs.size) return;
    client.subs.delete(symbol);
    const set = this.watchers.get(symbol);
    set?.delete(client);
    if (set && set.size === 0) {
      this.watchers.delete(symbol);
      metrics.symbols.set(this.watchers.size);
      void this.sub.unsubscribe(REDIS_KEYS.candleChannel(symbol));
      void this.redis
        .pipeline()
        .srem(REDIS_KEYS.demand(this.gatewayId), symbol)
        .publish(REDIS_KEYS.demandChanged, this.gatewayId)
        .exec();
    }
  }

  private frame(batch: CandleBatch, tf: Timeframe, sg: number): string {
    const msg: ServerMessage = {
      t: 'c', s: batch.s, tf, ep: batch.ep, c: batch.c[tf]!,
      lat: { et: batch.et, ri: batch.ri, pi: batch.pi, xo: batch.xo, sg },
    };
    return JSON.stringify(msg);
  }

  private onBatch(message: string): void {
    let batch: CandleBatch;
    try {
      batch = JSON.parse(message) as CandleBatch;
    } catch {
      return;
    }
    const watchers = this.watchers.get(batch.s);
    if (!watchers) return;
    const sg = Date.now();
    metrics.fanout.observe(Math.max(0, sg - batch.pi));
    const frames = new Map<Timeframe, string>();
    let sent = 0;
    let conflated = 0;
    for (const client of watchers) {
      for (const tf of client.subs.get(batch.s) ?? []) {
        if (!batch.c[tf]) continue;
        let f = frames.get(tf);
        if (!f) frames.set(tf, (f = this.frame(batch, tf, sg)));
        if (client.sendCandle(`${batch.s}|${tf}`, f)) sent++;
        else conflated++;
      }
    }
    metrics.framesSent.inc(sent);
    if (conflated) metrics.framesConflated.inc(conflated);
  }

  private onStatus(message: string): void {
    let s: ProviderStatusMessage;
    try {
      s = JSON.parse(message) as ProviderStatusMessage;
    } catch {
      return;
    }
    const prev = this.status.get(s.provider);
    this.status.set(s.provider, s);
    if (prev && prev.state === s.state && prev.epoch === s.epoch) return;
    this.broadcast({ t: 'status', provider: s.provider, state: s.state, epoch: s.epoch });
  }

  private checkStale(): void {
    const now = Date.now();
    for (const s of this.status.values()) {
      if (s.state !== 'down' && now - s.at > STATUS_STALE_MS) {
        this.log.warn({ provider: s.provider }, 'no status from ingest; marking provider down');
        this.status.set(s.provider, { ...s, state: 'down' });
        this.broadcast({ t: 'status', provider: s.provider, state: 'down', epoch: s.epoch });
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients) c.sendControl(msg);
  }

  /** Terminate sockets that did not answer the previous ping (half-open TCP, sleeping laptops). */
  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private drainAll(): void {
    const now = Date.now();
    for (const c of this.clients) {
      if (!c.pending.size) continue;
      const tooFull = c.ws.bufferedAmount > c.limits.hardBufferBytes;
      const tooLong = c.stalledSince !== null && now - c.stalledSince > c.limits.maxStallMs;
      if (tooFull || tooLong) {
        metrics.slowDisconnects.inc();
        this.log.warn({ client: c.id, ip: c.ip, buffered: c.ws.bufferedAmount }, 'disconnecting slow consumer');
        c.ws.close(1013, 'slow consumer');
        continue;
      }
      metrics.framesSent.inc(c.drain());
    }
  }

  private async refreshDemand(): Promise<void> {
    const key = REDIS_KEYS.demand(this.gatewayId);
    const symbols = [...this.watchers.keys()];
    try {
      const p = this.redis.pipeline().del(key);
      if (symbols.length) p.sadd(key, ...symbols).expire(key, DEMAND_TTL_SEC);
      await p.exec();
    } catch (err) {
      this.log.error({ err }, 'demand refresh failed');
    }
  }
}
