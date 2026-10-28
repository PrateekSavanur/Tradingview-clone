import { z } from 'zod';
import { TIMEFRAMES } from './timeframes.ts';
import { isSymbolId } from './symbols.ts';

/** User-scoped documents stored by the API (`/api/docs/:kind/:name`) or, signed out, in localStorage. */

const symbolId = z.string().refine(isSymbolId, 'invalid symbol id');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const SymbolRef = z.object({
  id: symbolId,
  provider: z.string().max(20),
  ticker: z.string().max(40),
  description: z.string().max(120),
  exchange: z.string().max(40),
  type: z.enum(['crypto', 'stock', 'index', 'fx', 'future']),
  tickSize: z.number().positive().finite(),
});

export const IndicatorInstanceDoc = z.object({
  uid: z.string().regex(/^[A-Za-z0-9-]{4,40}$/),
  type: z.string().regex(/^[a-z0-9]{1,24}$/),
  inputs: z.record(z.string().max(32), z.union([z.number().finite(), z.string().max(32)])),
  plots: z.record(z.string().max(32), z.object({ color, width: z.number().min(1).max(4), visible: z.boolean() })),
  hidden: z.boolean(),
});
export type IndicatorInstanceDoc = z.infer<typeof IndicatorInstanceDoc>;

export const CHART_TYPES = ['candles', 'hollow', 'heikin', 'bars', 'line', 'area'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const ChartDoc = z.object({
  symbol: SymbolRef,
  tf: z.enum(TIMEFRAMES),
  chartType: z.enum(CHART_TYPES),
  indicators: z.array(IndicatorInstanceDoc).max(20),
  logScale: z.boolean().optional(),
});
export type ChartDoc = z.infer<typeof ChartDoc>;

export const LAYOUTS = ['1', '2', '2v', '3', '4', '6'] as const;
export type LayoutKind = (typeof LAYOUTS)[number];
export const LAYOUT_CELLS: Record<LayoutKind, number> = { '1': 1, '2': 2, '2v': 2, '3': 3, '4': 4, '6': 6 };

export const SyncDoc = z.object({ symbol: z.boolean(), interval: z.boolean(), crosshair: z.boolean(), time: z.boolean() });

/** `charts` may hold more entries than the layout shows; switching back to a bigger layout restores them. */
export const WorkspaceDoc = z
  .object({
    layout: z.enum(LAYOUTS),
    charts: z.array(ChartDoc).min(1).max(6),
    active: z.number().int().min(0).max(5),
    sync: SyncDoc,
  })
  .refine((w) => w.active < Math.min(w.charts.length, LAYOUT_CELLS[w.layout]), { message: 'active chart out of range', path: ['active'] });
export type WorkspaceDoc = z.infer<typeof WorkspaceDoc>;

export const TemplateDoc = z.object({ indicators: z.array(IndicatorInstanceDoc).max(20) });
export type TemplateDoc = z.infer<typeof TemplateDoc>;

export const MAX_WATCHLISTS = 20;
export const MAX_WATCHLIST_SYMBOLS = 200;

export const WatchlistsDoc = z
  .object({
    active: z.number().int().min(0),
    lists: z.array(z.object({ name: z.string().min(1).max(64), symbols: z.array(SymbolRef).max(MAX_WATCHLIST_SYMBOLS) })).min(1).max(MAX_WATCHLISTS),
  })
  .refine((w) => w.active < w.lists.length, { message: 'active list out of range', path: ['active'] });
export type WatchlistsDoc = z.infer<typeof WatchlistsDoc>;

/** Schema per document kind. `workspace` and `watchlists` use the name `current`. */
export const DOC_SCHEMAS = {
  workspace: WorkspaceDoc,
  layouts: WorkspaceDoc,
  templates: TemplateDoc,
  watchlists: WatchlistsDoc,
} as const;
export type DocKind = keyof typeof DOC_SCHEMAS;
export const DOC_KINDS = Object.keys(DOC_SCHEMAS) as DocKind[];
/** Kinds holding a single document, always named `current`. */
export const SINGLETON_DOC_KINDS: readonly DocKind[] = ['workspace', 'watchlists'];
export const MAX_DOCS_PER_KIND = 100;
export const DOC_NAME_RE = /^[^\u0000-\u001f/\\]{1,64}$/;
