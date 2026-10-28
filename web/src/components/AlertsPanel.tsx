import { describeAlert } from '@chartdeck/alert-engine';
import type { Alert, AlertStatus } from '@chartdeck/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.ts';
import { showAlertChart, useAlerts } from '../store/alerts.ts';
import { toast } from '../store/toasts.ts';
import { useUi } from '../store/ui.ts';

const STATUS: Record<AlertStatus, { label: string; dot: string }> = {
  active: { label: 'Active', dot: 'bg-[var(--color-up)]' },
  paused: { label: 'Paused', dot: 'bg-[var(--muted)]' },
  triggered: { label: 'Triggered', dot: 'bg-[var(--accent)]' },
  expired: { label: 'Expired', dot: 'bg-amber-500' },
};

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

/** The user's alerts and the log of fired ones. */
export function AlertsPanel() {
  const user = useAuth((s) => s.user);
  const { alerts, events, unread, loaded, openCreate } = useAlerts();
  const [tab, setTab] = useState<'alerts' | 'log'>('alerts');

  // Looking at the log marks it read.
  useEffect(() => {
    if (tab !== 'log' || !unread) return;
    const t = window.setTimeout(() => void useAlerts.getState().markRead().catch(() => {}), 1200);
    return () => window.clearTimeout(t);
  }, [tab, unread]);

  if (!user) {
    return (
      <div className="px-4 py-8 text-center text-xs text-[var(--muted)]" role="tabpanel">
        <p className="mb-3">Alerts run on the server and fire even when ChartDeck is closed.</p>
        <button onClick={() => useUi.getState().setAuthOpen(true)} className="h-8 rounded bg-[var(--accent)] px-3 font-medium text-white">Sign in to use alerts</button>
      </div>
    );
  }

  const active = alerts.filter((a) => a.status === 'active').length;
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="Alerts">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <Seg on={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts <span className="tabular text-[var(--muted)]">{active}/{alerts.length}</span></Seg>
        <Seg on={tab === 'log'} onClick={() => setTab('log')}>Log {unread > 0 && <span className="tabular text-[var(--accent)]">{unread} new</span>}</Seg>
        <div className="flex-1" />
        <button onClick={() => openCreate()} className="flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--hover)]" title="Create alert (Alt+A)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M12 5v14M5 12h14" /></svg>
          Create
        </button>
      </div>
      <NotificationPrompt />
      {tab === 'alerts' ? (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
          {loaded && !alerts.length && (
            <li className="px-4 py-8 text-center text-xs text-[var(--muted)]">
              No alerts yet. Create one from here, the top bar, or with Alt+A on a chart.
            </li>
          )}
        </ul>
      ) : (
        <>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="border-b border-[var(--border)]/60 px-3 py-2">
                <div className="flex items-start gap-2">
                  {!e.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-label="New" />}
                  <div className="min-w-0 flex-1">
                    <div className={`break-words ${e.read ? '' : 'font-medium'}`}>{e.message}</div>
                    <div className="tabular mt-0.5 text-[11px] text-[var(--muted)]">
                      {new Date(e.firedAt).toLocaleString()} · {e.symbol.split(':')[1]} {e.tf} · {e.price}
                    </div>
                  </div>
                </div>
              </li>
            ))}
            {loaded && !events.length && <li className="px-4 py-8 text-center text-xs text-[var(--muted)]">Nothing has fired yet.</li>}
          </ul>
          {events.length > 0 && (
            <button onClick={() => void useAlerts.getState().clearLog()} className="shrink-0 border-t border-[var(--border)] py-2 text-xs text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
              Clear log
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AlertRow({ alert: a }: { alert: Alert }) {
  const { openEdit, setStatus, remove } = useAlerts.getState();
  const [confirm, setConfirm] = useState(false);
  const st = STATUS[a.status];
  const run = (fn: () => Promise<void>) => fn().catch((err: Error) => toast({ tone: 'error', title: 'Alert not changed', body: err.message }));

  return (
    <li className="group relative cursor-pointer border-b border-[var(--border)]/60 px-3 py-2 hover:bg-[var(--hover)]" onClick={() => showAlertChart(a)}>
      <div className={`break-words pr-16 ${a.status === 'active' ? '' : 'text-[var(--muted)]'}`}>{a.message || describeAlert(a)}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden />
        <span>{st.label}</span>
        {a.message && <span className="truncate">· {a.symbol.ticker} {a.tf}</span>}
        {a.lastFiredAt && <span className="whitespace-nowrap">· fired {ago(a.lastFiredAt)}</span>}
        {a.notify.email && <span title="Also by email">· ✉</span>}
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
        {confirm ? (
          <>
            <button className="rounded bg-[var(--panel)] px-1.5 py-0.5 text-[11px] text-[#f23645] hover:bg-[var(--hover)]" onClick={() => run(() => remove(a.id))}>Delete</button>
            <button className="rounded bg-[var(--panel)] px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)]" onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : (
          <>
            {(a.status === 'active' || a.status === 'paused' || a.status === 'triggered') && (
              <Act title={a.status === 'active' ? 'Pause' : a.status === 'triggered' ? 'Re-arm' : 'Resume'}
                onClick={() => run(() => setStatus(a.id, a.status === 'active' ? 'paused' : 'active'))}>
                {a.status === 'active' ? <path d="M9 6v12M15 6v12" /> : <path d="M8 5.5v13l10-6.5z" />}
              </Act>
            )}
            <Act title="Edit" onClick={() => openEdit(a)}><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></Act>
            <Act title="Delete" onClick={() => setConfirm(true)}><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></Act>
          </>
        )}
      </div>
    </li>
  );
}

function Act({ title, onClick, children }: { title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">{children}</svg>
    </button>
  );
}

function Seg({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={`flex h-7 items-center gap-1 rounded px-2 text-xs ${on ? 'bg-[var(--hover)] font-semibold' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}>
      {children}
    </button>
  );
}

/** Desktop notifications are opt-in: the browser only asks after a click. */
function NotificationPrompt() {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  if (perm !== 'default') return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--hover)]/50 px-3 py-1.5 text-[11px]">
      <span className="flex-1 text-[var(--muted)]">Get a desktop notification when an alert fires in a background tab.</span>
      <button className="font-medium text-[var(--accent)] hover:underline" onClick={() => void Notification.requestPermission().then(setPerm)}>Enable</button>
    </div>
  );
}
