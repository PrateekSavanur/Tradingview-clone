import { DRAWING_POINTS, type Candle, type Drawing, type DrawingPoint, type DrawingType, type Timeframe } from '@chartdeck/shared';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, IPrimitivePaneView, Logical,
  PrimitiveHoveredItem, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';
import { History, TimeIndex, type Pt } from './geometry.ts';
import { loadDrawings, saveDrawings } from './persistence.ts';
import { HIT_PX, TOOLS, type Viewport } from './tools.ts';

export interface DrawingUiState {
  tool: DrawingType | null;
  magnet: boolean;
  hidden: boolean;
  selected: Drawing | null;
  canUndo: boolean;
  canRedo: boolean;
  count: number;
  /** Inline text editor request, in chart-container pixels. */
  editing: { id: string; x: number; y: number; text: string; color: string; fontSize: number } | null;
}

export interface DrawingHost {
  chart: IChartApi;
  container: HTMLElement;
  bars(): readonly Candle[];
  /** OHLC values the magnet may snap to for bar `i` (as displayed, e.g. Heikin Ashi). */
  magnetPrices(i: number): number[];
  tf(): Timeframe;
  fmtPrice(p: number): string;
  fmtTime(t: number): string;
  fmtVolume(v: number): string;
  textColor(): string;
}

interface Draft {
  drawing: Drawing;
  placed: number;
  down: Pt;
}

interface Drag {
  id: string;
  handle: number | null;
  startLogical: number;
  startPrice: number;
  orig: Drawing;
  before: Drawing[];
  moved: boolean;
}

const HANDLE_RADIUS = 5;
const DRAG_CREATE_PX = 8;

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/**
 * Owns every drawing on one chart: state, mouse/touch interaction, undo/redo and persistence.
 * Rendering happens in Lightweight Charts' own paint pass through a series primitive, so drawings
 * stay locked to the candles while panning and zooming.
 */
export class DrawingManager {
  private drawings: Drawing[] = [];
  private symbol: string | null = null;
  private loadSeq = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private tool: DrawingType | null = null;
  private magnet = false;
  private hidden = false;
  private draft: Draft | null = null;
  private drag: Drag | null = null;
  private editing: DrawingUiState['editing'] = null;
  private blockNative = false;
  private readonly history = new History<Drawing[]>();
  private readonly listeners = new Set<(s: DrawingUiState) => void>();
  private series: ISeriesApi<SeriesType> | null = null;
  private readonly primitive: DrawingsPrimitive;

  constructor(private readonly host: DrawingHost) {
    this.primitive = new DrawingsPrimitive(this);
    const c = host.container;
    c.addEventListener('pointerdown', this.onPointerDown, true);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('dblclick', this.onDoubleClick, true);
    // Lightweight Charts listens to mouse/touch events; keep them away from it while we own the gesture.
    c.addEventListener('mousedown', this.blockIfOwned, true);
    c.addEventListener('touchstart', this.blockIfOwned, true);
    window.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    const c = this.host.container;
    c.removeEventListener('pointerdown', this.onPointerDown, true);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('dblclick', this.onDoubleClick, true);
    c.removeEventListener('mousedown', this.blockIfOwned, true);
    c.removeEventListener('touchstart', this.blockIfOwned, true);
    window.removeEventListener('keydown', this.onKey);
    this.series?.detachPrimitive(this.primitive);
  }

  /** (Re)attach to the main series; called when the chart type swaps the series. */
  attach(series: ISeriesApi<SeriesType>): void {
    this.series?.detachPrimitive(this.primitive);
    this.series = series;
    series.attachPrimitive(this.primitive);
  }

  onState(fn: (s: DrawingUiState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ public commands

  async setSymbol(symbol: string): Promise<void> {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    this.drawings = [];
    this.history.clear();
    this.draft = null;
    this.drag = null;
    this.editing = null;
    this.selectedId = this.hoveredId = null;
    this.changed(false);
    await this.load(true);
  }

  /** Re-read drawings for the current symbol from the current source (after signing in or out). */
  reload(): Promise<void> {
    this.selectedId = null;
    return this.load(false);
  }

  /** `keepLocal`: keep drawings made while the load was in flight (fresh symbol only). */
  private async load(keepLocal: boolean): Promise<void> {
    const symbol = this.symbol;
    if (!symbol) return;
    const seq = ++this.loadSeq;
    try {
      const loaded = await loadDrawings(symbol);
      if (seq !== this.loadSeq || symbol !== this.symbol) return;
      const byId = new Map(loaded.map((d) => [d.id, d]));
      if (keepLocal) for (const d of this.drawings) byId.set(d.id, d);
      this.drawings = [...byId.values()];
      this.history.clear();
      this.changed(false);
    } catch (err) {
      console.warn('[drawings] load failed', err);
    }
  }

  setTool(tool: DrawingType | null): void {
    this.draft = null;
    this.tool = tool;
    if (tool) this.selectedId = null;
    this.changed(false);
  }

  setMagnet(on: boolean): void {
    this.magnet = on;
    this.emit();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.selectedId = null;
    this.changed(false);
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.mutate((ds) => ds.filter((d) => d.id !== this.selectedId));
    this.selectedId = null;
    this.changed(false);
  }

  removeAll(): void {
    if (!this.drawings.length) return;
    this.mutate(() => []);
    this.selectedId = null;
    this.changed(false);
  }

  undo(): void {
    const prev = this.history.undo(this.drawings);
    if (!prev) return;
    this.drawings = prev;
    if (!prev.some((d) => d.id === this.selectedId)) this.selectedId = null;
    this.changed(true);
  }

  redo(): void {
    const next = this.history.redo(this.drawings);
    if (!next) return;
    this.drawings = next;
    if (!next.some((d) => d.id === this.selectedId)) this.selectedId = null;
    this.changed(true);
  }

  /** Patch the selected drawing (style, lock, text). */
  updateSelected(patch: Partial<Pick<Drawing, 'style' | 'locked' | 'text'>>): void {
    const id = this.selectedId;
    if (!id) return;
    this.mutate((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d)));
  }

  editText(id: string): void {
    const d = this.drawings.find((x) => x.id === id);
    const vp = this.viewport();
    if (!d || !vp || d.type !== 'text') return;
    this.selectedId = id;
    this.editing = {
      id, x: vp.x(d.points[0]!.time), y: vp.y(d.points[0]!.price), text: d.text ?? '',
      color: d.style.color, fontSize: d.style.fontSize ?? 14,
    };
    this.changed(false);
  }

  /** Called by the inline editor. Empty text on a new label removes it. */
  commitText(id: string, text: string | null): void {
    this.editing = null;
    if (text === null) {
      this.changed(false);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      this.mutate((ds) => ds.filter((d) => d.id !== id));
      this.selectedId = null;
    } else {
      this.mutate((ds) => ds.map((d) => (d.id === id ? { ...d, text: trimmed.slice(0, 500), updatedAt: Date.now() } : d)));
    }
  }

  // ------------------------------------------------------------------ rendering (called by the primitive)

  render(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport();
    if (!vp) return;
    const list = this.draft ? [...this.drawings, this.draft.drawing] : this.drawings;
    for (const d of list) {
      if (this.hidden && d !== this.draft?.drawing) continue;
      const st = { selected: d.id === this.selectedId, hovered: d.id === this.hoveredId };
      ctx.save();
      TOOLS[d.type].draw(ctx, vp, d, st);
      ctx.restore();
      if (st.selected || (st.hovered && !this.drag) || d === this.draft?.drawing) this.drawHandles(ctx, vp, d);
    }
  }

  private drawHandles(ctx: CanvasRenderingContext2D, vp: Viewport, d: Drawing): void {
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    for (const h of TOOLS[d.type].handles(d)) {
      const x = d.type === 'hline' ? vp.width / 2 : vp.x(h.at.time);
      const y = d.type === 'vline' ? vp.height / 2 : vp.y(h.at.price);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = d.type === 'fib' || d.type === 'fibext' || d.type === 'long' || d.type === 'short' ? '#2962ff' : d.style.color;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Axis labels: always for horizontal/vertical lines, and for every point of the selected drawing. */
  axisViews(): { price: ISeriesPrimitiveAxisView[]; time: ISeriesPrimitiveAxisView[] } {
    const vp = this.viewport();
    const price: ISeriesPrimitiveAxisView[] = [];
    const time: ISeriesPrimitiveAxisView[] = [];
    if (!vp || this.hidden) return { price, time };
    const label = (coordinate: number, text: string, back: string): ISeriesPrimitiveAxisView => ({
      coordinate: () => coordinate, text: () => text, textColor: () => '#ffffff', backColor: () => back,
      visible: () => Number.isFinite(coordinate), tickVisible: () => true,
    });
    for (const d of this.drawings) {
      const p = d.points[0]!;
      if (d.type === 'hline') price.push(label(vp.y(p.price), vp.fmtPrice(p.price), d.style.color));
      if (d.type === 'vline') time.push(label(vp.x(p.time), vp.fmtTime(p.time), d.style.color));
    }
    const sel = this.drawings.find((d) => d.id === this.selectedId) ?? this.draft?.drawing;
    if (sel && sel.type !== 'hline' && sel.type !== 'vline') {
      for (const h of TOOLS[sel.type].handles(sel)) {
        price.push(label(vp.y(h.at.price), vp.fmtPrice(h.at.price), '#2962ff'));
        time.push(label(vp.x(h.at.time), vp.fmtTime(h.at.time), '#2962ff'));
      }
    }
    return { price, time };
  }

  /** Used by the primitive so the chart shows the right cursor over drawings. */
  hoverInfo(x: number, y: number): PrimitiveHoveredItem | null {
    if (this.tool || this.hidden) return null;
    const vp = this.viewport();
    const hit = vp && this.hitAt({ x, y }, vp);
    if (!hit) return null;
    const d = this.drawings.find((q) => q.id === hit.id)!;
    return {
      externalId: hit.id,
      zOrder: 'normal',
      cursorStyle: d.locked ? 'default' : hit.handle !== null ? 'pointer' : 'move',
    };
  }

  // ------------------------------------------------------------------ geometry

  private viewport(): Viewport | null {
    const series = this.series;
    const bars = this.host.bars();
    if (!series || !bars.length) return null;
    const ts = this.host.chart.timeScale();
    const idx = new TimeIndex(bars, this.host.tf());
    // logicalToCoordinate only handles whole bar indexes; anchors drawn on a lower timeframe fall
    // between bars on a higher one, so interpolate between the neighbouring bars.
    const xOfLogical = (l: number): number => {
      const f = Math.floor(l);
      const a = ts.logicalToCoordinate(f as Logical);
      if (a === null) return NaN;
      if (l === f) return a;
      const b = ts.logicalToCoordinate((f + 1) as Logical);
      return b === null ? NaN : a + (b - a) * (l - f);
    };
    return {
      width: ts.width(),
      height: this.host.chart.panes()[0]?.getHeight() ?? 0,
      x: (t) => xOfLogical(idx.logicalOf(t)),
      y: (p) => series.priceToCoordinate(p) ?? NaN,
      logical: (t) => idx.logicalOf(t),
      logicalAt: (x) => ts.coordinateToLogical(x) ?? NaN,
      timeOfLogical: (l) => idx.timeOf(l),
      priceAt: (y) => series.coordinateToPrice(y) ?? NaN,
      bars,
      fmtPrice: this.host.fmtPrice,
      fmtTime: this.host.fmtTime,
      fmtVolume: this.host.fmtVolume,
      textColor: this.host.textColor(),
    };
  }

  /** Data point under the cursor: time snaps to the nearest bar; with the magnet, price snaps to its OHLC. */
  private pointAt(p: Pt, vp: Viewport, useMagnet = this.magnet): DrawingPoint {
    const logical = Math.round(vp.logicalAt(p.x));
    let price = vp.priceAt(p.y);
    if (useMagnet && logical >= 0 && logical < vp.bars.length) {
      let best = Infinity;
      for (const c of this.host.magnetPrices(logical)) {
        const dist = Math.abs(vp.y(c) - p.y);
        if (dist < best) {
          best = dist;
          price = c;
        }
      }
    }
    return { time: vp.timeOfLogical(logical), price };
  }

  private hitAt(p: Pt, vp: Viewport): { id: string; handle: number | null } | null {
    if (this.hidden) return null;
    // Handles of the selected drawing take priority, then drawings top-most first.
    const sel = this.drawings.find((d) => d.id === this.selectedId);
    if (sel) {
      const handles = TOOLS[sel.type].handles(sel);
      for (let i = 0; i < handles.length; i++) {
        const h = handles[i]!;
        const hx = sel.type === 'hline' ? vp.width / 2 : vp.x(h.at.time);
        const hy = sel.type === 'vline' ? vp.height / 2 : vp.y(h.at.price);
        if (Math.hypot(p.x - hx, p.y - hy) <= HANDLE_RADIUS + 3) return { id: sel.id, handle: i };
      }
    }
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i]!;
      if (TOOLS[d.type].hit(vp, d, p)) return { id: d.id, handle: null };
    }
    return null;
  }

  /** Pointer position in pane coordinates, or null when outside the main pane (axes, volume pane). */
  private local(e: PointerEvent | MouseEvent): Pt | null {
    const r = this.host.container.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const w = this.host.chart.timeScale().width();
    const h = this.host.chart.panes()[0]?.getHeight() ?? 0;
    return p.x >= 0 && p.x < w && p.y >= 0 && p.y < h ? p : null;
  }

  // ------------------------------------------------------------------ input

  private readonly blockIfOwned = (e: Event) => {
    if (this.blockNative) e.stopPropagation();
  };

  private own(e: PointerEvent): void {
    e.preventDefault(); // also suppresses the compatibility mouse events Lightweight Charts listens to
    e.stopPropagation();
    this.blockNative = true;
    this.host.container.setPointerCapture(e.pointerId);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.editing) return;
    const p = this.local(e);
    const vp = p && this.viewport();
    if (!p || !vp) return;

    if (this.tool) {
      this.own(e);
      this.placePoint(this.pointAt(p, vp), p, vp);
      return;
    }

    const hit = this.hitAt(p, vp);
    if (!hit) {
      if (this.selectedId) {
        this.selectedId = null;
        this.changed(false);
      }
      return; // let the chart pan
    }
    this.own(e);
    this.selectedId = hit.id;
    const d = this.drawings.find((q) => q.id === hit.id)!;
    if (!d.locked) {
      this.drag = {
        id: d.id, handle: hit.handle, orig: d, before: this.drawings, moved: false,
        startLogical: vp.logicalAt(p.x), startPrice: vp.priceAt(p.y),
      };
    }
    this.changed(false);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const r = this.host.container.getBoundingClientRect();
    const raw = { x: e.clientX - r.left, y: e.clientY - r.top };
    const vp = this.viewport();
    if (!vp) return;

    if (this.drag) {
      this.dragTo(raw, vp);
      return;
    }
    if (this.draft) {
      const pt = this.pointAt(raw, vp);
      const pts = this.draft.drawing.points.map((q, i) => (i < this.draft!.placed ? q : pt));
      this.draft.drawing = { ...this.draft.drawing, points: pts };
      this.primitive.requestUpdate();
      return;
    }
    if (this.tool) return;
    const p = this.local(e);
    const hovered = p ? (this.hitAt(p, vp)?.id ?? null) : null;
    if (hovered !== this.hoveredId) {
      this.hoveredId = hovered;
      this.primitive.requestUpdate();
    }
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.host.container.hasPointerCapture(e.pointerId)) this.host.container.releasePointerCapture(e.pointerId);
    this.blockNative = false;

    if (this.drag) {
      const drag = this.drag;
      this.drag = null;
      if (drag.moved) {
        this.history.push(drag.before);
        this.changed(true);
      }
      return;
    }
    // Press-drag-release places the second point at the release position.
    const draft = this.draft;
    if (draft && draft.placed === 1) {
      const r = this.host.container.getBoundingClientRect();
      const up = { x: e.clientX - r.left, y: e.clientY - r.top };
      const vp = this.viewport();
      if (vp && Math.hypot(up.x - draft.down.x, up.y - draft.down.y) > DRAG_CREATE_PX) this.placePoint(this.pointAt(up, vp), up, vp);
    }
  };

  private readonly onDoubleClick = (e: MouseEvent) => {
    const p = this.local(e);
    const vp = p && this.viewport();
    const hit = p && vp && this.hitAt(p, vp);
    if (!hit) return;
    e.stopPropagation(); // don't let the chart reset its scale
    const d = this.drawings.find((q) => q.id === hit.id);
    if (d?.type === 'text' && !d.locked) this.editText(d.id);
  };

  private placePoint(pt: DrawingPoint, screenPt: Pt, vp: Viewport): void {
    const type = this.tool!;
    const def = TOOLS[type];
    if (!this.draft) {
      if (def.create) {
        this.finish(this.make(type, def.create(pt, vp)));
        return;
      }
      const n = DRAWING_POINTS[type];
      this.draft = { drawing: this.make(type, Array.from({ length: n }, () => pt)), placed: 1, down: screenPt };
      this.primitive.requestUpdate();
      return;
    }
    const draft = this.draft;
    draft.placed++;
    draft.drawing = { ...draft.drawing, points: draft.drawing.points.map((q, i) => (i >= draft.placed - 1 ? pt : q)) };
    if (draft.placed >= DRAWING_POINTS[type]) this.finish(draft.drawing);
    else this.primitive.requestUpdate();
  }

  private make(type: DrawingType, points: DrawingPoint[]): Drawing {
    return {
      id: newId(), type, points, style: { ...TOOLS[type].defaultStyle },
      ...(type === 'text' ? { text: '' } : {}), updatedAt: Date.now(),
    };
  }

  private finish(d: Drawing): void {
    this.draft = null;
    this.tool = null;
    this.history.push(this.drawings);
    this.drawings = [...this.drawings, d];
    this.selectedId = d.id;
    this.changed(true);
    if (d.type === 'text') this.editText(d.id);
  }

  private dragTo(raw: Pt, vp: Viewport): void {
    const drag = this.drag!;
    const def = TOOLS[drag.orig.type];
    let points: DrawingPoint[];
    if (drag.handle !== null) {
      points = def.handles(drag.orig)[drag.handle]!.move(drag.orig, this.pointAt(raw, vp), vp);
    } else {
      // Whole-drawing moves shift by whole bars in time and freely in price.
      const dl = Math.round(vp.logicalAt(raw.x) - drag.startLogical);
      const dp = vp.priceAt(raw.y) - drag.startPrice;
      if (!Number.isFinite(dl) || !Number.isFinite(dp)) return;
      points = drag.orig.points.map((q) => ({ time: vp.timeOfLogical(vp.logical(q.time) + dl), price: q.price + dp }));
    }
    drag.moved = true;
    this.drawings = this.drawings.map((d) => (d.id === drag.id ? { ...d, points, updatedAt: Date.now() } : d));
    this.primitive.requestUpdate();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable]') || this.editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (this.draft || this.tool) this.setTool(null);
      else if (this.selectedId) {
        this.selectedId = null;
        this.changed(false);
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
      e.preventDefault();
      if (!this.drawings.find((d) => d.id === this.selectedId)?.locked) this.deleteSelected();
      return;
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.altKey && !mod) {
      const tool = ({ KeyT: 'trendline', KeyH: 'hline', KeyV: 'vline', KeyF: 'fib', KeyR: 'rect', KeyP: 'channel', KeyM: 'measure' } as const)[e.code as 'KeyT'];
      if (tool) {
        e.preventDefault();
        this.setTool(tool);
      }
    }
  };

  // ------------------------------------------------------------------ state plumbing

  /** Apply a change as one undoable step and persist it. */
  private mutate(fn: (ds: Drawing[]) => Drawing[]): void {
    this.history.push(this.drawings);
    this.drawings = fn(this.drawings);
    this.changed(true);
  }

  private changed(persist: boolean): void {
    if (persist && this.symbol) saveDrawings(this.symbol, this.drawings);
    this.primitive.requestUpdate();
    this.emit();
  }

  private state(): DrawingUiState {
    return {
      tool: this.tool,
      magnet: this.magnet,
      hidden: this.hidden,
      selected: this.drawings.find((d) => d.id === this.selectedId) ?? null,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      count: this.drawings.length,
      editing: this.editing,
    };
  }

  private emit(): void {
    const s = this.state();
    this.listeners.forEach((fn) => fn(s));
  }
}

/** Bridges the manager into Lightweight Charts' render and hit-test pipeline. */
class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private params: SeriesAttachedParameter<Time> | null = null;
  private axis: ReturnType<DrawingManager['axisViews']> = { price: [], time: [] };
  private readonly view: IPrimitivePaneView;

  constructor(private readonly manager: DrawingManager) {
    const renderer = {
      draw: (target: CanvasRenderingTarget2D) => target.useMediaCoordinateSpace(({ context }) => manager.render(context)),
    };
    this.view = { zOrder: () => 'normal', renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.params = p;
  }

  detached(): void {
    this.params = null;
  }

  requestUpdate(): void {
    this.params?.requestUpdate();
  }

  updateAllViews(): void {
    this.axis = this.manager.axisViews();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axis.price;
  }

  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axis.time;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.manager.hoverInfo(x, y);
  }
}
