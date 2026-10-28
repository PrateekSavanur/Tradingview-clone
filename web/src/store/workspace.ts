import { INDICATOR_BY_ID } from '@chartdeck/indicators';
import type { ChartDoc, ChartType, IndicatorInstanceDoc, LayoutKind, SymbolInfo, Timeframe, WorkspaceDoc } from '@chartdeck/shared';
import { create } from 'zustand';
import { SingletonDoc } from '../lib/docs.ts';
import * as M from '../workspace/model.ts';
import { MAX_INDICATORS, newInstance } from './indicators.ts';

interface WorkspaceState {
  ws: WorkspaceDoc;
  setLayout(layout: LayoutKind): void;
  setActive(index: number): void;
  /** Applies to the active chart unless `index` is given; linked charts follow. */
  setSymbol(symbol: SymbolInfo, index?: number): void;
  setTf(tf: Timeframe, index?: number): void;
  setChartType(type: ChartType): void;
  setLogScale(on: boolean): void;
  setSync(patch: Partial<WorkspaceDoc['sync']>): void;
  addIndicator(type: string): void;
  removeIndicator(chart: number, uid: string): void;
  updateIndicator(chart: number, uid: string, patch: Partial<Pick<IndicatorInstanceDoc, 'inputs' | 'plots' | 'hidden'>>): void;
  /** Replace the active chart's indicators (applying a template). */
  setIndicators(list: IndicatorInstanceDoc[]): void;
  /** Open a saved layout. */
  load(doc: WorkspaceDoc): void;
}

const doc = new SingletonDoc('workspace', 'chartdeck-workspace');

/** Before workspaces, one chart's settings lived under these keys. */
function migrateLegacy(): WorkspaceDoc | null {
  try {
    const ui = (JSON.parse(localStorage.getItem('chartdeck-ui') ?? 'null') as { state?: Partial<ChartDoc> } | null)?.state;
    const ind = (JSON.parse(localStorage.getItem('chartdeck-indicators') ?? 'null') as { state?: { list?: unknown } } | null)?.state;
    if (!ui && !ind) return null;
    const ws = M.defaultWorkspace();
    ws.charts[0] = { ...ws.charts[0]!, ...(ui?.symbol && { symbol: ui.symbol }), ...(ui?.tf && { tf: ui.tf }), ...(ui?.chartType && { chartType: ui.chartType }) };
    if (Array.isArray(ind?.list)) ws.charts[0].indicators = ind.list as IndicatorInstanceDoc[];
    const parsed = M.parseWorkspace(ws);
    localStorage.removeItem('chartdeck-indicators');
    return parsed;
  } catch {
    return null;
  }
}

/** Drop instances of indicators this build doesn't know (saved by a newer or older version). */
function knownIndicators(ws: WorkspaceDoc): WorkspaceDoc {
  return { ...ws, charts: ws.charts.map((c) => ({ ...c, indicators: c.indicators.filter((i) => INDICATOR_BY_ID.has(i.type)) })) };
}

const cached = doc.cached();
const initial = knownIndicators(M.normalize(cached ?? migrateLegacy() ?? M.defaultWorkspace()));
if (!cached) doc.save(initial); // the legacy keys are gone after migrating

export const useWorkspace = create<WorkspaceState>()((set) => {
  const update = (fn: (ws: WorkspaceDoc) => WorkspaceDoc) => set((s) => {
    const ws = fn(s.ws);
    return ws === s.ws ? s : { ws };
  });
  const indicators = (chart: number, fn: (list: IndicatorInstanceDoc[]) => IndicatorInstanceDoc[]) =>
    update((ws) => (ws.charts[chart] ? M.patchChart(ws, chart, { indicators: fn(ws.charts[chart].indicators) }) : ws));

  return {
    ws: initial,
    setLayout: (layout) => update((ws) => M.setLayout(ws, layout)),
    setActive: (index) => update((ws) => M.setActive(ws, index)),
    setSymbol: (symbol, index) => update((ws) => M.setSymbol(ws, index ?? ws.active, symbol)),
    setTf: (tf, index) => update((ws) => M.setTf(ws, index ?? ws.active, tf)),
    setChartType: (chartType) => update((ws) => M.patchChart(ws, ws.active, { chartType })),
    setLogScale: (logScale) => update((ws) => M.patchChart(ws, ws.active, { logScale })),
    setSync: (patch) => update((ws) => M.setSync(ws, patch)),
    addIndicator: (type) =>
      update((ws) => {
        const list = ws.charts[ws.active]!.indicators;
        const inst = newInstance(type);
        return inst && list.length < MAX_INDICATORS ? M.patchChart(ws, ws.active, { indicators: [...list, inst] }) : ws;
      }),
    removeIndicator: (chart, uid) => indicators(chart, (list) => list.filter((i) => i.uid !== uid)),
    updateIndicator: (chart, uid, patch) => indicators(chart, (list) => list.map((i) => (i.uid === uid ? { ...i, ...patch } : i))),
    setIndicators: (list) => update((ws) => M.patchChart(ws, ws.active, { indicators: M.cloneIndicators(list).slice(0, MAX_INDICATORS) })),
    load: (d) => update(() => knownIndicators(M.loadLayout(d))),
  };
});

/** Call after sign-in: the account's workspace replaces this browser's, or receives it if it has none. */
export const syncWorkspaceWithAccount = doc.bind(
  () => useWorkspace.getState().ws,
  (ws) => useWorkspace.setState({ ws: knownIndicators(M.normalize(ws)) }),
  (onChange) => useWorkspace.subscribe((s, prev) => s.ws !== prev.ws && onChange()),
);

export const useActiveChart = () => useWorkspace((s) => s.ws.charts[s.ws.active]!);
