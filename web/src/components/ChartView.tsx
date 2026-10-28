import { useEffect, useRef, useState } from 'react';
import { ChartController, type ChartStatus, type LegendData } from '../chart/ChartController.ts';
import { feed } from '../lib/feed.ts';
import { decimalsFor } from '../lib/format.ts';
import { useAlerts } from '../store/alerts.ts';
import { useUi } from '../store/ui.ts';
import { useWorkspace } from '../store/workspace.ts';
import { IndicatorLegend } from './IndicatorLegend.tsx';
import { Legend } from './Legend.tsx';
import { SelectionToolbar } from './SelectionToolbar.tsx';
import { TextEditor } from './TextEditor.tsx';

/** One cell of the layout: owns a ChartController and mirrors chart `index` of the workspace into it. */
export function ChartView({ index, onController }: { index: number; onController(index: number, c: ChartController | null): void }) {
  const el = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<ChartController | null>(null);
  const [legend, setLegend] = useState<LegendData | null>(null);
  const [status, setStatus] = useState<ChartStatus | null>(null);
  const chart = useWorkspace((s) => s.ws.charts[index]!);
  const active = useWorkspace((s) => s.ws.active === index);
  const multi = useWorkspace((s) => s.ws.layout !== '1');
  const setActive = useWorkspace((s) => s.setActive);
  const theme = useUi((s) => s.theme);
  const { symbol, tf, chartType, indicators, logScale = false } = chart;

  useEffect(() => {
    const c = new ChartController(el.current!, feed, { chartType: useWorkspace.getState().ws.charts[index]!.chartType, theme: useUi.getState().theme });
    setCtl(c);
    onController(index, c);
    if (import.meta.env.DEV) ((window as unknown as { __charts?: ChartController[] }).__charts ??= [])[index] = c;
    const offLegend = c.onLegend(setLegend);
    const offStatus = c.onStatus(setStatus);
    return () => {
      offLegend();
      offStatus();
      onController(index, null);
      c.destroy();
    };
  }, [index, onController]);

  useEffect(() => ctl?.setSymbol(symbol, tf), [ctl, symbol, tf]);
  useEffect(() => ctl?.setChartType(chartType), [ctl, chartType]);
  useEffect(() => ctl?.setTheme(theme), [ctl, theme]);
  useEffect(() => ctl?.setIndicators(indicators), [ctl, indicators]);
  useEffect(() => ctl?.setLogScale(logScale), [ctl, logScale]);
  useEffect(() => ctl?.setActive(active), [ctl, active]);

  // Active price-level alerts on this symbol show as dashed lines on the price scale.
  const alerts = useAlerts((s) => s.alerts);
  useEffect(() => {
    ctl?.setAlertLevels(
      alerts.flatMap((a) =>
        a.status === 'active' && a.symbol.id === symbol.id && a.source.kind === 'price' && a.target.kind === 'value'
          ? [{ price: a.target.value, title: `⏰ ${a.tf}` }]
          : [],
      ),
    );
  }, [ctl, alerts, symbol.id]);

  return (
    <div className="relative min-h-0 min-w-0 bg-[var(--bg)]" onPointerDownCapture={() => setActive(index)}>
      <div ref={el} className="absolute inset-0" />
      {multi && active && <div className="pointer-events-none absolute inset-0 z-20 border-2 border-[var(--accent)]/70" aria-hidden />}
      <Legend symbol={symbol} tf={tf} data={legend} />
      <IndicatorLegend chart={index} items={legend?.indicators ?? []} controller={ctl} priceDecimals={decimalsFor(symbol.tickSize)} />
      <SelectionToolbar controller={ctl} />
      <TextEditor controller={ctl} />
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
