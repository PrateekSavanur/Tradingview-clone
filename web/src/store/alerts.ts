import type { Alert, AlertEvent, AlertSpec, AlertStreamMessage } from '@chartdeck/shared';
import { create } from 'zustand';
import { authFetch, useAuth } from '../lib/auth.ts';
import { toast } from './toasts.ts';
import { useUi } from './ui.ts';
import { useWorkspace } from './workspace.ts';

export class AlertApiError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string; issues?: Array<{ path: string[]; message: string }> };
  if (!res.ok) {
    const issue = body.issues?.[0];
    throw new AlertApiError(issue ? `${issue.path.join('.')}: ${issue.message}` : (body.message ?? body.error ?? `Request failed (${res.status})`));
  }
  return body;
}

export type AlertDialogState = { mode: 'create'; draft: Partial<AlertSpec> } | { mode: 'edit'; alert: Alert } | null;

interface AlertsState {
  alerts: Alert[];
  /** Newest first. */
  events: AlertEvent[];
  unread: number;
  loaded: boolean;
  dialog: AlertDialogState;
  openCreate(draft?: Partial<AlertSpec>): void;
  openEdit(alert: Alert): void;
  closeDialog(): void;
  refresh(): Promise<void>;
  save(spec: AlertSpec, id?: string): Promise<void>;
  setStatus(id: string, status: 'active' | 'paused'): Promise<void>;
  remove(id: string): Promise<void>;
  markRead(): Promise<void>;
  clearLog(): Promise<void>;
}

export const useAlerts = create<AlertsState>()((set, get) => ({
  alerts: [],
  events: [],
  unread: 0,
  loaded: false,
  dialog: null,
  openCreate: (draft = {}) => set({ dialog: { mode: 'create', draft } }),
  openEdit: (alert) => set({ dialog: { mode: 'edit', alert } }),
  closeDialog: () => set({ dialog: null }),

  refresh: async () => {
    if (!useAuth.getState().user) return;
    const [{ alerts }, { events, unread }] = await Promise.all([
      call<{ alerts: Alert[] }>('/api/alerts'),
      call<{ events: AlertEvent[]; unread: number }>('/api/alerts/events?limit=100'),
    ]);
    set({ alerts, events, unread, loaded: true });
  },

  save: async (spec, id) => {
    const body = JSON.stringify({ spec });
    const alert = id
      ? await call<Alert>(`/api/alerts/${id}`, { method: 'PUT', body })
      : await call<Alert>('/api/alerts', { method: 'POST', body });
    set((s) => ({ alerts: id ? s.alerts.map((a) => (a.id === id ? alert : a)) : [alert, ...s.alerts] }));
  },

  setStatus: async (id, status) => {
    const alert = await call<Alert>(`/api/alerts/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? alert : a)) }));
  },

  remove: async (id) => {
    await call(`/api/alerts/${id}`, { method: 'DELETE' });
    set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
  },

  markRead: async () => {
    if (!get().unread) return;
    set((s) => ({ unread: 0, events: s.events.map((e) => ({ ...e, read: true })) }));
    await call('/api/alerts/events/read', { method: 'POST', body: '{}' });
  },

  clearLog: async () => {
    await call('/api/alerts/events', { method: 'DELETE' });
    set({ events: [], unread: 0 });
  },
}));

/** Show an alert's symbol and timeframe on the active chart. */
export function showAlertChart(spec: Pick<AlertSpec, 'symbol' | 'tf'>): void {
  const ws = useWorkspace.getState();
  ws.setSymbol(spec.symbol);
  ws.setTf(spec.tf);
}

function onFired(msg: Extract<AlertStreamMessage, { type: 'fired' }>): void {
  const { event } = msg;
  useAlerts.setState((s) => ({
    events: [event, ...s.events.filter((e) => e.id !== event.id)].slice(0, 500),
    unread: s.unread + 1,
    alerts: s.alerts.map((a) => (a.id === msg.alertId ? { ...a, status: msg.status, lastFiredAt: event.firedAt, fireCount: a.fireCount + 1 } : a)),
  }));
  const alert = useAlerts.getState().alerts.find((a) => a.id === msg.alertId);
  toast({
    tone: 'alert',
    title: event.message,
    body: `${new Date(event.firedAt).toLocaleTimeString()} · ${event.symbol.split(':')[1]} ${event.tf}`,
    action: alert ? { label: 'Show chart', run: () => showAlertChart(alert) } : { label: 'Open log', run: () => useUi.getState().setSidePanel('alerts') },
  });
  // System notification only when the tab isn't being looked at, and only if the user allowed it.
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(event.message, { body: `${event.symbol.split(':')[1]} · ${event.tf}`, tag: `alert-${event.id}` });
    } catch {
      // some browsers only allow notifications from a service worker
    }
  }
}

/**
 * Live alert notifications while signed in. EventSource can't send the bearer token, so the
 * stream is read with fetch. Reconnects with backoff, then reloads to pick up anything missed.
 */
class AlertStream {
  private ctrl: AbortController | null = null;
  private attempt = 0;
  private timer: number | undefined;

  start(): void {
    this.stop();
    const ctrl = (this.ctrl = new AbortController());
    void this.run(ctrl);
  }

  stop(): void {
    window.clearTimeout(this.timer);
    this.ctrl?.abort();
    this.ctrl = null;
  }

  private async run(ctrl: AbortController): Promise<void> {
    try {
      const res = await authFetch('/api/alerts/stream', { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`alert stream: ${res.status}`);
      if (this.attempt > 0) void useAlerts.getState().refresh().catch(() => {});
      this.attempt = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          buf = buf.slice(i + 2);
          if (data) this.dispatch(data);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.warn('[alerts] stream error', err);
    }
    if (ctrl.signal.aborted || this.ctrl !== ctrl) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.timer = window.setTimeout(() => this.ctrl === ctrl && void this.run(ctrl), delay);
  }

  private dispatch(data: string): void {
    let msg: AlertStreamMessage;
    try {
      msg = JSON.parse(data) as AlertStreamMessage;
    } catch {
      return;
    }
    if (msg.type === 'fired') onFired(msg);
    else void useAlerts.getState().refresh().catch(() => {});
  }
}

const stream = new AlertStream();

/** Alerts follow the session: load and stream while signed in, clear on sign-out. */
export function wireAlerts(): void {
  const apply = (signedIn: boolean) => {
    if (signedIn) {
      stream.start();
      useAlerts.getState().refresh().catch((err) => console.warn('[alerts] load failed', err));
    } else {
      stream.stop();
      useAlerts.setState({ alerts: [], events: [], unread: 0, loaded: false, dialog: null });
    }
  };
  useAuth.subscribe((s, prev) => {
    if (s.ready && (s.user?.id !== prev.user?.id || !prev.ready)) apply(!!s.user);
  });
}
