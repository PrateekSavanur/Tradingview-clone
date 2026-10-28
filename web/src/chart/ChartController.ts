import { TF_MS, type Candle, type SymbolInfo, type Timeframe } from '@chartdeck/shared';
import {
  AreaSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type MouseEventParams, type SeriesType, type Time,
} from 'lightweight-charts';
import { DrawingManager } from '../drawings/DrawingManager.ts';
import { TimeIndex } from '../drawings/geometry.ts';
import type { IndicatorInstance } from '../store/indicators.ts';
import { IndicatorLayer, type IndicatorLegendItem } from './IndicatorLayer.ts';
import { getHistory } from '../lib/api.ts';
import type { CandleEvent, Feed } from '../lib/feed.ts';
import { decimalsFor, formatBarTime, formatPrice, formatVolume } from '../lib/format.ts';
import { LatencyTracker } from '../lib/latency.ts';
import type { ChartType, Theme } from '../store/ui.ts';
import { PALETTES, type ChartPalette } from './theme.ts';
import { fromChartTime, heikinAshi, heikinAshiBar, hollowStyle, toChartTime } from './transforms.ts';

export interface LegendData {
  bar: Candle;
  prevClose: number | undefined;
  /** True when showing the latest bar rather than one under the crosshair. */
  live: boolean;
  indicators: IndicatorLegendItem[];
}

export interface ChartStatus {
  loading: boolean;
  loadingOlder: boolean;
  reachedStart: boolean;
  error: string | null;
  bars: number;
}

/** What one chart tells linked charts: the viewport as times, so it carries across timeframes. */
export interface VisibleTimes {
  from: number;
  to: number;
  tf: Timeframe;
}

/** A price an alert watches, drawn as a dashed line on the price scale. */
export interface AlertLevel {
  price: number;
  title: string;
}

const PAGE = 500;
const SCROLLBACK_TRIGGER_BARS = 30;
const MAX_BACKFILL_PAGES = 6;

/**
 * Imperative owner of one chart. React mounts it and forwards symbol / timeframe / type /
 * theme changes; everything on the hot path (live candles, scroll-back) stays out of React.
 */
export class ChartController {
  private readonly chart: IChartApi;
  private main!: ISeriesApi<SeriesType>;
  private readonly volume: ISeriesApi<'Histogram'>;
  /** Raw candles, ascending by open time (ms). Source of truth for every chart type. */
  private bars: Candle[] = [];
  /** Heikin Ashi bars parallel to `bars`, maintained only for that chart type. */
  private ha: Candle[] = [];
  private symbol: SymbolInfo | null = null;
  private tf: Timeframe = '1m';
  private chartType: ChartType;
  private palette: ChartPalette;
  /** Bumped on every symbol/timeframe change so late async results are discarded. */
  private session = 0;
  private unsubscribe: (() => void) | null = null;
  private queued: CandleEvent[] = [];
  private epoch: number | null = null;
  private lastEt = 0;
  private crosshairTime: number | null = null;
  private legendRaf = 0;
  private readonly legendListeners = new Set<(d: LegendData | null) => void>();
  private readonly statusListeners = new Set<(s: ChartStatus) => void>();
  private retryTimer: number | undefined;
  private readonly offReconnect: () => void;
  /** Pointer is over this chart: its crosshair and scrolling drive linked charts, not the reverse. */
  private pointerInside = false;
  private readonly crosshairSyncListeners = new Set<(time: number | null) => void>();
  private readonly rangeSyncListeners = new Set<(r: VisibleTimes) => void>();
  private alertLevels: AlertLevel[] = [];
  private alertLines: IPriceLine[] = [];

  readonly latency = new LatencyTracker();
  readonly drawings: DrawingManager;
  readonly indicators: IndicatorLayer;
  status: ChartStatus = { loading: false, loadingOlder: false, reachedStart: false, error: null, bars: 0 };

  constructor(container: HTMLElement, private readonly feed: Feed, opts: { chartType: ChartType; theme: Theme }) {
    this.chartType = opts.chartType;
    this.palette = PALETTES[opts.theme];
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: this.palette.bg },
        textColor: this.palette.text,
        fontSize: 12,
        attributionLogo: false, // attribution is a text link in the app footer instead (see NOTICE)
        panes: { separatorColor: this.palette.border, separatorHoverColor: this.palette.border, enableResize: true },
      },
      grid: { vertLines: { color: this.palette.grid }, horzLines: { color: this.palette.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: this.palette.border },
      timeScale: { borderColor: this.palette.border, rightOffset: 8, barSpacing: 7, timeVisible: true },
      localization: { locale: navigator.language },
    });
    this.main = this.createMainSeries();
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: true,
    }, 1);
    this.chart.panes()[0]?.setStretchFactor(4);
    this.chart.panes()[1]?.setStretchFactor(1);

    this.drawings = new DrawingManager({
      chart: this.chart,
      container,
      bars: () => this.bars,
      magnetPrices: (i) => {
        if (i >= this.bars.length) return [];
        const b = this.displayBar(i);
        return this.chartType === 'line' || this.chartType === 'area' ? [b.close] : [b.open, b.high, b.low, b.close];
      },
      tf: () => this.tf,
      fmtPrice: (p) => formatPrice(p, decimalsFor(this.symbol?.tickSize ?? 0.01)),
      fmtTime: (t) => formatBarTime(t, this.tf),
      fmtVolume: formatVolume,
      textColor: () => this.palette.text,
    });
    this.drawings.attach(this.main);
    this.indicators = new IndicatorLayer(this.chart, this.main, () => this.tf);

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRangeChange);
    this.chart.subscribeCrosshairMove(this.onCrosshair);
    this.offReconnect = feed.onReconnect(() => void this.backfill('reconnect'));
    container.addEventListener('pointerenter', this.onPointerEnter);
    container.addEventListener('pointerleave', this.onPointerLeave);
  }

  destroy(): void {
    this.session++;
    this.unsubscribe?.();
    this.offReconnect();
    window.clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.legendRaf);
    const c = this.chart.chartElement().parentElement;
    c?.removeEventListener('pointerenter', this.onPointerEnter);
    c?.removeEventListener('pointerleave', this.onPointerLeave);
    this.drawings.destroy();
    this.chart.remove();
  }

  /** The active chart in a multi-chart layout takes keyboard shortcuts and the drawing toolbar. */
  setActive(active: boolean): void {
    this.drawings.setActive(active);
  }

  /** Close of the latest bar and the latest value of every indicator plot (by instance uid). */
  currentValues(): { close: number | null; indicators: Map<string, Record<string, number | null>> } {
    return { close: this.bars[this.bars.length - 1]?.close ?? null, indicators: this.indicators.latest() };
  }

  setAlertLevels(levels: AlertLevel[]): void {
    this.alertLevels = levels;
    this.drawAlertLines();
  }

  /** Price lines belong to the main series, so they are redrawn whenever that series is replaced. */
  private drawAlertLines(): void {
    for (const l of this.alertLines) this.main.removePriceLine(l);
    this.alertLines = this.alertLevels.map((a) =>
      this.main.createPriceLine({
        price: a.price, color: '#ff9800', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: a.title,
      }),
    );
  }

  setLogScale(on: boolean): void {
    this.main.priceScale().applyOptions({ mode: on ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }

  onLegend(fn: (d: LegendData | null) => void): () => void {
    this.legendListeners.add(fn);
    fn(this.legendFor(null));
    return () => this.legendListeners.delete(fn);
  }

  onStatus(fn: (s: ChartStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  setSymbol(symbol: SymbolInfo, tf: Timeframe): void {
    if (this.symbol?.id === symbol.id && this.tf === tf) return;
    // Drawings are per symbol and shared by every timeframe.
    if (this.symbol?.id !== symbol.id) void this.drawings.setSymbol(symbol.id);
    const tfChanged = this.tf !== tf;
    this.symbol = symbol;
    this.tf = tf;
    if (tfChanged) this.indicators.onTimeframeChange();
    const precision = decimalsFor(symbol.tickSize);
    this.main.applyOptions({ priceFormat: { type: 'price', precision, minMove: symbol.tickSize } });
    this.chart.applyOptions({ timeScale: { timeVisible: TF_MS[tf] < TF_MS['1D'], secondsVisible: tf === '1s' } });
    void this.load();
  }

  setChartType(type: ChartType): void {
    if (type === this.chartType) return;
    this.chartType = type;
    const old = this.main;
    // Add before removing: an emptied pane is deleted, which would promote the volume pane to index 0.
    this.main = this.createMainSeries();
    this.main.applyOptions({ priceFormat: old.options().priceFormat });
    this.main.priceScale().applyOptions({ mode: old.priceScale().options().mode });
    this.drawings.attach(this.main);
    this.indicators.setMain(this.main);
    this.alertLines = []; // they go with the old series
    this.chart.removeSeries(old);
    this.drawAlertLines();
    this.renderAll();
  }

  setIndicators(list: IndicatorInstance[]): void {
    this.indicators.sync(list);
    this.scheduleLegend();
  }

  /** Top edge of a pane in chart-container pixels (panes are separated by 1px). */
  paneTop(index: number): number {
    const panes = this.chart.panes();
    let y = 0;
    for (let j = 0; j < index && j < panes.length; j++) y += panes[j]!.getHeight() + 1;
    return y;
  }

  setTheme(theme: Theme): void {
    const p = (this.palette = PALETTES[theme]);
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text, panes: { separatorColor: p.border, separatorHoverColor: p.border } },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border },
    });
    this.main.applyOptions(this.seriesStyle());
    this.renderAll();
  }

  // ---------------------------------------------------------------- linked charts

  /** Crosshair moves made by the user on this chart, as a bar open time (ms), null when it leaves. */
  onCrosshairSync(fn: (time: number | null) => void): () => void {
    this.crosshairSyncListeners.add(fn);
    return () => this.crosshairSyncListeners.delete(fn);
  }

  /** Scrolling and zooming done by the user on this chart. */
  onRangeSync(fn: (r: VisibleTimes) => void): () => void {
    this.rangeSyncListeners.add(fn);
    return () => this.rangeSyncListeners.delete(fn);
  }

  /** Mirror another chart's crosshair onto the bar containing `time`, at that bar's close. */
  showCrosshair(time: number | null): void {
    const n = this.bars.length;
    if (time === null || !n || this.pointerInside) {
      if (!this.pointerInside) this.chart.clearCrosshairPosition();
      return;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bars[mid]!.time <= time) lo = mid;
      else hi = mid - 1;
    }
    const step = TF_MS[this.tf]; // an upper bound for 1M, which is fine here
    if (this.bars[lo]!.time > time || time >= this.bars[n - 1]!.time + step) {
      this.chart.clearCrosshairPosition();
      return;
    }
    this.chart.setCrosshairPosition(this.displayBar(lo).close, toChartTime(this.bars[lo]!.time, this.tf), this.main);
  }

  /**
   * Follow another chart's scrolling. On the same timeframe the whole range is matched (zoom too);
   * across timeframes only the right edge is, keeping this chart's own bar spacing.
   */
  showTimes(r: VisibleTimes): void {
    if (this.pointerInside || this.status.loading || !this.bars.length) return;
    const idx = new TimeIndex(this.bars, this.tf);
    const ts = this.chart.timeScale();
    const to = idx.logicalOf(r.to);
    if (r.tf === this.tf) {
      ts.setVisibleLogicalRange({ from: idx.logicalOf(r.from), to });
      return;
    }
    const cur = ts.getVisibleLogicalRange();
    if (!cur) return;
    ts.setVisibleLogicalRange({ from: to - (cur.to - cur.from), to });
  }

  private readonly onPointerEnter = () => {
    this.pointerInside = true;
  };

  private readonly onPointerLeave = () => {
    this.pointerInside = false;
    this.crosshairSyncListeners.forEach((fn) => fn(null));
  };

  // ---------------------------------------------------------------- loading

  private async load(): Promise<void> {
    const session = ++this.session;
    const { symbol, tf } = this;
    if (!symbol) return;
    window.clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    this.bars = [];
    this.ha = [];
    this.queued = [];
    this.epoch = null;
    this.lastEt = 0;
    this.latency.reset();
    this.renderAll();
    this.setStatus({ loading: true, loadingOlder: false, reachedStart: false, error: null });

    // Subscribe before fetching history so no live update is lost in between; they queue until history lands.
    this.unsubscribe = this.feed.subscribe(symbol.id, tf, (e) => this.onLive(e, session));
    try {
      const hist = await getHistory(symbol.id, tf, { limit: PAGE });
      if (session !== this.session) return;
      this.bars = hist;
      for (const e of this.queued) this.mergeCandle(e.candle);
      this.queued = [];
      this.renderAll();
      this.chart.timeScale().scrollToRealTime();
      this.setStatus({ loading: false, reachedStart: hist.length < PAGE });
    } catch (err) {
      if (session !== this.session) return;
      this.setStatus({ loading: false, error: `History failed: ${(err as Error).message}. Retrying…` });
      this.retryTimer = window.setTimeout(() => {
        if (session === this.session) void this.load();
      }, 3000);
    }
  }

  private readonly onRangeChange = (range: LogicalRange | null) => {
    if (range && range.from < SCROLLBACK_TRIGGER_BARS) void this.loadOlder();
    if (range && this.pointerInside && this.rangeSyncListeners.size && this.bars.length && !this.status.loading) {
      const idx = new TimeIndex(this.bars, this.tf);
      const r = { from: idx.timeOf(range.from), to: idx.timeOf(range.to), tf: this.tf };
      this.rangeSyncListeners.forEach((fn) => fn(r));
    }
  };

  private async loadOlder(): Promise<void> {
    const s = this.status;
    if (s.loading || s.loadingOlder || s.reachedStart || !this.bars.length || !this.symbol) return;
    const session = this.session;
    this.setStatus({ loadingOlder: true });
    try {
      const older = (await getHistory(this.symbol.id, this.tf, { to: this.bars[0]!.time, limit: PAGE }))
        .filter((c) => c.time < this.bars[0]!.time);
      if (session !== this.session) return;
      if (older.length) {
        const range = this.chart.timeScale().getVisibleLogicalRange();
        this.bars = older.concat(this.bars);
        this.renderAll();
        // Prepending shifts logical indexes; keep the viewport where the user left it.
        if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
      }
      this.setStatus({ loadingOlder: false, reachedStart: older.length < PAGE - 1 });
    } catch (err) {
      if (session !== this.session) return;
      this.setStatus({ loadingOlder: false, error: `Could not load older bars: ${(err as Error).message}` });
    }
  }

  /**
   * Fill holes left by a dropped connection or an upstream reconnect: page backwards from now
   * until we overlap what we already had, then merge (fetched closed candles win).
   */
  private async backfill(reason: string): Promise<void> {
    if (!this.symbol || this.status.loading || !this.bars.length) return;
    const session = this.session;
    const known = this.bars[this.bars.length - 1]!.time;
    const fetched: Candle[] = [];
    try {
      let to: number | undefined;
      for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
        const chunk = await getHistory(this.symbol.id, this.tf, { to, limit: 1000 });
        if (session !== this.session) return;
        fetched.unshift(...chunk);
        if (!chunk.length || chunk[0]!.time <= known) break;
        to = chunk[0]!.time;
      }
    } catch (err) {
      console.warn('[chart] backfill failed', err);
      return;
    }
    if (!fetched.length) return;
    const byTime = new Map(this.bars.map((b) => [b.time, b]));
    const liveLast = this.bars[this.bars.length - 1]!;
    for (const c of fetched) byTime.set(c.time, c);
    // The streamed open candle is at least as fresh as the REST snapshot.
    if (liveLast.time >= fetched[fetched.length - 1]!.time) byTime.set(liveLast.time, liveLast);
    const before = this.bars.length;
    this.bars = [...byTime.values()].sort((a, b) => a.time - b.time);
    console.info(`[chart] backfill (${reason}): ${this.bars.length - before} bars added`);
    this.renderAll();
  }

  // ---------------------------------------------------------------- live

  private onLive(e: CandleEvent, session: number): void {
    if (session !== this.session) return;
    if (this.epoch !== null && e.epoch !== this.epoch) void this.backfill('upstream restarted');
    this.epoch = e.epoch;
    if (this.status.loading) {
      this.queued.push(e);
      return;
    }
    const idx = this.mergeCandle(e.candle);
    if (idx < 0) return;
    if (idx === this.bars.length - 1) this.updateLast();
    else this.renderAll();

    // Only frames that carry a new trade measure latency; roll-overs reuse the old trade stamp.
    // Hidden tabs are skipped: the browser pauses rAF there, which would read as render latency.
    // The first frame of a subscription is a snapshot (hot cache or post-seed), not a live tick.
    if (this.lastEt === 0) {
      this.lastEt = e.lat.et || -1;
    } else if (e.lat.et && e.lat.et !== this.lastEt && !document.hidden) {
      this.lastEt = e.lat.et;
      // Lightweight Charts paints in its own rAF scheduled by update(); ours runs right after it.
      requestAnimationFrame(() => this.latency.record(e.lat, e.receivedAt, Date.now(), this.feed.offset));
    }
    this.scheduleLegend();
  }

  /** Insert or replace by time. Returns the index written, or -1 if ignored. */
  private mergeCandle(c: Candle): number {
    const n = this.bars.length;
    const last = this.bars[n - 1];
    if (!last || c.time > last.time) {
      this.bars.push(c);
      return n;
    }
    if (c.time === last.time) {
      this.bars[n - 1] = c;
      return n - 1;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.bars[mid]!.time;
      if (t === c.time) {
        this.bars[mid] = c;
        return mid;
      }
      if (t < c.time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1; // older than anything loaded and not adjacent; history covers it
  }

  // ---------------------------------------------------------------- rendering

  private createMainSeries(): ISeriesApi<SeriesType> {
    const style = this.seriesStyle();
    switch (this.chartType) {
      case 'bars':
        return this.chart.addSeries(BarSeries, style, 0);
      case 'line':
        return this.chart.addSeries(LineSeries, style, 0);
      case 'area':
        return this.chart.addSeries(AreaSeries, style, 0);
      default:
        return this.chart.addSeries(CandlestickSeries, style, 0);
    }
  }

  private seriesStyle(): Record<string, unknown> {
    const p = this.palette;
    switch (this.chartType) {
      case 'bars':
        return { upColor: p.up, downColor: p.down, thinBars: false };
      case 'line':
        return { color: p.line, lineWidth: 2 };
      case 'area':
        return { lineColor: p.line, topColor: p.areaTop, bottomColor: p.areaBottom, lineWidth: 2 };
      case 'hollow':
        return { upColor: 'rgba(0,0,0,0)', downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down };
      default:
        return { upColor: p.up, downColor: p.down, borderVisible: false, wickUpColor: p.up, wickDownColor: p.down };
    }
  }

  /** The bar as displayed (Heikin Ashi or raw). */
  private displayBar(i: number): Candle {
    if (this.chartType !== 'heikin') return this.bars[i]!;
    if (this.ha.length !== this.bars.length) this.ha = heikinAshi(this.bars);
    return this.ha[i]!;
  }

  private point(i: number): Record<string, unknown> & { time: Time } {
    const c = this.bars[i]!;
    const time = toChartTime(c.time, this.tf);
    switch (this.chartType) {
      case 'line':
      case 'area':
        return { time, value: c.close };
      case 'hollow':
        return { time, open: c.open, high: c.high, low: c.low, close: c.close, ...hollowStyle(c, this.bars[i - 1]?.close, this.palette.up, this.palette.down) };
      case 'heikin': {
        const h = this.ha[i]!;
        return { time, open: h.open, high: h.high, low: h.low, close: h.close };
      }
      default:
        return { time, open: c.open, high: c.high, low: c.low, close: c.close };
    }
  }

  private volumePoint(i: number) {
    const c = this.bars[i]!;
    return { time: toChartTime(c.time, this.tf), value: c.volume, color: c.close >= c.open ? this.palette.upVolume : this.palette.downVolume };
  }

  private renderAll(): void {
    if (this.chartType === 'heikin') this.ha = heikinAshi(this.bars);
    const n = this.bars.length;
    const main = new Array(n);
    const vol = new Array(n);
    for (let i = 0; i < n; i++) {
      main[i] = this.point(i);
      vol[i] = this.volumePoint(i);
    }
    this.main.setData(main);
    this.volume.setData(vol);
    this.indicators.recompute(this.bars);
    this.setStatus({ bars: n });
    this.scheduleLegend();
  }

  private updateLast(): void {
    const i = this.bars.length - 1;
    if (this.chartType === 'heikin') {
      this.ha.length = i;
      this.ha[i] = heikinAshiBar(this.bars[i]!, this.ha[i - 1]);
    }
    this.main.update(this.point(i) as never);
    this.volume.update(this.volumePoint(i));
    this.indicators.update(this.bars);
    if (this.status.bars !== this.bars.length) this.setStatus({ bars: this.bars.length });
  }

  // ---------------------------------------------------------------- legend

  private readonly onCrosshair = (param: MouseEventParams) => {
    this.crosshairTime = param.time === undefined || !param.point ? null : fromChartTime(param.time as number, this.tf);
    this.scheduleLegend();
    // Moves we made with setCrosshairPosition carry no source event; only echo the user's own.
    if (param.sourceEvent && this.pointerInside) this.crosshairSyncListeners.forEach((fn) => fn(this.crosshairTime));
  };

  private scheduleLegend(): void {
    if (this.legendRaf || !this.legendListeners.size) return;
    this.legendRaf = requestAnimationFrame(() => {
      this.legendRaf = 0;
      const d = this.legendFor(this.crosshairTime);
      this.legendListeners.forEach((fn) => fn(d));
    });
  }

  private legendFor(time: number | null): LegendData | null {
    const n = this.bars.length;
    if (!n) return null;
    let i = n - 1;
    if (time !== null) {
      i = this.indexOf(time);
      if (i < 0) i = n - 1;
    }
    if (this.chartType === 'heikin' && this.ha.length !== n) this.ha = heikinAshi(this.bars);
    return {
      bar: this.displayBar(i), prevClose: i > 0 ? this.displayBar(i - 1).close : undefined, live: i === n - 1 && time === null,
      indicators: this.indicators.legendAt(i),
    };
  }

  private indexOf(time: number): number {
    let lo = 0;
    let hi = this.bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.bars[mid]!.time;
      if (t === time) return mid;
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private setStatus(patch: Partial<ChartStatus>): void {
    this.status = { ...this.status, ...patch };
    this.statusListeners.forEach((fn) => fn(this.status));
  }
}
