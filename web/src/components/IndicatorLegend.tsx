import type { ChartController } from '../chart/ChartController.ts';
import type { IndicatorLegendItem } from '../chart/IndicatorLayer.ts';
import { formatPrice, formatVolume } from '../lib/format.ts';
import { useIndicators } from '../store/indicators.ts';
import { useWorkspace } from '../store/workspace.ts';
import { ToolIcon } from './ToolIcon.tsx';

/** Rows with name, inputs and values; overlays sit under the main legend, oscillators at their pane's top. */
export function IndicatorLegend({ chart, items, controller, priceDecimals }: { chart: number; items: IndicatorLegendItem[]; controller: ChartController | null; priceDecimals: number }) {
  if (!controller || !items.length) return null;
  const overlay = items.filter((i) => i.pane === 0);
  const panes = items.filter((i) => i.pane > 0);
  const fmt = (v: number | null, pane: number) => {
    if (v === null) return '∅';
    if (pane === 0) return formatPrice(v, priceDecimals);
    return Math.abs(v) >= 1e4 ? formatVolume(v) : v.toFixed(2);
  };
  const row = (it: IndicatorLegendItem) => <Row key={it.uid} chart={chart} item={it} fmt={(v) => fmt(v, it.pane)} />;
  return (
    <>
      {overlay.length > 0 && <div className="absolute left-3 top-[3.1rem] z-10 flex flex-col gap-0.5">{overlay.map(row)}</div>}
      {panes.map((it) => (
        <div key={it.uid} className="absolute left-3 z-10" style={{ top: controller.paneTop(it.pane) + 4 }}>
          {row(it)}
        </div>
      ))}
    </>
  );
}

function Row({ chart, item, fmt }: { chart: number; item: IndicatorLegendItem; fmt(v: number | null): string }) {
  const edit = useIndicators((s) => s.edit);
  const { updateIndicator, removeIndicator } = useWorkspace.getState();
  const inst = useWorkspace((s) => s.ws.charts[chart]?.indicators.find((i) => i.uid === item.uid));
  return (
    <div className="group flex h-5 items-center gap-2 text-xs leading-5">
      <span className={item.hidden ? 'text-[var(--muted)] line-through' : ''}>{item.title}</span>
      {!item.hidden && (
        <span className="tabular flex gap-2">
          {item.values.map((v) => <span key={v.label} style={{ color: v.color }} title={v.label}>{fmt(v.value)}</span>)}
        </span>
      )}
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <LegendBtn title={item.hidden ? 'Show' : 'Hide'} onClick={() => inst && updateIndicator(chart, inst.uid, { hidden: !inst.hidden })}>
          <ToolIcon name={item.hidden ? 'eyeOff' : 'eye'} size={14} />
        </LegendBtn>
        <LegendBtn title="Settings" onClick={() => edit({ chart, uid: item.uid })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
        </LegendBtn>
        <LegendBtn title="Remove" onClick={() => removeIndicator(chart, item.uid)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </LegendBtn>
      </span>
    </div>
  );
}

function LegendBtn(props: { title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button title={props.title} aria-label={props.title} onClick={props.onClick}
      className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded bg-[var(--panel)]/80 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
      {props.children}
    </button>
  );
}
