import {
  LAYOUT_CELLS, WorkspaceDoc, type ChartDoc, type IndicatorInstanceDoc, type LayoutKind, type SymbolInfo, type Timeframe,
} from '@chartdeck/shared';

/**
 * Pure operations on a workspace: a grid layout of charts, one of them active, with optional
 * symbol/interval linking. The store wraps these; keeping them pure keeps them testable.
 */

export const DEFAULT_SYMBOL: SymbolInfo = {
  id: 'binance:BTCUSDT', provider: 'binance', ticker: 'BTCUSDT', description: 'BTC / USDT',
  exchange: 'Binance', type: 'crypto', tickSize: 0.01,
};

export const newUid = () => crypto.randomUUID().slice(0, 8);

export function defaultChart(): ChartDoc {
  return { symbol: DEFAULT_SYMBOL, tf: '1m', chartType: 'candles', indicators: [] };
}

export function defaultWorkspace(): WorkspaceDoc {
  return { layout: '1', charts: [defaultChart()], active: 0, sync: { symbol: false, interval: false, crosshair: true, time: false } };
}

export const visibleCount = (ws: WorkspaceDoc) => Math.min(ws.charts.length, LAYOUT_CELLS[ws.layout]);

/** Copies of indicator instances with new uids, so instances never share an id across charts. */
export function cloneIndicators(list: IndicatorInstanceDoc[]): IndicatorInstanceDoc[] {
  return list.map((i) => ({ ...i, uid: newUid(), inputs: { ...i.inputs }, plots: structuredClone(i.plots) }));
}

function cloneChart(c: ChartDoc): ChartDoc {
  return { ...c, indicators: cloneIndicators(c.indicators) };
}

/** Make a parsed or hand-built workspace usable: enough charts for the layout, active in range. */
export function normalize(ws: WorkspaceDoc): WorkspaceDoc {
  const cells = LAYOUT_CELLS[ws.layout];
  const charts = ws.charts.slice(0, 6);
  if (!charts.length) charts.push(defaultChart());
  const template = charts[Math.min(ws.active, charts.length - 1)]!;
  while (charts.length < cells) charts.push(cloneChart(template));
  return { ...ws, charts, active: Math.min(Math.max(0, ws.active), cells - 1) };
}

/** Parse untrusted JSON (localStorage, server) into a workspace, or null if it doesn't fit the schema. */
export function parseWorkspace(data: unknown): WorkspaceDoc | null {
  const parsed = WorkspaceDoc.safeParse(data);
  return parsed.success ? normalize(parsed.data) : null;
}

/** New cells copy the active chart; charts beyond the layout are kept so a larger layout restores them. */
export function setLayout(ws: WorkspaceDoc, layout: LayoutKind): WorkspaceDoc {
  return normalize({ ...ws, layout, active: Math.min(ws.active, LAYOUT_CELLS[layout] - 1) });
}

export function setActive(ws: WorkspaceDoc, index: number): WorkspaceDoc {
  return index === ws.active || index < 0 || index >= visibleCount(ws) ? ws : { ...ws, active: index };
}

function mapCharts(ws: WorkspaceDoc, index: number, linked: boolean, fn: (c: ChartDoc) => ChartDoc): WorkspaceDoc {
  const n = visibleCount(ws);
  return { ...ws, charts: ws.charts.map((c, i) => (i === index || (linked && i < n) ? fn(c) : c)) };
}

/** With symbol sync on, every visible chart follows. */
export function setSymbol(ws: WorkspaceDoc, index: number, symbol: SymbolInfo): WorkspaceDoc {
  return mapCharts(ws, index, ws.sync.symbol, (c) => (c.symbol.id === symbol.id ? c : { ...c, symbol }));
}

/** With interval sync on, every visible chart follows. */
export function setTf(ws: WorkspaceDoc, index: number, tf: Timeframe): WorkspaceDoc {
  return mapCharts(ws, index, ws.sync.interval, (c) => (c.tf === tf ? c : { ...c, tf }));
}

export function patchChart(ws: WorkspaceDoc, index: number, patch: Partial<Omit<ChartDoc, 'symbol' | 'tf'>>): WorkspaceDoc {
  return mapCharts(ws, index, false, (c) => ({ ...c, ...patch }));
}

/** Turning a link on aligns every visible chart with the active one right away. */
export function setSync(ws: WorkspaceDoc, patch: Partial<WorkspaceDoc['sync']>): WorkspaceDoc {
  let next: WorkspaceDoc = { ...ws, sync: { ...ws.sync, ...patch } };
  const active = ws.charts[ws.active]!;
  if (patch.symbol && !ws.sync.symbol) next = setSymbol(next, ws.active, active.symbol);
  if (patch.interval && !ws.sync.interval) next = setTf(next, ws.active, active.tf);
  return next;
}

/** A saved layout loads with fresh indicator uids; charts in it may point at any symbol. */
export function loadLayout(doc: WorkspaceDoc): WorkspaceDoc {
  return normalize({ ...doc, charts: doc.charts.map(cloneChart) });
}
