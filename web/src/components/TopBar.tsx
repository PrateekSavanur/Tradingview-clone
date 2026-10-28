import { TIMEFRAMES } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useIndicators } from '../store/indicators.ts';
import { CHART_TYPES, CHART_TYPE_LABELS, useUi, type ChartType } from '../store/ui.ts';
import { useActiveChart, useWorkspace } from '../store/workspace.ts';
import { AuthMenu } from './AuthMenu.tsx';
import { LayoutMenu } from './LayoutMenu.tsx';
import { StatusIndicator } from './StatusIndicator.tsx';

export function TopBar({ controller }: { controller: ChartController | null }) {
  const { theme, toggleTheme, toggleDebug, debugOpen, openSearch, watchlistOpen, toggleWatchlist } = useUi();
  const { symbol, tf, logScale = false } = useActiveChart();
  const { setTf, setLogScale } = useWorkspace.getState();
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--panel)] px-2">
      <div className="mr-1 flex items-center gap-1.5 pl-1 pr-2 font-semibold tracking-tight">
        <img src="/favicon.svg" alt="" className="h-5 w-5" />
        <span className="hidden md:inline">ChartDeck</span>
      </div>
      <button
        onClick={() => openSearch()}
        className="flex h-8 items-center gap-2 rounded px-2 text-sm font-semibold hover:bg-[var(--hover)]"
        title="Symbol search (or just start typing)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        {symbol.ticker}
      </button>
      <Divider />
      <nav className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]" aria-label="Timeframe">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            aria-pressed={t === tf}
            className={`h-8 shrink-0 rounded px-2 text-[13px] hover:bg-[var(--hover)] ${t === tf ? 'font-semibold text-[var(--accent)]' : ''}`}
          >
            {t}
          </button>
        ))}
      </nav>
      <Divider />
      <ChartTypeMenu />
      <Divider />
      <button
        onClick={() => useIndicators.getState().openPicker(true)}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-[13px] hover:bg-[var(--hover)]"
        title="Indicators (/)"
      >
        <span className="font-serif text-[15px] italic leading-none">fx</span>
        <span className="hidden lg:inline">Indicators</span>
      </button>
      <button
        onClick={() => setLogScale(!logScale)}
        aria-pressed={logScale}
        className={`h-8 shrink-0 rounded px-2 text-[13px] hover:bg-[var(--hover)] ${logScale ? 'font-semibold text-[var(--accent)]' : ''}`}
        title="Logarithmic price scale"
      >
        log
      </button>
      <Divider />
      <LayoutMenu />
      <div className="flex-1" />
      <StatusIndicator controller={controller} />
      <IconButton onClick={toggleDebug} pressed={debugOpen} title="Latency debug panel">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
      </IconButton>
      <IconButton onClick={toggleWatchlist} pressed={watchlistOpen} title="Watchlist">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
      </IconButton>
      <IconButton onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
        {theme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
        )}
      </IconButton>
      <div className="ml-1">
        <AuthMenu />
      </div>
    </header>
  );
}

function ChartTypeMenu() {
  const { chartType } = useActiveChart();
  const setChartType = useWorkspace((s) => s.setChartType);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-1.5 rounded px-2 text-[13px] hover:bg-[var(--hover)]"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chart type"
      >
        <ChartTypeIcon type={chartType} />
        <span className="hidden lg:inline">{CHART_TYPE_LABELS[chartType]}</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-9 z-40 w-44 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-xl">
          {CHART_TYPES.map((t) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={t === chartType}
              onClick={() => {
                setChartType(t);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hover)] ${t === chartType ? 'text-[var(--accent)]' : ''}`}
            >
              <ChartTypeIcon type={t} />
              {CHART_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChartTypeIcon({ type }: { type: ChartType }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 };
  switch (type) {
    case 'line':
      return <svg {...common}><path d="M3 17l5-6 4 3 7-9" /></svg>;
    case 'area':
      return <svg {...common}><path d="M3 17l5-6 4 3 7-9v15H3z" fill="currentColor" fillOpacity="0.25" /></svg>;
    case 'bars':
      return <svg {...common}><path d="M7 4v16M4 8h3M7 15h3M17 6v14M14 10h3M17 16h3" /></svg>;
    case 'hollow':
      return <svg {...common}><path d="M8 3v4M8 17v4M16 5v3M16 17v3" /><rect x="5.5" y="7" width="5" height="10" rx="0.5" /><rect x="13.5" y="8" width="5" height="9" rx="0.5" fill="currentColor" /></svg>;
    case 'heikin':
      return <svg {...common}><path d="M8 3v18M16 3v18" /><rect x="5.5" y="6" width="5" height="9" rx="0.5" fill="currentColor" /><rect x="13.5" y="9" width="5" height="8" rx="0.5" fill="currentColor" fillOpacity="0.4" /></svg>;
    default:
      return <svg {...common}><path d="M8 3v4M8 17v4M16 5v3M16 17v3" /><rect x="5.5" y="7" width="5" height="10" rx="0.5" fill="currentColor" /><rect x="13.5" y="8" width="5" height="9" rx="0.5" /></svg>;
  }
}

export function IconButton(props: { onClick(): void; title: string; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.pressed}
      className={`flex h-8 w-8 items-center justify-center rounded hover:bg-[var(--hover)] ${props.pressed ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}
    >
      {props.children}
    </button>
  );
}

export function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-[var(--border)]" />;
}
