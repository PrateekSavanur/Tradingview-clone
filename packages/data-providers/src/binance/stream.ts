import WebSocket from 'ws';
import type { ProviderTrade, StreamHandlers, TradeStream } from '../types.ts';

interface AggTrade {
  e: 'aggTrade';
  E: number;
  s: string;
  p: string;
  q: string;
  T: number;
}

const MAX_STREAMS = 1024;
/** Binance allows 5 incoming messages/sec per connection; stay under it. */
const CONTROL_INTERVAL_MS = 250;
const PARAMS_PER_MESSAGE = 200;
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
/** Binance drops connections at 24h; rotate a bit earlier on our own terms. */
const MAX_CONNECTION_AGE_MS = 23 * 60 * 60 * 1000;

/**
 * One combined-stream connection carrying `<symbol>@aggTrade` for every subscribed ticker.
 * Subscriptions change at runtime via SUBSCRIBE/UNSUBSCRIBE, throttled to the exchange limit.
 */
export class BinanceTradeStream implements TradeStream {
  private ws: WebSocket | null = null;
  private desired = new Set<string>();
  private active = new Set<string>();
  private controlQueue: Array<{ method: 'SUBSCRIBE' | 'UNSUBSCRIBE'; params: string[] }> = [];
  private controlTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongDeadline: NodeJS.Timeout | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private hasConnected = false;
  private closed = false;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly handlers: StreamHandlers,
  ) {
    this.connect();
  }

  setTickers(tickers: Iterable<string>): void {
    const next = new Set<string>();
    for (const t of tickers) {
      if (next.size >= MAX_STREAMS) break;
      next.add(t.toLowerCase());
    }
    this.desired = next;
    this.sync();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }

  private connect(): void {
    this.handlers.onState(this.hasConnected ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${this.url}/stream`, { handshakeTimeout: 10_000 });
    this.ws = ws;
    this.active.clear();
    this.controlQueue = [];

    ws.on('open', () => {
      const wasReconnect = this.hasConnected;
      this.hasConnected = true;
      this.attempt = 0;
      this.sync();
      this.startHeartbeat();
      this.rotateTimer = setTimeout(() => ws.terminate(), MAX_CONNECTION_AGE_MS);
      this.handlers.onState('live');
      if (wasReconnect) this.handlers.onReconnected();
    });

    ws.on('message', (raw) => {
      const receivedAt = Date.now();
      let msg: { stream?: string; data?: AggTrade };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const d = msg.data;
      if (!d || d.e !== 'aggTrade') return;
      const trade: ProviderTrade = {
        ticker: d.s,
        price: Number(d.p),
        qty: Number(d.q),
        time: d.T,
        eventTime: d.E,
        receivedAt,
      };
      this.handlers.onTrade(trade);
    });

    ws.on('pong', () => {
      if (this.pongDeadline) clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
    });

    ws.on('error', () => {
      // 'close' follows; reconnect is handled there.
    });

    ws.on('close', () => {
      this.clearTimers();
      if (this.closed) return;
      this.handlers.onState('reconnecting');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 250 * 2 ** this.attempt++);
    const delay = base / 2 + Math.random() * (base / 2);
    if (this.attempt > 6) this.handlers.onState('down');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongDeadline ??= setTimeout(() => this.ws?.terminate(), PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.pongDeadline, this.rotateTimer, this.controlTimer]) if (t) clearTimeout(t);
    this.pingTimer = this.pongDeadline = this.rotateTimer = this.controlTimer = null;
  }

  /** Diff desired vs active and queue control messages. */
  private sync(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const add: string[] = [];
    const remove: string[] = [];
    for (const t of this.desired) if (!this.active.has(t)) add.push(`${t}@aggTrade`);
    for (const t of this.active) if (!this.desired.has(t)) remove.push(`${t}@aggTrade`);
    for (let i = 0; i < remove.length; i += PARAMS_PER_MESSAGE) {
      this.controlQueue.push({ method: 'UNSUBSCRIBE', params: remove.slice(i, i + PARAMS_PER_MESSAGE) });
    }
    for (let i = 0; i < add.length; i += PARAMS_PER_MESSAGE) {
      this.controlQueue.push({ method: 'SUBSCRIBE', params: add.slice(i, i + PARAMS_PER_MESSAGE) });
    }
    this.active = new Set(this.desired);
    this.drainControl();
  }

  private drainControl(): void {
    if (this.controlTimer || this.controlQueue.length === 0) return;
    const send = () => {
      const msg = this.controlQueue.shift();
      if (msg && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ...msg, id: this.nextId++ }));
      }
      this.controlTimer = this.controlQueue.length ? setTimeout(send, CONTROL_INTERVAL_MS) : null;
    };
    send();
  }
}
