import type { Candle, Drawing, DrawingPoint, DrawingStyle, DrawingType } from '@chartdeck/shared';
import { distToSegment, extendRay, pointInPolygon, type Pt } from './geometry.ts';

/** Screen <-> data mapping for the main pane, rebuilt every frame. */
export interface Viewport {
  width: number;
  height: number;
  x(time: number): number;
  y(price: number): number;
  /** Fractional bar index of a time / screen x, and back. */
  logical(time: number): number;
  logicalAt(x: number): number;
  timeOfLogical(logical: number): number;
  priceAt(y: number): number;
  bars: readonly Candle[];
  fmtPrice(p: number): string;
  fmtTime(t: number): string;
  fmtVolume(v: number): string;
  textColor: string;
}

export interface RenderState {
  selected: boolean;
  hovered: boolean;
}

export interface Handle {
  at: DrawingPoint;
  move(d: Drawing, p: DrawingPoint, vp: Viewport): DrawingPoint[];
}

export interface ToolDef {
  type: DrawingType;
  label: string;
  defaultStyle: DrawingStyle;
  /** For tools placed with a single click: build all points from that click. */
  create?(p: DrawingPoint, vp: Viewport): DrawingPoint[];
  draw(ctx: CanvasRenderingContext2D, vp: Viewport, d: Drawing, st: RenderState): void;
  hit(vp: Viewport, d: Drawing, p: Pt): boolean;
  handles(d: Drawing): Handle[];
  /** Whether the style toolbar offers a fill toggle. */
  fillable?: boolean;
}

export const HIT_PX = 6;
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// ------------------------------------------------------------------ calculations (pure)

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
export const FIB_EXT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618];
const FIB_COLORS: Record<string, string> = {
  '0': '#787b86', '0.236': '#f23645', '0.382': '#ff9800', '0.5': '#4caf50', '0.618': '#089981',
  '0.786': '#00bcd4', '1': '#787b86', '1.272': '#9c27b0', '1.618': '#2962ff', '2': '#e91e63', '2.618': '#f23645',
};

/** Retracement drawn from `a` to `b`: level 0 sits at `b`, level 1 back at `a`. */
export function fibRetracement(a: number, b: number): Array<{ level: number; price: number }> {
  return FIB_LEVELS.map((level) => ({ level, price: b + (a - b) * level }));
}

/** Trend-based extension: the A->B move projected from C. */
export function fibExtension(a: number, b: number, c: number): Array<{ level: number; price: number }> {
  return FIB_EXT_LEVELS.map((level) => ({ level, price: c + (b - a) * level }));
}

export interface PositionStats {
  entry: number;
  target: number;
  stop: number;
  targetPct: number;
  stopPct: number;
  riskReward: number;
  /** Return at `lastClose`, signed for the position's direction. */
  openPnlPct: number | null;
}

export function positionStats(side: 'long' | 'short', points: DrawingPoint[], lastClose?: number): PositionStats {
  const entry = points[0]!.price;
  const target = points[1]!.price;
  const stop = points[2]!.price;
  const dir = side === 'long' ? 1 : -1;
  const pct = (p: number) => ((p - entry) / entry) * 100 * dir;
  const risk = Math.abs(entry - stop);
  return {
    entry, target, stop,
    targetPct: pct(target),
    stopPct: pct(stop),
    riskReward: risk === 0 ? Infinity : Math.abs(target - entry) / risk,
    openPnlPct: lastClose === undefined ? null : pct(lastClose),
  };
}

export interface MeasureStats {
  change: number;
  changePct: number;
  bars: number;
  durationMs: number;
  volume: number;
}

export function measureStats(points: DrawingPoint[], logicalA: number, logicalB: number, bars: readonly Candle[]): MeasureStats {
  const [a, b] = points as [DrawingPoint, DrawingPoint];
  const from = Math.max(0, Math.ceil(Math.min(logicalA, logicalB)));
  const to = Math.min(bars.length - 1, Math.floor(Math.max(logicalA, logicalB)));
  let volume = 0;
  for (let i = from; i <= to; i++) volume += bars[i]!.volume;
  return {
    change: b.price - a.price,
    changePct: ((b.price - a.price) / a.price) * 100,
    bars: Math.round(logicalB - logicalA),
    durationMs: b.time - a.time,
    volume,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && s % 60 && `${s % 60}s`].filter(Boolean);
  return (ms < 0 ? '-' : '') + (parts.join(' ') || '0s');
}

// ------------------------------------------------------------------ canvas helpers

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function stroke(ctx: CanvasRenderingContext2D, style: DrawingStyle, color = style.color, width = style.width): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(style.dash === 'dashed' ? [6, 4] : style.dash === 'dotted' ? [width, width * 2.5] : []);
}

function segment(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** Text in a rounded box. `align` positions the box relative to (x, y). */
export function labelBox(
  ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number,
  opts: { bg: string; color: string; align?: 'left' | 'center' | 'right'; valign?: 'top' | 'middle' | 'bottom' },
): void {
  ctx.font = FONT;
  const lh = 15;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const h = lines.length * lh + 6;
  const bx = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
  const by = opts.valign === 'middle' ? y - h / 2 : opts.valign === 'bottom' ? y - h : y;
  ctx.setLineDash([]);
  ctx.fillStyle = opts.bg;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 3);
  ctx.fill();
  ctx.fillStyle = opts.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + 3 + lh * i + lh / 2));
}

const screen = (vp: Viewport, p: DrawingPoint): Pt => ({ x: vp.x(p.time), y: vp.y(p.price) });
const valid = (...pts: Pt[]) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
const nearSeg = (p: Pt, a: Pt, b: Pt) => distToSegment(p, a, b) <= HIT_PX;

const pointHandles = (d: Drawing): Handle[] =>
  d.points.map((at, i) => ({
    at,
    move: (dd, p) => dd.points.map((q, j) => (j === i ? p : q)),
  }));

const lineStyle = (color = '#2962ff'): DrawingStyle => ({ color, width: 2, dash: 'solid' });

/** Price on the A->B line at a bar index, interpolated in bar-index space. */
function priceOnLine(vp: Viewport, a: DrawingPoint, b: DrawingPoint, logical: number): number {
  const la = vp.logical(a.time);
  const lb = vp.logical(b.time);
  if (la === lb) return a.price;
  return a.price + ((b.price - a.price) * (logical - la)) / (lb - la);
}

// ------------------------------------------------------------------ tools

const trendline: ToolDef = {
  type: 'trendline', label: 'Trend line', defaultStyle: lineStyle(),
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    stroke(ctx, d.style);
    segment(ctx, a, b);
  },
  hit: (vp, d, p) => nearSeg(p, screen(vp, d.points[0]!), screen(vp, d.points[1]!)),
  handles: pointHandles,
};

const ray: ToolDef = {
  type: 'ray', label: 'Ray', defaultStyle: lineStyle(),
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    stroke(ctx, d.style);
    segment(ctx, a, a.x === b.x && a.y === b.y ? b : extendRay(a, b));
  },
  hit(vp, d, p) {
    const a = screen(vp, d.points[0]!);
    const b = screen(vp, d.points[1]!);
    return nearSeg(p, a, a.x === b.x && a.y === b.y ? b : extendRay(a, b));
  },
  handles: pointHandles,
};

const arrow: ToolDef = {
  type: 'arrow', label: 'Arrow', defaultStyle: lineStyle(),
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    stroke(ctx, d.style);
    segment(ctx, a, b);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 10 + d.style.width * 2;
    ctx.setLineDash([]);
    ctx.fillStyle = d.style.color;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - len * Math.cos(ang - 0.45), b.y - len * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - len * Math.cos(ang + 0.45), b.y - len * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  },
  hit: (vp, d, p) => nearSeg(p, screen(vp, d.points[0]!), screen(vp, d.points[1]!)),
  handles: pointHandles,
};

const hline: ToolDef = {
  type: 'hline', label: 'Horizontal line', defaultStyle: lineStyle(),
  create: (p) => [p],
  draw(ctx, vp, d) {
    const y = vp.y(d.points[0]!.price);
    if (!Number.isFinite(y)) return;
    stroke(ctx, d.style);
    segment(ctx, { x: 0, y }, { x: vp.width, y });
  },
  hit: (vp, d, p) => Math.abs(p.y - vp.y(d.points[0]!.price)) <= HIT_PX,
  handles: pointHandles,
};

const vline: ToolDef = {
  type: 'vline', label: 'Vertical line', defaultStyle: lineStyle(),
  create: (p) => [p],
  draw(ctx, vp, d) {
    const x = vp.x(d.points[0]!.time);
    if (!Number.isFinite(x)) return;
    stroke(ctx, d.style);
    segment(ctx, { x, y: 0 }, { x, y: vp.height });
  },
  hit: (vp, d, p) => Math.abs(p.x - vp.x(d.points[0]!.time)) <= HIT_PX,
  handles: pointHandles,
};

/** The two edges of a parallel channel: base A-B and the copy offset to pass through C. */
function channelEdges(vp: Viewport, d: Drawing): { a: Pt; b: Pt; a2: Pt; b2: Pt } {
  const [A, B, C] = d.points as [DrawingPoint, DrawingPoint, DrawingPoint];
  const off = C.price - priceOnLine(vp, A, B, vp.logical(C.time));
  return {
    a: screen(vp, A), b: screen(vp, B),
    a2: screen(vp, { time: A.time, price: A.price + off }), b2: screen(vp, { time: B.time, price: B.price + off }),
  };
}

const channel: ToolDef = {
  type: 'channel', label: 'Parallel channel', defaultStyle: { ...lineStyle(), fill: true }, fillable: true,
  draw(ctx, vp, d) {
    const { a, b, a2, b2 } = channelEdges(vp, d);
    if (!valid(a, b, a2, b2)) return;
    if (d.style.fill !== false) {
      ctx.fillStyle = withAlpha(d.style.color, 0.1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(a2.x, a2.y);
      ctx.closePath();
      ctx.fill();
    }
    stroke(ctx, d.style);
    segment(ctx, a, b);
    segment(ctx, a2, b2);
    stroke(ctx, { ...d.style, dash: 'dashed' }, withAlpha(d.style.color, 0.6), 1);
    segment(ctx, { x: (a.x + a2.x) / 2, y: (a.y + a2.y) / 2 }, { x: (b.x + b2.x) / 2, y: (b.y + b2.y) / 2 });
  },
  hit(vp, d, p) {
    const { a, b, a2, b2 } = channelEdges(vp, d);
    return nearSeg(p, a, b) || nearSeg(p, a2, b2) || (d.style.fill !== false && pointInPolygon(p, [a, b, b2, a2]));
  },
  handles(d) {
    // Moving A or B keeps the channel's width (C's offset from the base line) constant.
    const keepWidth = (i: 0 | 1): Handle => ({
      at: d.points[i]!,
      move(dd, p, vp) {
        const [A, B, C] = dd.points as [DrawingPoint, DrawingPoint, DrawingPoint];
        const lc = vp.logical(C.time);
        const off = C.price - priceOnLine(vp, A, B, lc);
        const nA = i === 0 ? p : A;
        const nB = i === 1 ? p : B;
        return [nA, nB, { time: C.time, price: priceOnLine(vp, nA, nB, lc) + off }];
      },
    });
    return [keepWidth(0), keepWidth(1), { at: d.points[2]!, move: (dd, p) => [dd.points[0]!, dd.points[1]!, p] }];
  },
};

const rect: ToolDef = {
  type: 'rect', label: 'Rectangle', defaultStyle: { color: '#9c27b0', width: 1, dash: 'solid', fill: true }, fillable: true,
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (d.style.fill !== false) {
      ctx.fillStyle = withAlpha(d.style.color, 0.15);
      ctx.fillRect(x, y, w, h);
    }
    stroke(ctx, d.style);
    ctx.strokeRect(x, y, w, h);
  },
  hit(vp, d, p) {
    const [a, b] = d.points.map((q) => screen(vp, q)) as [Pt, Pt];
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    const onEdge = c.some((q, i) => nearSeg(p, q, c[(i + 1) % 4]!));
    const inside = p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
    return onEdge || (d.style.fill !== false && inside);
  },
  handles(d) {
    const [a, b] = d.points as [DrawingPoint, DrawingPoint];
    return [
      ...pointHandles(d),
      { at: { time: a.time, price: b.price }, move: (dd, p) => [{ time: p.time, price: dd.points[0]!.price }, { time: dd.points[1]!.time, price: p.price }] },
      { at: { time: b.time, price: a.price }, move: (dd, p) => [{ time: dd.points[0]!.time, price: p.price }, { time: p.time, price: dd.points[1]!.price }] },
    ];
  },
};

function drawFibLevels(
  ctx: CanvasRenderingContext2D, vp: Viewport, levels: Array<{ level: number; price: number }>, x1: number, x2: number, d: Drawing,
): void {
  const ys = levels.map((l) => vp.y(l.price));
  if (d.style.fill !== false) {
    for (let i = 0; i < levels.length - 1; i++) {
      ctx.fillStyle = withAlpha(FIB_COLORS[String(levels[i + 1]!.level)] ?? d.style.color, 0.08);
      ctx.fillRect(x1, Math.min(ys[i]!, ys[i + 1]!), x2 - x1, Math.abs(ys[i + 1]! - ys[i]!));
    }
  }
  ctx.font = FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  levels.forEach((l, i) => {
    const color = FIB_COLORS[String(l.level)] ?? d.style.color;
    stroke(ctx, d.style, color, d.style.width);
    segment(ctx, { x: x1, y: ys[i]! }, { x: x2, y: ys[i]! });
    ctx.fillStyle = color;
    ctx.fillText(`${l.level} (${vp.fmtPrice(l.price)})`, x1 - 4, ys[i]!);
  });
}

function hitFibLevels(vp: Viewport, levels: Array<{ price: number }>, x1: number, x2: number, p: Pt): boolean {
  if (p.x < x1 - HIT_PX || p.x > x2 + HIT_PX) return false;
  return levels.some((l) => Math.abs(vp.y(l.price) - p.y) <= HIT_PX);
}

const fib: ToolDef = {
  type: 'fib', label: 'Fib retracement', defaultStyle: { color: '#787b86', width: 1, dash: 'solid', fill: true }, fillable: true,
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    drawFibLevels(ctx, vp, fibRetracement(d.points[0]!.price, d.points[1]!.price), Math.min(a.x, b.x), Math.max(a.x, b.x), d);
    stroke(ctx, { ...d.style, dash: 'dashed' }, withAlpha(d.style.color, 0.8), 1);
    segment(ctx, a, b);
  },
  hit(vp, d, p) {
    const [a, b] = d.points.map((q) => screen(vp, q)) as [Pt, Pt];
    return nearSeg(p, a, b) || hitFibLevels(vp, fibRetracement(d.points[0]!.price, d.points[1]!.price), Math.min(a.x, b.x), Math.max(a.x, b.x), p);
  },
  handles: pointHandles,
};

function fibExtSpan(a: Pt, b: Pt, c: Pt): [number, number] {
  return [c.x, c.x + Math.max(Math.abs(b.x - a.x), 60)];
}

const fibext: ToolDef = {
  type: 'fibext', label: 'Trend-based fib extension', defaultStyle: { color: '#787b86', width: 1, dash: 'solid', fill: true }, fillable: true,
  draw(ctx, vp, d) {
    const [a, b, c] = d.points.map((p) => screen(vp, p)) as [Pt, Pt, Pt];
    if (!valid(a, b, c)) return;
    const [A, B, C] = d.points as [DrawingPoint, DrawingPoint, DrawingPoint];
    const [x1, x2] = fibExtSpan(a, b, c);
    drawFibLevels(ctx, vp, fibExtension(A.price, B.price, C.price), x1, x2, d);
    stroke(ctx, { ...d.style, dash: 'dashed' }, withAlpha(d.style.color, 0.8), 1);
    segment(ctx, a, b);
    segment(ctx, b, c);
  },
  hit(vp, d, p) {
    const [a, b, c] = d.points.map((q) => screen(vp, q)) as [Pt, Pt, Pt];
    const [A, B, C] = d.points as [DrawingPoint, DrawingPoint, DrawingPoint];
    const [x1, x2] = fibExtSpan(a, b, c);
    return nearSeg(p, a, b) || nearSeg(p, b, c) || hitFibLevels(vp, fibExtension(A.price, B.price, C.price), x1, x2, p);
  },
  handles: pointHandles,
};

const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

function textBox(vp: Viewport, d: Drawing): { x: number; y: number; w: number; h: number; lines: string[]; size: number } {
  const size = d.style.fontSize ?? 14;
  const lines = (d.text || 'Text').split('\n');
  let w = 0;
  if (measureCanvas) {
    measureCanvas.font = `${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    w = Math.max(...lines.map((l) => measureCanvas.measureText(l).width));
  } else {
    w = Math.max(...lines.map((l) => l.length)) * size * 0.6;
  }
  const p = screen(vp, d.points[0]!);
  return { x: p.x, y: p.y, w, h: lines.length * size * 1.25, lines, size };
}

const text: ToolDef = {
  type: 'text', label: 'Text', defaultStyle: { color: '#2962ff', width: 1, dash: 'solid', fontSize: 14 },
  create: (p) => [p],
  draw(ctx, vp, d, st) {
    const b = textBox(vp, d);
    if (!valid(b)) return;
    ctx.font = `${b.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = d.style.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    b.lines.forEach((l, i) => ctx.fillText(l, b.x, b.y + i * b.size * 1.25));
    if (st.selected || st.hovered) {
      stroke(ctx, { ...d.style, dash: 'dashed', width: 1 }, withAlpha(d.style.color, 0.6), 1);
      ctx.strokeRect(b.x - 4, b.y - 3, b.w + 8, b.h + 6);
    }
  },
  hit(vp, d, p) {
    const b = textBox(vp, d);
    return p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3;
  },
  handles: pointHandles,
};

const measure: ToolDef = {
  type: 'measure', label: 'Measure', defaultStyle: { color: '#2962ff', width: 1, dash: 'solid' },
  draw(ctx, vp, d) {
    const [a, b] = d.points.map((p) => screen(vp, p)) as [Pt, Pt];
    if (!valid(a, b)) return;
    const s = measureStats(d.points, vp.logical(d.points[0]!.time), vp.logical(d.points[1]!.time), vp.bars);
    const color = s.change >= 0 ? '#2962ff' : '#f23645';
    ctx.fillStyle = withAlpha(color, 0.15);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    stroke(ctx, { ...d.style, dash: 'solid' }, color, 1);
    arrow.draw(ctx, vp, { ...d, points: [d.points[0]!, d.points[1]!], style: { color, width: 1, dash: 'solid' } }, { selected: false, hovered: false });
    segment(ctx, { x: mx, y: a.y }, { x: mx, y: b.y });
    segment(ctx, { x: a.x, y: my }, { x: b.x, y: my });
    const sign = s.change >= 0 ? '+' : '';
    labelBox(ctx, [
      `${sign}${vp.fmtPrice(s.change)} (${sign}${s.changePct.toFixed(2)}%)`,
      `${s.bars} bars, ${formatDuration(s.durationMs)}`,
      `Vol ${vp.fmtVolume(s.volume)}`,
    ], mx, s.change >= 0 ? Math.min(a.y, b.y) - 6 : Math.max(a.y, b.y) + 6, {
      bg: color, color: '#ffffff', align: 'center', valign: s.change >= 0 ? 'bottom' : 'top',
    });
  },
  hit(vp, d, p) {
    const [a, b] = d.points.map((q) => screen(vp, q)) as [Pt, Pt];
    return p.x >= Math.min(a.x, b.x) - HIT_PX && p.x <= Math.max(a.x, b.x) + HIT_PX && p.y >= Math.min(a.y, b.y) - HIT_PX && p.y <= Math.max(a.y, b.y) + HIT_PX;
  },
  handles: pointHandles,
};

function positionTool(side: 'long' | 'short'): ToolDef {
  const dir = side === 'long' ? 1 : -1;
  const box = (vp: Viewport, d: Drawing) => {
    const [e, t, s] = d.points as [DrawingPoint, DrawingPoint, DrawingPoint];
    return { x1: vp.x(e.time), x2: vp.x(t.time), ye: vp.y(e.price), yt: vp.y(t.price), ys: vp.y(s.price) };
  };
  return {
    type: side, label: side === 'long' ? 'Long position' : 'Short position',
    defaultStyle: { color: '#787b86', width: 1, dash: 'solid' },
    create(p, vp) {
      // Default box: 20 bars wide, target 12% of the pane away, stop half that (R:R 2).
      const end = vp.timeOfLogical(vp.logical(p.time) + 20);
      const y = vp.y(p.price);
      return [
        p,
        { time: end, price: vp.priceAt(y - dir * vp.height * 0.12) },
        { time: end, price: vp.priceAt(y + dir * vp.height * 0.06) },
      ];
    },
    draw(ctx, vp, d, st) {
      const b = box(vp, d);
      if (![b.x1, b.x2, b.ye, b.yt, b.ys].every(Number.isFinite)) return;
      const x = Math.min(b.x1, b.x2);
      const w = Math.abs(b.x2 - b.x1);
      ctx.fillStyle = 'rgba(8, 153, 129, 0.2)';
      ctx.fillRect(x, Math.min(b.ye, b.yt), w, Math.abs(b.yt - b.ye));
      ctx.fillStyle = 'rgba(242, 54, 69, 0.2)';
      ctx.fillRect(x, Math.min(b.ye, b.ys), w, Math.abs(b.ys - b.ye));
      stroke(ctx, d.style, d.style.color, 1);
      segment(ctx, { x, y: b.ye }, { x: x + w, y: b.ye });

      const last = vp.bars[vp.bars.length - 1];
      const s = positionStats(side, d.points, last && last.time >= d.points[0]!.time ? last.close : undefined);
      const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      const cx = x + w / 2;
      const detailed = st.selected || st.hovered;
      labelBox(ctx, [detailed ? `Target: ${vp.fmtPrice(s.target)} (${pct(s.targetPct)})` : pct(s.targetPct)], cx,
        b.yt + (b.yt < b.ye ? -4 : 4), { bg: '#089981', color: '#fff', align: 'center', valign: b.yt < b.ye ? 'bottom' : 'top' });
      labelBox(ctx, [detailed ? `Stop: ${vp.fmtPrice(s.stop)} (${pct(s.stopPct)})` : pct(s.stopPct)], cx,
        b.ys + (b.ys < b.ye ? -4 : 4), { bg: '#f23645', color: '#fff', align: 'center', valign: b.ys < b.ye ? 'bottom' : 'top' });
      const rr = Number.isFinite(s.riskReward) ? s.riskReward.toFixed(2) : '∞';
      const entryLines = [`${side === 'long' ? 'Long' : 'Short'} · R:R ${rr}`];
      if (detailed && s.openPnlPct !== null) entryLines.push(`Open P&L ${pct(s.openPnlPct)}`);
      labelBox(ctx, entryLines, cx, b.ye, { bg: withAlpha('#131722', 0.85), color: '#ffffff', align: 'center', valign: 'middle' });
    },
    hit(vp, d, p) {
      const b = box(vp, d);
      const top = Math.min(b.yt, b.ys, b.ye);
      const bottom = Math.max(b.yt, b.ys, b.ye);
      return p.x >= Math.min(b.x1, b.x2) && p.x <= Math.max(b.x1, b.x2) && p.y >= top - HIT_PX && p.y <= bottom + HIT_PX;
    },
    handles(d) {
      const [e, t, s] = d.points as [DrawingPoint, DrawingPoint, DrawingPoint];
      return [
        { at: e, move: (dd, p) => [p, dd.points[1]!, dd.points[2]!] },
        { at: t, move: (dd, p) => [dd.points[0]!, p, { time: p.time, price: dd.points[2]!.price }] },
        { at: { time: t.time, price: s.price }, move: (dd, p) => [dd.points[0]!, { time: p.time, price: dd.points[1]!.price }, p] },
      ];
    },
  };
}

export const TOOLS: Record<DrawingType, ToolDef> = {
  trendline, ray, arrow, hline, vline, channel, rect, fib, fibext, text, measure,
  long: positionTool('long'), short: positionTool('short'),
};
