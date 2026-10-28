import type { LayoutKind } from '@chartdeck/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useWorkspace } from '../store/workspace.ts';
import { visibleCount } from '../workspace/model.ts';
import { ChartView } from './ChartView.tsx';

/** Grid template per layout; with '3', the first chart spans the left column. */
const GRID: Record<LayoutKind, string> = {
  '1': 'grid-cols-1 grid-rows-1',
  '2': 'grid-cols-2 grid-rows-1',
  '2v': 'grid-cols-1 grid-rows-2',
  '3': 'grid-cols-2 grid-rows-2 [&>:first-child]:row-span-2',
  '4': 'grid-cols-2 grid-rows-2',
  '6': 'grid-cols-3 grid-rows-2',
};

/**
 * The charts of the current layout. Cells are keyed by position, so a chart keeps its controller
 * (and loaded history) when the layout changes around it. Reports every live controller upward.
 */
export function ChartGrid({ onControllers }: { onControllers(cs: ReadonlyArray<ChartController | null>): void }) {
  const layout = useWorkspace((s) => s.ws.layout);
  const count = useWorkspace((s) => visibleCount(s.ws));
  const crosshair = useWorkspace((s) => s.ws.sync.crosshair);
  const time = useWorkspace((s) => s.ws.sync.time);
  const [controllers, setControllers] = useState<ReadonlyArray<ChartController | null>>([]);

  const onController = useCallback((index: number, c: ChartController | null) => {
    setControllers((prev) => {
      if (prev[index] === c) return prev;
      const next = prev.slice();
      next[index] = c;
      return next;
    });
  }, []);

  useEffect(() => onControllers(controllers.slice(0, count)), [onControllers, controllers, count]);

  // Linked crosshair and scrolling: whichever chart the pointer is on drives the others.
  useEffect(() => {
    const cs = controllers.slice(0, count).filter((c): c is ChartController => !!c);
    if (cs.length < 2) return;
    const offs: Array<() => void> = [];
    for (const src of cs) {
      const others = cs.filter((c) => c !== src);
      if (crosshair) offs.push(src.onCrosshairSync((t) => others.forEach((c) => c.showCrosshair(t))));
      if (time) offs.push(src.onRangeSync((r) => others.forEach((c) => c.showTimes(r))));
    }
    return () => offs.forEach((off) => off());
  }, [controllers, count, crosshair, time]);

  return (
    <div className={`grid min-h-0 flex-1 gap-px bg-[var(--border)] ${GRID[layout]}`}>
      {Array.from({ length: count }, (_, i) => <ChartView key={i} index={i} onController={onController} />)}
    </div>
  );
}
