import { useEffect, useRef, useState } from 'react';
import { signOut, useAuth } from '../lib/auth.ts';
import { useAlerts } from '../store/alerts.ts';
import { useIndicators } from '../store/indicators.ts';
import { CHART_TYPES, CHART_TYPE_LABELS, useUi } from '../store/ui.ts';
import { useActiveChart, useWorkspace } from '../store/workspace.ts';
import { ChartTypeIcon } from './TopBar.tsx';

/**
 * Phone-width overflow menu: everything the desktop top bar shows inline that doesn't fit on a
 * narrow screen. Multi-chart layouts and the latency panel are left out; they need a big screen.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { theme, toggleTheme, toggleSidePanel, setAuthOpen } = useUi();
  const unread = useAlerts((s) => s.unread);
  const { chartType, logScale = false } = useActiveChart();
  const { setChartType, setLogScale } = useWorkspace.getState();
  const { user, ready, available } = useAuth();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item = 'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-[var(--hover)]';

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        onClick={() => setOpen(!open)}
        aria-label="More"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        {unread > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--color-down)]" aria-hidden />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-50 w-64 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] py-1 shadow-2xl">
          <button role="menuitem" className={item} onClick={run(() => useIndicators.getState().openPicker(true))}>
            <span className="w-4 text-center font-serif italic">fx</span> Indicators
          </button>
          <button role="menuitem" className={item} onClick={run(() => useAlerts.getState().openCreate())}>
            <Icon d="M12 10v3l2 2M5 4 2.5 6.5M19 4l2.5 2.5" circle /> Create alert
          </button>
          <button role="menuitem" className={item} onClick={run(() => toggleSidePanel('alerts'))}>
            <Icon d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0" /> Alerts
            {unread > 0 && <span className="ml-auto rounded-full bg-[var(--color-down)] px-1.5 text-[10px] text-white">{unread}</span>}
          </button>
          <div className="my-1 border-t border-[var(--border)]" />
          <div className="px-4 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-[var(--muted)]">Chart type</div>
          <div className="grid grid-cols-6 gap-1 px-3 pb-2">
            {CHART_TYPES.map((t) => (
              <button
                key={t}
                onClick={run(() => setChartType(t))}
                aria-label={CHART_TYPE_LABELS[t]}
                aria-pressed={t === chartType}
                className={`flex h-9 items-center justify-center rounded ${t === chartType ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'hover:bg-[var(--hover)]'}`}
              >
                <ChartTypeIcon type={t} />
              </button>
            ))}
          </div>
          <button role="menuitemcheckbox" aria-checked={logScale} className={item} onClick={run(() => setLogScale(!logScale))}>
            <span className="w-4 text-center text-xs">log</span> Logarithmic scale
            {logScale && <span className="ml-auto text-[var(--accent)]">✓</span>}
          </button>
          <button role="menuitem" className={item} onClick={run(toggleTheme)}>
            <Icon d={theme === 'dark' ? 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' : 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'} />
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          {ready && available && (
            <>
              <div className="my-1 border-t border-[var(--border)]" />
              {user ? (
                <>
                  <div className="truncate px-4 py-1.5 text-xs text-[var(--muted)]">{user.email}</div>
                  <button role="menuitem" className={item} onClick={run(() => void signOut())}>Sign out</button>
                </>
              ) : (
                <button role="menuitem" className={`${item} text-[var(--accent)]`} onClick={run(() => setAuthOpen(true))}>
                  Sign in to sync and get alerts
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Icon({ d, circle }: { d: string; circle?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      {circle && <circle cx="12" cy="13" r="7" />}
      <path d={d} />
    </svg>
  );
}
