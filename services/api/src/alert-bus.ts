import { ALERT_REDIS_KEYS, type AlertStreamMessage } from '@chartdeck/shared';
import type { Redis } from 'ioredis';

type Listener = (msg: AlertStreamMessage) => void;

/**
 * Alert notifications over Redis. Every api replica subscribes to one channel and hands each
 * message to that user's open streams on this replica; the alerts service hears about edits.
 */
export class AlertBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly pub: Redis, private readonly sub: Redis) {}

  async start(): Promise<void> {
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel !== ALERT_REDIS_KEYS.userEvents) return;
      try {
        const { userId, msg } = JSON.parse(raw) as { userId: string; msg: AlertStreamMessage };
        this.listeners.get(userId)?.forEach((fn) => fn(msg));
      } catch {
        // malformed; ignore
      }
    });
    await this.sub.subscribe(ALERT_REDIS_KEYS.userEvents);
  }

  /** An alert was created, edited, paused/resumed or deleted by `userId`. */
  async changed(userId: string, alertId: string): Promise<void> {
    await this.pub
      .pipeline()
      .publish(ALERT_REDIS_KEYS.changed, alertId)
      .publish(ALERT_REDIS_KEYS.userEvents, JSON.stringify({ userId, msg: { type: 'changed' } }))
      .exec();
  }

  listen(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  get streams(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
