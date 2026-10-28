import { AlertEvaluator, describeAlert, type Fire } from '@chartdeck/alert-engine';
import type { Logger, Mailer } from '@chartdeck/service-kit';
import {
  ALERT_REDIS_KEYS, REDIS_KEYS, fromTuple, type AlertSpec, type AlertStreamMessage, type Candle, type CandleBatch, type Timeframe,
} from '@chartdeck/shared';
import type { Redis } from 'ioredis';
import { metrics } from './metrics.ts';
import { Semaphore } from './semaphore.ts';
import type { ActiveAlert, AlertDb } from './store.ts';

export type HistoryFetcher = (symbol: string, tf: Timeframe, limit: number) => Promise<Candle[]>;

export interface AlertServiceDeps {
  redis: Redis;
  sub: Redis;
  db: AlertDb;
  history: HistoryFetcher;
  mailer: Mailer;
  log: Logger;
  /** Origin used for links in alert emails. */
  publicUrl: string;
  now?: () => number;
}

/** Bars fetched to warm up indicators; enough for long EMAs and Ichimoku-style lookbacks. */
const WARM_BARS = 1000;
const DEMAND_TTL_SEC = 30;
const DEMAND_REFRESH_MS = 10_000;
const EXPIRY_SWEEP_MS = 15_000;
/** Full reload from the database, in case a change notice was missed. */
const RESYNC_MS = 5 * 60_000;
/** Alert emails per user per hour; the in-app notification is never limited. */
const EMAILS_PER_HOUR = 30;
/** Live updates kept while history loads; older ones only matter for their bar's last state. */
const MAX_BUFFER = 5000;

interface Live {
  alert: ActiveAlert;
  ev: AlertEvaluator;
  /** Updates that arrived while history was loading, replayed afterwards. */
  buffer: Candle[] | null;
  /** Bumped on every (re)warm so a stale warm-up can't overwrite a newer one. */
  gen: number;
}

/**
 * Evaluates every active alert against the live candle stream. It registers the symbols it needs
 * in Redis like a gateway does, so ingest streams them even when no browser is watching, and
 * listens on the same candle channels. Runs as a single replica.
 */
export class AlertService {
  private readonly live = new Map<string, Live>();
  private readonly bySymbol = new Map<string, Set<Live>>();
  private readonly epochs = new Map<string, number>();
  private readonly fetches = new Semaphore(4);
  private readonly emailLog = new Map<string, number[]>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private announced = '';

  constructor(private readonly deps: AlertServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  get activeCount(): number {
    return this.live.size;
  }

  async start(): Promise<void> {
    this.deps.sub.on('message', (channel: string, msg: string) => {
      if (channel === ALERT_REDIS_KEYS.changed) void this.reload(msg);
      else this.onBatch(msg);
    });
    await this.deps.sub.subscribe(ALERT_REDIS_KEYS.changed);
    await this.resync();
    this.timers.push(
      setInterval(() => void this.refreshDemand(), DEMAND_REFRESH_MS),
      setInterval(() => void this.sweepExpired(), EXPIRY_SWEEP_MS),
      setInterval(() => void this.resync(), RESYNC_MS),
    );
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.deps.redis.pipeline().del(ALERT_REDIS_KEYS.demand).publish(REDIS_KEYS.demandChanged, 'alerts').exec().catch(() => {});
  }

  /** Bring the evaluated set in line with the database. */
  async resync(): Promise<void> {
    try {
      const rows = await this.deps.db.active();
      const ids = new Set(rows.map((r) => r.id));
      for (const id of [...this.live.keys()]) if (!ids.has(id)) this.remove(id);
      for (const r of rows) {
        const cur = this.live.get(r.id);
        if (!cur || JSON.stringify(cur.alert.spec) !== JSON.stringify(r.spec)) this.add(r);
      }
      await this.refreshDemand();
    } catch (err) {
      this.deps.log.error({ err }, 'alert resync failed');
    }
  }

  /** An alert was created, edited, paused or deleted. */
  async reload(id: string): Promise<void> {
    try {
      const row = await this.deps.db.activeOne(id);
      this.remove(id);
      if (row) this.add(row);
      await this.refreshDemand();
    } catch (err) {
      this.deps.log.error({ err, id }, 'alert reload failed');
    }
  }

  private add(alert: ActiveAlert): void {
    this.remove(alert.id);
    const live: Live = { alert, ev: new AlertEvaluator(alert.spec), buffer: [], gen: 0 };
    this.live.set(alert.id, live);
    const symbol = alert.spec.symbol.id;
    let set = this.bySymbol.get(symbol);
    if (!set) {
      this.bySymbol.set(symbol, (set = new Set()));
      this.deps.sub.subscribe(REDIS_KEYS.candleChannel(symbol)).catch((err) => this.deps.log.error({ err, symbol }, 'subscribe failed'));
    }
    set.add(live);
    void this.warm(live);
    this.updateGauges();
  }

  private remove(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    const symbol = live.alert.spec.symbol.id;
    const set = this.bySymbol.get(symbol);
    set?.delete(live);
    if (set && !set.size) {
      this.bySymbol.delete(symbol);
      this.epochs.delete(symbol);
      this.deps.sub.unsubscribe(REDIS_KEYS.candleChannel(symbol)).catch(() => {});
    }
    this.updateGauges();
  }

  private updateGauges(): void {
    metrics.active.set(this.live.size);
    metrics.symbols.set(this.bySymbol.size);
  }

  /** Load history into the evaluator, then replay what streamed in meanwhile. Retries until it works. */
  private async warm(live: Live, attempt = 0): Promise<void> {
    const gen = ++live.gen;
    live.buffer ??= [];
    const { spec } = live.alert;
    try {
      const bars = await this.fetches.run(() => this.deps.history(spec.symbol.id, spec.tf, live.ev.needsHistory ? WARM_BARS : 2));
      if (this.live.get(live.alert.id) !== live || gen !== live.gen) return;
      live.ev.warm(bars);
      const buffered = live.buffer ?? [];
      live.buffer = null;
      for (const c of buffered) this.evaluate(live, c, null);
    } catch (err) {
      metrics.warmFailures.inc();
      this.deps.log.warn({ err: (err as Error).message, alert: live.alert.id, attempt }, 'alert warm-up failed; retrying');
      setTimeout(() => {
        if (this.live.get(live.alert.id) === live && gen === live.gen) void this.warm(live, attempt + 1);
      }, Math.min(60_000, 2000 * 2 ** attempt));
    }
  }

  private onBatch(raw: string): void {
    let b: CandleBatch;
    try {
      b = JSON.parse(raw) as CandleBatch;
    } catch {
      return;
    }
    const set = this.bySymbol.get(b.s);
    if (!set) return;
    const prevEpoch = this.epochs.get(b.s);
    this.epochs.set(b.s, b.ep);
    // Upstream reconnected: candles may have been missed, so indicators start over from history.
    const restarted = prevEpoch !== undefined && prevEpoch !== b.ep;
    for (const live of [...set]) {
      const tuple = b.c[live.alert.spec.tf];
      if (!tuple) continue;
      const c = fromTuple(tuple);
      if (restarted && live.ev.needsHistory) {
        live.buffer = [c];
        void this.warm(live);
        continue;
      }
      if (live.buffer) {
        live.buffer.push(c);
        if (live.buffer.length > MAX_BUFFER) live.buffer.splice(0, live.buffer.length - MAX_BUFFER);
      } else {
        this.evaluate(live, c, b.ri);
      }
    }
  }

  private evaluate(live: Live, c: Candle, receivedAt: number | null): void {
    const fire = live.ev.update(c);
    if (!fire) return;
    // A one-shot alert stops here, synchronously, so the next tick can't fire it again.
    if (live.alert.spec.frequency === 'once') {
      this.remove(live.alert.id);
      void this.refreshDemand();
    }
    void this.fire(live.alert, fire, receivedAt);
  }

  private async fire(alert: ActiveAlert, f: Fire, receivedAt: number | null): Promise<void> {
    const { spec } = alert;
    const fmt = formatter(spec);
    const message = spec.message || describeAlert(spec, fmt);
    const status = spec.frequency === 'once' ? 'triggered' : 'active';
    try {
      const event = await this.deps.db.recordFire({
        alertId: alert.id, userId: alert.userId, firedAt: this.now(), symbol: spec.symbol.id, tf: spec.tf,
        message, price: f.price, value: f.x, target: f.y, status,
      });
      if (!event) {
        // Paused or deleted while this tick was in flight.
        this.remove(alert.id);
        return;
      }
      metrics.fired.labels(spec.frequency).inc();
      const msg: AlertStreamMessage = { type: 'fired', event, alertId: alert.id, status };
      await this.deps.redis.publish(ALERT_REDIS_KEYS.userEvents, JSON.stringify({ userId: alert.userId, msg }));
      if (receivedAt) metrics.fireToPublish.observe(Math.max(0, this.now() - receivedAt));
      this.deps.log.info({ alert: alert.id, user: alert.userId, message }, 'alert fired');
      if (spec.notify.email) await this.email(alert, message, f, fmt);
    } catch (err) {
      this.deps.log.error({ err, alert: alert.id }, 'recording alert failed');
    }
  }

  private async email(alert: ActiveAlert, message: string, f: Fire, fmt: (v: number) => string): Promise<void> {
    const now = this.now();
    const sent = (this.emailLog.get(alert.userId) ?? []).filter((t) => now - t < 3_600_000);
    if (sent.length >= EMAILS_PER_HOUR) {
      metrics.emails.labels('rate_limited').inc();
      return;
    }
    const to = await this.deps.db.verifiedEmail(alert.userId);
    if (!to) {
      metrics.emails.labels('unverified').inc();
      return;
    }
    sent.push(now);
    this.emailLog.set(alert.userId, sent);
    const { spec } = alert;
    const link = `${this.deps.publicUrl.replace(/\/$/, '')}/`;
    try {
      await this.deps.mailer.send({
        to,
        subject: `Alert: ${message}`.slice(0, 150),
        text: `${message}\n\n${spec.symbol.ticker} (${spec.symbol.exchange}) on ${spec.tf}: last price ${fmt(f.price)}.\n`
          + `${new Date(now).toUTCString()}\n\nOpen ChartDeck: ${link}\n\n`
          + `You get this because the alert has email notifications on. Turn them off by editing the alert.`,
      });
      metrics.emails.labels('sent').inc();
    } catch (err) {
      metrics.emails.labels('failed').inc();
      this.deps.log.warn({ err, alert: alert.id }, 'alert email failed');
    }
  }

  private async sweepExpired(): Promise<void> {
    try {
      const expired = await this.deps.db.expireDue();
      if (!expired.length) return;
      const p = this.deps.redis.pipeline();
      for (const { id, userId } of expired) {
        this.remove(id);
        p.publish(ALERT_REDIS_KEYS.userEvents, JSON.stringify({ userId, msg: { type: 'changed' } }));
      }
      await p.exec();
      await this.refreshDemand();
    } catch (err) {
      this.deps.log.error({ err }, 'expiry sweep failed');
    }
  }

  /** Our symbols in the demand set ingest reads; it expires if this service dies. */
  private async refreshDemand(): Promise<void> {
    const key = ALERT_REDIS_KEYS.demand;
    const symbols = [...this.bySymbol.keys()].sort();
    const changed = symbols.join(',') !== this.announced;
    try {
      const p = this.deps.redis.pipeline().del(key);
      if (symbols.length) p.sadd(key, ...symbols).expire(key, DEMAND_TTL_SEC);
      // Ingest also rescans every few seconds; the notice just makes new symbols start sooner.
      if (changed) p.publish(REDIS_KEYS.demandChanged, 'alerts');
      await p.exec();
      this.announced = symbols.join(',');
    } catch (err) {
      this.deps.log.error({ err }, 'demand refresh failed');
    }
  }
}

/** Prices to the symbol's tick size; other values (indicator readings) to a few significant digits. */
function formatter(spec: AlertSpec): (v: number) => string {
  const decimals = Math.max(0, Math.min(10, Math.round(-Math.log10(spec.symbol.tickSize))));
  return (v) => (Math.abs(v) >= 1 || decimals > 2 ? v.toFixed(decimals) : v.toPrecision(4));
}
