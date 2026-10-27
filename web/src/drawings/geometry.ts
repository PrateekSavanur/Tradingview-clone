import { TF_MS, type Candle, type Timeframe } from '@chartdeck/shared';

const AVG_MONTH_MS = 30.436875 * 86_400_000;
const stepMs = (tf: Timeframe) => (tf === '1M' ? AVG_MONTH_MS : TF_MS[tf]);

/**
 * Maps epoch-ms time <-> fractional bar index over the loaded bars, extrapolating by the
 * timeframe step beyond either end. Drawings store real times, so they survive timeframe changes
 * and can extend into the future where no bars exist yet.
 */
export class TimeIndex {
  constructor(
    private readonly bars: readonly Candle[],
    private readonly tf: Timeframe,
  ) {}

  logicalOf(time: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return NaN;
    const step = stepMs(this.tf);
    if (time <= b[0]!.time) return (time - b[0]!.time) / step;
    if (time >= b[n - 1]!.time) return n - 1 + (time - b[n - 1]!.time) / step;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid]!.time <= time) lo = mid;
      else hi = mid;
    }
    return lo + (time - b[lo]!.time) / (b[hi]!.time - b[lo]!.time);
  }

  timeOf(logical: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return NaN;
    const step = stepMs(this.tf);
    if (logical <= 0) return b[0]!.time + logical * step;
    if (logical >= n - 1) return b[n - 1]!.time + (logical - (n - 1)) * step;
    const i = Math.floor(logical);
    return b[i]!.time + (logical - i) * (b[i + 1]!.time - b[i]!.time);
  }
}

export interface Pt {
  x: number;
  y: number;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A point far along a->b, so a segment from `a` to it renders as a ray. */
export function extendRay(a: Pt, b: Pt, length = 20_000): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: a.x + (dx / len) * length, y: a.y + (dy / len) * length };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Undo/redo over immutable snapshots. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 100) {}

  /** Record `state` as the state before a change. */
  push(state: T): void {
    this.past.push(state);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
