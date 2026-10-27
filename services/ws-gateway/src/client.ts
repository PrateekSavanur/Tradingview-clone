import type { ServerMessage, Timeframe } from '@chartdeck/shared';
import WebSocket from 'ws';

export interface ClientLimits {
  /** Above this many buffered bytes, candle frames are conflated (only the newest per stream is kept). */
  softBufferBytes: number;
  /** Above this, or if conflation lasts longer than `maxStallMs`, the client is disconnected. */
  hardBufferBytes: number;
  maxStallMs: number;
  maxSubscriptions: number;
  /** Token bucket for inbound messages. */
  msgRatePerSec: number;
  msgBurst: number;
}

let nextId = 1;

export class Client {
  readonly id = nextId++;
  /** symbol id -> subscribed timeframes */
  readonly subs = new Map<string, Set<Timeframe>>();
  subCount = 0;
  alive = true;
  /** Latest unsent frame per `symbol|tf` while the socket is backed up. */
  readonly pending = new Map<string, string>();
  stalledSince: number | null = null;
  private tokens: number;
  private tokensAt = Date.now();

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
    readonly limits: ClientLimits,
  ) {
    this.tokens = limits.msgBurst;
  }

  takeToken(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.limits.msgBurst, this.tokens + ((now - this.tokensAt) / 1000) * this.limits.msgRatePerSec);
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get backedUp(): boolean {
    return this.ws.bufferedAmount > this.limits.softBufferBytes;
  }

  /** Control messages are never dropped. */
  sendControl(msg: ServerMessage): void {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  /** Returns false if the frame was conflated instead of written. */
  sendCandle(key: string, frame: string): boolean {
    if (!this.open) return false;
    if (this.backedUp || this.pending.size) {
      this.pending.set(key, frame);
      this.stalledSince ??= Date.now();
      return false;
    }
    this.ws.send(frame);
    return true;
  }

  /** Flush conflated frames once the socket has drained. Returns frames written. */
  drain(): number {
    if (!this.pending.size || this.backedUp) return 0;
    let n = 0;
    for (const frame of this.pending.values()) {
      this.ws.send(frame);
      n++;
    }
    this.pending.clear();
    this.stalledSince = null;
    return n;
  }
}
