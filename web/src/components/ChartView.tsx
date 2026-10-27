import { useEffect, useRef, useState } from 'react';
import { ChartController, type ChartStatus, type LegendData } from '../chart/ChartController.ts';
import { feed } from '../lib/feed.ts';
import { useUi } from '../store/ui.ts';
import { Legend } from './Legend.tsx';

export function ChartView({ onController }: { onController(c: ChartController | null): void }) {
  const el = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<ChartController | null>(null);
  const [legend, setLegend] = useState<LegendData | null>(null);
  const [status, setStatus] = useState<ChartStatus | null>(null);
  const { symbol, tf, chartType, theme, openSearch } = useUi();

  useEffect(() => {
    const { chartType, theme } = useUi.getState();
    const c = new ChartController(el.current!, feed, { chartType, theme });
    setCtl(c);
    onController(c);
    const offLegend = c.onLegend(setLegend);
    const offStatus = c.onStatus(setStatus);
    return () => {
      offLegend();
      offStatus();
      onController(null);
      c.destroy();
    };
  }, [onController]);

  useEffect(() => ctl?.setSymbol(symbol, tf), [ctl, symbol, tf]);
  useEffect(() => ctl?.setChartType(chartType), [ctl, chartType]);
  useEffect(() => ctl?.setTheme(theme), [ctl, theme]);

  // Typing a letter or digit on the chart opens symbol search, prefilled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, [contenteditable]')) return;
      if (/^[a-z0-9]$/i.test(e.key)) {
        e.preventDefault();
        // Keys can land here before the dialog's input takes focus; keep them rather than restarting.
        const { searchOpen, searchSeed } = useUi.getState();
        openSearch((searchOpen ? searchSeed : '') + e.key.toUpperCase());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={el} className="absolute inset-0" />
      <Legend symbol={symbol} tf={tf} data={legend} />
      {status?.loading && <Overlay>Loading {symbol.ticker}…</Overlay>}
      {status?.error && (
        <div className="absolute bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-md border border-[var(--down,#f23645)]/40 bg-[var(--panel)] px-3 py-1.5 text-xs text-[#f23645] shadow">
          {status.error}
        </div>
      )}
      {status?.loadingOlder && (
        <div className="pointer-events-none absolute bottom-8 left-3 z-10 text-[11px] text-[var(--muted)]">Loading older bars…</div>
      )}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="rounded-md bg-[var(--panel)]/90 px-3 py-1.5 text-sm text-[var(--muted)] shadow">{children}</div>
    </div>
  );
}
