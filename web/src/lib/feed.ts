import { fromTuple, type Candle, type LatencyStamps, type ProviderState, type ServerMessage, type Timeframe } from '@chartdeck/shared';

export type ConnState = 'connecting' | 'open' | 'reconnecting';

export interface CandleEvent {
  candle: Candle;
  lat: LatencyStamps;
  /** Provider epoch; a change means the upstream feed restarted and history may have gaps. */
  epoch: number;
  receivedAt: number;
}

type CandleListener = (e: CandleEvent) => void;
type Listener = () => void;

const PING_EVERY_MS = 5_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * The browser's single WebSocket to the gateway. Multiplexes every chart's subscriptions,
 * re-subscribes after reconnecting, and keeps an estimate of the gateway clock offset
 * (min-RTT ping sample) so latency can be measured across machines.
 */
export class Feed {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<CandleListener>>();
  private readonly stateListeners = new Set<Listener>();
  private readonly reconnectListeners = new Set<Listener>();
  private attempt = 0;
  private pingTimer: number | undefined;
  private pongTimer: number | undefined;
  private everOpened = false;
  private syncSamples: Array<{ rtt: number; offset: number }> = [];

  state: ConnState = 'connecting';
  /** Gateway clock minus client clock (ms). */
  offset = 0;
  rtt = 0;
  readonly providers = new Map<string, { state: ProviderState; epoch: number }>();
  lastError: string | null = null;
  messages = 0;

  constructor(private readonly url: string) {
    this.connect();
  }

  subscribe(symbol: string, tf: Timeframe, fn: CandleListener): () => void {
    const key = `${symbol}|${tf}`;
    let set = this.listeners.get(key);
    if (!set) {
      this.listeners.set(key, (set = new Set()));
      this.send({ op: 'sub', symbol, tf });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.listeners.get(key) === set) {
        this.listeners.delete(key);
        this.send({ op: 'unsub', symbol, tf });
      }
    };
  }

  /** Fires on connection-state or provider-status changes. */
  onChange(fn: Listener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Fires after a reconnect, once subscriptions have been restored; charts should backfill. */
  onReconnect(fn: Listener): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  private connect(): void {
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.syncSamples = [];
      for (const key of this.listeners.keys()) {
        const [symbol, tf] = key.split('|') as [string, Timeframe];
        this.send({ op: 'sub', symbol, tf });
      }
      // A quick burst of pings gives a good clock-offset estimate right away.
      for (let i = 0; i < 4; i++) window.setTimeout(() => this.ping(), i * 150);
      this.pingTimer = window.setInterval(() => this.ping(), PING_EVERY_MS);
      this.setState('open');
      if (this.everOpened) this.reconnectListeners.forEach((fn) => fn());
      this.everOpened = true;
    };

    ws.onmessage = (ev) => this.onMessage(ev.data as string);

    ws.onclose = (ev) => {
      window.clearInterval(this.pingTimer);
      window.clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      if (this.ws !== ws) return;
      this.lastError = ev.reason || (ev.code === 1006 ? 'connection lost' : `closed (${ev.code})`);
      const base = Math.min(10_000, 500 * 2 ** this.attempt++);
      const delay = base / 2 + Math.random() * (base / 2);
      this.setState('reconnecting');
      window.setTimeout(() => this.connect(), delay);
    };
  }

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ op: 'ping', ct: Date.now() });
    // One outstanding watchdog at a time; any pong clears it.
    this.pongTimer ??= window.setTimeout(() => this.ws?.close(4000, 'heartbeat timeout'), PONG_TIMEOUT_MS);
  }

  private onMessage(data: string): void {
    const receivedAt = Date.now();
    this.messages++;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'c': {
        const set = this.listeners.get(`${msg.s}|${msg.tf}`);
        if (!set) return;
        const e: CandleEvent = { candle: fromTuple(msg.c), lat: msg.lat, epoch: msg.ep, receivedAt };
        set.forEach((fn) => fn(e));
        return;
      }
      case 'pong': {
        window.clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        const rtt = receivedAt - msg.ct;
        this.syncSamples.push({ rtt, offset: msg.st - (msg.ct + rtt / 2) });
        if (this.syncSamples.length > 20) this.syncSamples.shift();
        const best = this.syncSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this.rtt = rtt;
        return;
      }
      case 'status':
        this.providers.set(msg.provider, { state: msg.state, epoch: msg.epoch });
        this.stateListeners.forEach((fn) => fn());
        return;
      case 'error':
        this.lastError = msg.message;
        console.warn('[feed]', msg.code, msg.message);
        return;
    }
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.stateListeners.forEach((fn) => fn());
  }
}

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
export const feed = new Feed(wsUrl);
