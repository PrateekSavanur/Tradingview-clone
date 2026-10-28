import { useAlerts } from '../store/alerts.ts';
import { useUi, type SidePanel as Panel } from '../store/ui.ts';
import { AlertsPanel } from './AlertsPanel.tsx';
import { WatchlistPanel } from './WatchlistPanel.tsx';

/** Right-hand panel: watchlist or alerts. */
export function SidePanel({ panel }: { panel: Panel }) {
  const setSidePanel = useUi((s) => s.setSidePanel);
  const unread = useAlerts((s) => s.unread);
  const tab = (p: Panel, label: string, badge = 0) => (
    <button
      role="tab"
      aria-selected={panel === p}
      onClick={() => setSidePanel(p)}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 pb-2 pt-2.5 text-[13px] font-semibold ${panel === p ? 'border-[var(--accent)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'}`}
    >
      {label}
      {badge > 0 && <span className="tabular rounded-full bg-[var(--accent)] px-1.5 text-[10px] leading-4 text-white">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)] text-[13px]">
      <div className="flex shrink-0 items-center gap-4 border-b border-[var(--border)] px-3" role="tablist">
        {tab('watchlist', 'Watchlist')}
        {tab('alerts', 'Alerts', unread)}
        <div className="flex-1" />
        <button onClick={() => setSidePanel(null)} aria-label="Close panel" className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)]">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {panel === 'watchlist' ? <WatchlistPanel /> : <AlertsPanel />}
    </aside>
  );
}
