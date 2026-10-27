import { useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { feed } from '../lib/feed.ts';
import { STAGES, STAGE_LABELS, type Stage, type StageStats } from '../lib/latency.ts';
import { useUi } from '../store/ui.ts';

interface Snapshot {
  stats: Record<Stage, StageStats> | null;
  samples: number;
  msgRate: number;
  offset: number;
  rtt: number;
  bars: number;
  epoch: number | undefined;
}

export function DebugPanel({ controller }: { controller: ChartController | null }) {
  const { debugOpen, toggleDebug, symbol } = useUi();
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!debugOpen) return;
    let lastMsgs = feed.messages;
    let lastAt = performance.now();
    const tick = () => {
      const now = performance.now();
      const rate = ((feed.messages - lastMsgs) * 1000) / (now - lastAt);
      lastMsgs = feed.messages;
      lastAt = now;
      setSnap({
        stats: controller?.latency.stats() ?? null,
        samples: controller?.latency.count ?? 0,
        msgRate: rate,
        offset: feed.offset,
        rtt: feed.rtt,
        bars: controller?.status.bars ?? 0,
        epoch: feed.providers.get(symbol.provider)?.epoch,
      });
    };
    tick();
    const t = window.setInterval(tick, 500);
    return () => window.clearInterval(t);
  }, [debugOpen, controller, symbol.provider]);

  if (!debugOpen) return null;
  const ms = (v: number | undefined) => (v === undefined ? '–' : v < 10 ? v.toFixed(1) : Math.round(v).toString());

  return (
    <div className="absolute bottom-10 right-16 z-20 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-[var(--panel)]/95 text-xs shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="font-semibold">Latency · {symbol.ticker}</span>
        <button onClick={toggleDebug} className="rounded px-1 text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="Close debug panel">✕</button>
      </div>
      <table className="tabular w-full">
        <thead className="text-[var(--muted)]">
          <tr>
            <th className="px-3 py-1 text-left font-normal">Stage (ms)</th>
            <th className="px-1 text-right font-normal">last</th>
            <th className="px-1 text-right font-normal">p50</th>
            <th className="px-1 text-right font-normal">p90</th>
            <th className="px-3 text-right font-normal">p99</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((s) => {
            const st = snap?.stats?.[s];
            const total = s === 'total';
            return (
              <tr key={s} className={total ? 'border-t border-[var(--border)] font-semibold' : ''}>
                <td className="px-3 py-0.5">{STAGE_LABELS[s]}</td>
                <td className="px-1 text-right">{ms(st?.last)}</td>
                <td className={`px-1 text-right ${total && st && st.p50 > 300 ? 'text-amber-500' : ''}`}>{ms(st?.p50)}</td>
                <td className="px-1 text-right">{ms(st?.p90)}</td>
                <td className="px-3 text-right">{ms(st?.p99)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-[var(--border)] px-3 py-2 text-[var(--muted)]">
        <span>Samples: {snap?.samples ?? 0}</span>
        <span>Msgs/s: {snap ? snap.msgRate.toFixed(1) : '–'}</span>
        <span>Clock offset: {snap ? Math.round(snap.offset) : '–'} ms</span>
        <span>WS RTT: {snap?.rtt ?? '–'} ms</span>
        <span>Bars loaded: {snap?.bars ?? 0}</span>
        <span>Epoch: {snap?.epoch ?? '–'}</span>
      </div>
      <p className="border-t border-[var(--border)] px-3 py-2 text-[10.5px] leading-snug text-[var(--muted)]">
        Exchange → ingest includes network distance to the exchange and up to ±RTT/2 error from estimating its clock.
      </p>
    </div>
  );
}
