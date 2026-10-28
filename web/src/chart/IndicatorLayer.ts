import { INDICATOR_BY_ID, Runner, sanitizeInputs, volumeProfile, type IndicatorMeta, type Output, type PlotDef } from '@chartdeck/indicators';
import { nextBucket, type Candle, type Timeframe } from '@chartdeck/shared';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  HistogramSeries, LineSeries, LineStyle, LineType,
  type IChartApi, type IPriceLine, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type Logical,
  type SeriesAttachedParameter, type SeriesType, type Time,
} from 'lightweight-charts';
import type { IndicatorInstance } from '../store/indicators.ts';
import { toChartTime } from './transforms.ts';

interface Live {
  inst: IndicatorInstance;
  meta: IndicatorMeta;
  runner: Runner | null;
  outputs: Output[];
  series: Map<string, ISeriesApi<SeriesType>>;
  offsets: Map<string, number>;
  lines: IPriceLine[];
  primitive: IndicatorPrimitive | null;
  /** Series the primitive is attached to. */
  host: ISeriesApi<SeriesType> | null;
}

export interface IndicatorLegendItem {
  uid: string;
  title: string;
  hidden: boolean;
  values: Array<{ label: string; value: number | null; color: string }>;
  /** Pane index; 0 = main chart. */
  pane: number;
}

const SIGNED_COLORS = { upRising: '#26a69a', upFalling: '#b2dfdb', downFalling: '#ff5252', downRising: '#ffcdd2' };

/** Turns indicator instances into series, panes, levels and fills on one chart. */
export class IndicatorLayer {
  private readonly live = new Map<string, Live>();
  private bars: readonly Candle[] = [];
  private futureTimes: number[] = [];
  /** Bar count the futureTimes cache was built from. */
  private futureBase = 0;

  constructor(
    private readonly chart: IChartApi,
    private main: ISeriesApi<SeriesType>,
    private readonly tf: () => Timeframe,
  ) {}

  /** Reconcile with the desired instance list (added, removed, re-configured, re-styled). */
  sync(instances: IndicatorInstance[]): void {
    const wanted = new Set(instances.map((i) => i.uid));
    for (const [uid, l] of this.live) if (!wanted.has(uid)) this.destroy(l);
    for (const inst of instances) {
      const meta = INDICATOR_BY_ID.get(inst.type);
      if (!meta) continue;
      const cur = this.live.get(inst.uid);
      if (!cur) {
        const l = this.create(inst, meta);
        this.live.set(inst.uid, l);
        this.recomputeOne(l);
        continue;
      }
      // Re-configure in place so the indicator keeps its pane and position.
      const inputsChanged = JSON.stringify(cur.inst.inputs) !== JSON.stringify(inst.inputs);
      const shown = cur.inst.hidden && !inst.hidden;
      cur.inst = inst;
      if (inputsChanged) this.configure(cur);
      this.applyStyles(cur);
      if (inputsChanged || shown) this.recomputeOne(cur);
    }
  }

  /** Indicators that depend on the timeframe (pivots) need fresh runners after it changes. */
  onTimeframeChange(): void {
    for (const l of this.live.values()) this.configure(l);
  }

  /** Main series was replaced (chart type change): move attachments that live on it. */
  setMain(main: ISeriesApi<SeriesType>): void {
    this.main = main;
    for (const l of this.live.values()) {
      if (l.host && l.meta.pane === 'overlay' && l.primitive) {
        l.host.detachPrimitive(l.primitive);
        l.host = this.hostFor(l);
        l.host.attachPrimitive(l.primitive);
      }
    }
  }

  /** Full computation, used when history changes (load, scroll-back, backfill, timeframe). */
  recompute(bars: readonly Candle[]): void {
    this.bars = bars;
    for (const l of this.live.values()) this.recomputeOne(l);
  }

  /** Incremental step for the newest bar (new or revised). One step per indicator, no recompute. */
  update(bars: readonly Candle[]): void {
    this.bars = bars;
    const i = bars.length - 1;
    const bar = bars[i];
    if (!bar) return;
    for (const l of this.live.values()) {
      if (!l.runner || l.inst.hidden) {
        l.primitive?.requestUpdate();
        continue;
      }
      const out = l.runner.update(bar);
      if (!out) continue;
      l.outputs[i] = out;
      for (const p of l.meta.plots) this.pushPoint(l, p, i, out, true);
      l.primitive?.requestUpdate();
    }
  }

  legendAt(index: number): IndicatorLegendItem[] {
    const items: IndicatorLegendItem[] = [];
    for (const l of this.live.values()) {
      const out = l.outputs[Math.min(index, l.outputs.length - 1)];
      const firstSeries = l.series.values().next().value as ISeriesApi<SeriesType> | undefined;
      items.push({
        uid: l.inst.uid,
        title: title(l.meta, l.inst),
        hidden: l.inst.hidden,
        pane: l.meta.pane === 'overlay' ? 0 : (firstSeries?.getPane().paneIndex() ?? 0),
        values: l.meta.plots
          .filter((p) => l.inst.plots[p.key]?.visible !== false)
          .map((p) => ({ label: p.label, value: out?.[p.key] ?? null, color: l.inst.plots[p.key]?.color ?? p.color })),
      });
    }
    return items;
  }

  /** Latest output of every instance, by uid (the open bar's values). */
  latest(): Map<string, Output> {
    const m = new Map<string, Output>();
    for (const [uid, l] of this.live) {
      const out = l.outputs[l.outputs.length - 1];
      if (out) m.set(uid, out);
    }
    return m;
  }

  destroyAll(): void {
    for (const l of this.live.values()) this.destroy(l);
  }

  // ---------------------------------------------------------------- internals

  /** (Re)build the runner and plot offsets from the instance's inputs. */
  private configure(l: Live): void {
    const inputs = sanitizeInputs(l.meta, l.inst.inputs);
    l.runner = l.meta.create ? new Runner(l.meta.create(inputs, { tf: this.tf() })) : null;
    for (const p of l.meta.plots) l.offsets.set(p.key, p.offset?.(inputs) ?? 0);
  }

  private create(inst: IndicatorInstance, meta: IndicatorMeta): Live {
    const l: Live = { inst, meta, outputs: [], series: new Map(), offsets: new Map(), lines: [], primitive: null, host: null, runner: null };
    this.configure(l);

    let paneIndex = meta.pane === 'overlay' ? 0 : this.chart.panes().length;
    for (const p of meta.plots) {
      const s = this.addSeries(p, paneIndex);
      l.series.set(p.key, s);
      paneIndex = s.getPane().paneIndex();
    }
    if (meta.pane === 'separate') {
      this.chart.panes()[paneIndex]?.setStretchFactor(1.3);
      const first = l.series.values().next().value as ISeriesApi<SeriesType> | undefined;
      for (const lv of meta.levels ?? []) {
        l.lines.push(first!.createPriceLine({
          price: lv.value, color: lv.color ?? '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '',
        }));
      }
    }
    if (meta.fills?.length || meta.levelFill || meta.special) {
      l.primitive = new IndicatorPrimitive(this, l);
      l.host = this.hostFor(l);
      l.host.attachPrimitive(l.primitive);
    }
    this.applyStyles(l);
    return l;
  }

  private hostFor(l: Live): ISeriesApi<SeriesType> {
    return l.meta.pane === 'overlay' ? this.main : (l.series.values().next().value as ISeriesApi<SeriesType>);
  }

  private addSeries(p: PlotDef, pane: number): ISeriesApi<SeriesType> {
    const common = { priceLineVisible: false, lastValueVisible: p.kind !== 'steps', crosshairMarkerVisible: false };
    switch (p.kind) {
      case 'histogram':
      case 'columns-signed':
        return this.chart.addSeries(HistogramSeries, { ...common, color: p.color, base: 0 }, pane);
      case 'dots':
        return this.chart.addSeries(LineSeries, { ...common, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }, pane);
      case 'steps':
        return this.chart.addSeries(LineSeries, { ...common, lineType: LineType.WithSteps }, pane);
      default:
        return this.chart.addSeries(LineSeries, common, pane);
    }
  }

  private applyStyles(l: Live): void {
    for (const p of l.meta.plots) {
      const s = l.series.get(p.key);
      if (!s) continue;
      const st = l.inst.plots[p.key];
      const color = st?.color ?? p.color;
      const visible = !l.inst.hidden && (st?.visible ?? !p.hidden);
      if (p.kind === 'histogram') s.applyOptions({ color, visible });
      else if (p.kind === 'columns-signed') s.applyOptions({ visible });
      else s.applyOptions({ color, lineWidth: (st?.width ?? p.width ?? 2) as 1, visible, ...(p.kind === 'dots' ? { pointMarkersRadius: (st?.width ?? p.width ?? 2) * 0.8 } : {}) });
    }
    l.primitive?.requestUpdate();
  }

  private recomputeOne(l: Live): void {
    l.outputs = l.runner && !l.inst.hidden ? l.runner.compute(this.bars) : [];
    for (const p of l.meta.plots) {
      const s = l.series.get(p.key);
      if (!s) continue;
      const data = [];
      for (let i = 0; i < l.outputs.length; i++) {
        const pt = this.point(l, p, i, l.outputs[i]!);
        if (pt) data.push(pt);
      }
      s.setData(data as never);
    }
    l.primitive?.requestUpdate();
  }

  private pushPoint(l: Live, p: PlotDef, i: number, out: Output, live: boolean): void {
    const s = l.series.get(p.key);
    const pt = s && this.point(l, p, i, out);
    if (!s || !pt) return;
    // Negative offsets (lagging span) rewrite a point that is no longer the series' last.
    s.update(pt as never, live && (l.offsets.get(p.key) ?? 0) < 0);
  }

  private point(l: Live, p: PlotDef, i: number, out: Output): Record<string, unknown> | null {
    const idx = i + (l.offsets.get(p.key) ?? 0);
    if (idx < 0) return null;
    const ms = this.timeAt(idx);
    if (ms === null) return null;
    const time = toChartTime(ms, this.tf());
    const v = out[p.key];
    if (v === null || v === undefined || !Number.isFinite(v)) return { time };
    if (p.kind === 'columns-signed') {
      const prev = l.outputs[i - 1]?.[p.key] ?? null;
      const rising = prev === null || v >= prev;
      const color = v >= 0 ? (rising ? SIGNED_COLORS.upRising : SIGNED_COLORS.upFalling) : rising ? SIGNED_COLORS.downRising : SIGNED_COLORS.downFalling;
      return { time, value: v, color };
    }
    return { time, value: v };
  }

  /** Bar time for an index, continuing past the last bar for forward-shifted plots. */
  timeAt(idx: number): number | null {
    const n = this.bars.length;
    if (idx < n) return this.bars[idx]?.time ?? null;
    if (!n) return null;
    if (this.futureBase !== n) {
      this.futureTimes = [];
      this.futureBase = n;
    }
    const tf = this.tf();
    while (this.futureTimes.length < idx - n + 1) {
      const prev = this.futureTimes.length ? this.futureTimes[this.futureTimes.length - 1]! : this.bars[n - 1]!.time;
      this.futureTimes.push(nextBucket(tf, prev));
    }
    return this.futureTimes[idx - n]!;
  }

  private destroy(l: Live): void {
    if (l.primitive && l.host) l.host.detachPrimitive(l.primitive);
    for (const s of l.series.values()) this.chart.removeSeries(s);
    this.live.delete(l.inst.uid);
  }

  // Exposed to the primitive.
  get chartApi(): IChartApi {
    return this.chart;
  }

  get currentBars(): readonly Candle[] {
    return this.bars;
  }
}

export function title(meta: IndicatorMeta, inst: IndicatorInstance): string {
  const args = meta.inputs.map((i) => inst.inputs[i.key] ?? i.default).join(', ');
  return args ? `${meta.short} ${args}` : meta.short;
}

/** Canvas work Lightweight Charts can't express: fills between plots, level bands, volume profile. */
class IndicatorPrimitive implements ISeriesPrimitive<Time> {
  private params: SeriesAttachedParameter<Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(
    private readonly layer: IndicatorLayer,
    private readonly l: Live,
  ) {
    const renderer = (bg: boolean) => ({
      draw: (target: CanvasRenderingTarget2D) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize.width, mediaSize.height, bg)),
    });
    const back = renderer(true);
    const front = renderer(false);
    this.views = [
      { zOrder: () => 'bottom', renderer: () => back },
      { zOrder: () => 'normal', renderer: () => front },
    ];
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

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(ctx: CanvasRenderingContext2D, width: number, height: number, background: boolean): void {
    const { l } = this;
    if (l.inst.hidden || !this.params) return;
    const ts = this.layer.chartApi.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;

    if (background && l.meta.levelFill) {
      const s = l.series.values().next().value as ISeriesApi<SeriesType> | undefined;
      const y1 = s?.priceToCoordinate(l.meta.levelFill.from);
      const y2 = s?.priceToCoordinate(l.meta.levelFill.to);
      if (y1 != null && y2 != null) {
        ctx.fillStyle = l.meta.levelFill.color;
        ctx.fillRect(0, Math.min(y1, y2), width, Math.abs(y2 - y1));
      }
    }

    if (background) {
      for (const f of l.meta.fills ?? []) {
        const a = l.series.get(f.from);
        const b = l.series.get(f.to);
        if (!a || !b || l.inst.plots[f.from]?.visible === false) continue;
        const offA = l.offsets.get(f.from) ?? 0;
        const offB = l.offsets.get(f.to) ?? 0;
        const from = Math.max(0, Math.floor(range.from) - 1 - Math.max(offA, offB));
        const to = Math.min(l.outputs.length - 1, Math.ceil(range.to) + 1);
        let prev: { x: number; ya: number; yb: number; above: boolean } | null = null;
        for (let i = from; i <= to; i++) {
          // Both plots share an offset in every catalog fill, so index i maps to one x.
          const va = l.outputs[i]?.[f.from];
          const vb = l.outputs[i]?.[f.to];
          const x = ts.logicalToCoordinate((i + offA) as Logical);
          const ya = va == null ? null : a.priceToCoordinate(va);
          const yb = vb == null ? null : b.priceToCoordinate(vb);
          if (x === null || ya === null || yb === null) {
            prev = null;
            continue;
          }
          const cur = { x, ya, yb, above: (va as number) >= (vb as number) };
          if (prev) {
            ctx.fillStyle = prev.above || !f.colorBelow ? f.color : f.colorBelow;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.ya);
            ctx.lineTo(cur.x, cur.ya);
            ctx.lineTo(cur.x, cur.yb);
            ctx.lineTo(prev.x, prev.yb);
            ctx.closePath();
            ctx.fill();
          }
          prev = cur;
        }
      }
    }

    if (!background && l.meta.special === 'volume-profile') this.drawProfile(ctx, width, height, range.from, range.to);
  }

  private drawProfile(ctx: CanvasRenderingContext2D, width: number, _height: number, from: number, to: number): void {
    const bars = this.layer.currentBars;
    const a = Math.max(0, Math.ceil(from));
    const b = Math.min(bars.length - 1, Math.floor(to));
    if (b < a) return;
    const rows = Number(this.l.inst.inputs.rows ?? 24);
    const va = Number(this.l.inst.inputs.valueArea ?? 70) / 100;
    const vp = volumeProfile(bars.slice(a, b + 1), Math.max(4, Math.min(200, rows)), va);
    const series = this.params?.series;
    if (!vp || !series) return;
    const maxW = width * 0.28;
    vp.rows.forEach((r, i) => {
      const y1 = series.priceToCoordinate(r.high);
      const y2 = series.priceToCoordinate(r.low);
      if (y1 === null || y2 === null) return;
      const h = Math.max(1, Math.abs(y2 - y1) - 1);
      const inVa = i >= vp.vaLow && i <= vp.vaHigh;
      const wUp = (r.up / vp.maxVolume) * maxW;
      const wDown = (r.down / vp.maxVolume) * maxW;
      const y = Math.min(y1, y2);
      ctx.fillStyle = inVa ? 'rgba(8, 153, 129, 0.45)' : 'rgba(8, 153, 129, 0.18)';
      ctx.fillRect(width - wUp - wDown, y, wUp, h);
      ctx.fillStyle = inVa ? 'rgba(242, 54, 69, 0.45)' : 'rgba(242, 54, 69, 0.18)';
      ctx.fillRect(width - wDown, y, wDown, h);
    });
    const poc = vp.rows[vp.poc]!;
    const yPoc = series.priceToCoordinate((poc.low + poc.high) / 2);
    if (yPoc !== null) {
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yPoc);
      ctx.lineTo(width, yPoc);
      ctx.stroke();
    }
  }
}
