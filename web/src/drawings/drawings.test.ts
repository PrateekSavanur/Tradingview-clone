import type { Candle, Drawing } from '@chartdeck/shared';
import { describe, expect, it } from 'vitest';
import { History, TimeIndex, distToSegment, pointInPolygon } from './geometry.ts';
import { TOOLS, fibExtension, fibRetracement, formatDuration, measureStats, positionStats, type Viewport } from './tools.ts';

const M = 60_000;
const T0 = Date.parse('2026-10-27T10:00:00Z');
const bar = (i: number, close = 100, volume = 1): Candle => ({ time: T0 + i * M, open: close, high: close, low: close, close, volume });
const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i, i + 1));

describe('TimeIndex', () => {
  const idx = new TimeIndex(bars, '1m');
  it('maps bar times to indexes and interpolates between them', () => {
    expect(idx.logicalOf(T0)).toBe(0);
    expect(idx.logicalOf(T0 + 3 * M)).toBe(3);
    expect(idx.logicalOf(T0 + 3.5 * M)).toBe(3.5);
  });
  it('extrapolates by the timeframe step beyond both ends (future and past)', () => {
    expect(idx.logicalOf(T0 + 15 * M)).toBe(15);
    expect(idx.logicalOf(T0 - 2 * M)).toBe(-2);
    expect(idx.timeOf(12)).toBe(T0 + 12 * M);
    expect(idx.timeOf(-3)).toBe(T0 - 3 * M);
  });
  it('round-trips across gaps in the data', () => {
    const gappy = new TimeIndex([bar(0), bar(1), bar(5), bar(6)], '1m');
    expect(gappy.logicalOf(T0 + 3 * M)).toBe(1.5); // halfway through the gap between bar 1 and 5
    expect(gappy.timeOf(1.5)).toBe(T0 + 3 * M);
  });
});

describe('fibonacci', () => {
  it('retracement: level 0 at the end point, 1 at the start', () => {
    const lv = Object.fromEntries(fibRetracement(100, 200).map((l) => [l.level, l.price]));
    expect(lv[0]).toBe(200);
    expect(lv[1]).toBe(100);
    expect(lv[0.5]).toBe(150);
    expect(lv[0.618]).toBeCloseTo(138.2, 10);
    expect(lv[1.618]).toBeCloseTo(38.2, 10);
  });
  it('extension projects the A->B move from C', () => {
    const lv = Object.fromEntries(fibExtension(100, 150, 120).map((l) => [l.level, l.price]));
    expect(lv[0]).toBe(120);
    expect(lv[1]).toBe(170);
    expect(lv[1.618]).toBeCloseTo(200.9, 10);
  });
});

describe('positionStats', () => {
  const pts = (e: number, t: number, s: number) => [{ time: 0, price: e }, { time: 1, price: t }, { time: 1, price: s }];
  it('long: target above, stop below', () => {
    const s = positionStats('long', pts(100, 110, 95), 104);
    expect(s.targetPct).toBeCloseTo(10);
    expect(s.stopPct).toBeCloseTo(-5);
    expect(s.riskReward).toBeCloseTo(2);
    expect(s.openPnlPct).toBeCloseTo(4);
  });
  it('short: profits when price falls', () => {
    const s = positionStats('short', pts(100, 85, 105), 97);
    expect(s.targetPct).toBeCloseTo(15);
    expect(s.stopPct).toBeCloseTo(-5);
    expect(s.riskReward).toBeCloseTo(3);
    expect(s.openPnlPct).toBeCloseTo(3);
  });
});

describe('measure', () => {
  it('reports change, bars, duration and the volume in range', () => {
    const s = measureStats([{ time: T0 + 2 * M, price: 102 }, { time: T0 + 5 * M, price: 105.06 }], 2, 5, bars);
    expect(s.change).toBeCloseTo(3.06);
    expect(s.changePct).toBeCloseTo(3);
    expect(s.bars).toBe(3);
    expect(s.volume).toBe(3 + 4 + 5 + 6);
    expect(formatDuration(s.durationMs)).toBe('3m');
    expect(formatDuration(90_061_000)).toBe('1d 1h 1m');
  });
});

describe('geometry', () => {
  it('distance to segment clamps to the endpoints', () => {
    expect(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });
  it('point in polygon', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
  });
});

describe('History', () => {
  it('undoes and redoes, and a new change clears redo', () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.redo(1)).toBe(2);
    h.push(2);
    expect(h.canRedo).toBe(false);
  });
});

/** Linear viewport: x = bar index * 10, y = 1000 - price. */
const idx = new TimeIndex(bars, '1m');
const vp: Viewport = {
  width: 500, height: 400,
  x: (t) => idx.logicalOf(t) * 10, y: (p) => 1000 - p,
  logical: (t) => idx.logicalOf(t), logicalAt: (x) => x / 10, timeOfLogical: (l) => idx.timeOf(l), priceAt: (y) => 1000 - y,
  bars, fmtPrice: String, fmtTime: String, fmtVolume: String, textColor: '#000',
};
const drawing = (type: Drawing['type'], points: Drawing['points']): Drawing => ({
  id: 'testid1', type, points, style: { ...TOOLS[type].defaultStyle }, updatedAt: 0,
});

describe('hit testing', () => {
  it('trendline is hit near the segment only', () => {
    const d = drawing('trendline', [{ time: T0, price: 900 }, { time: T0 + 4 * M, price: 860 }]); // (0,100) -> (40,140)
    expect(TOOLS.trendline.hit(vp, d, { x: 20, y: 122 })).toBe(true);
    expect(TOOLS.trendline.hit(vp, d, { x: 20, y: 140 })).toBe(false);
    expect(TOOLS.trendline.hit(vp, d, { x: 60, y: 160 })).toBe(false); // beyond the end
  });
  it('ray continues past its second point', () => {
    const d = drawing('ray', [{ time: T0, price: 900 }, { time: T0 + 4 * M, price: 860 }]);
    expect(TOOLS.ray.hit(vp, d, { x: 60, y: 160 })).toBe(true);
  });
  it('horizontal line spans the whole pane', () => {
    const d = drawing('hline', [{ time: T0, price: 900 }]);
    expect(TOOLS.hline.hit(vp, d, { x: 480, y: 103 })).toBe(true);
  });
  it('channel keeps its width when an anchor moves', () => {
    const d = drawing('channel', [{ time: T0, price: 900 }, { time: T0 + 4 * M, price: 900 }, { time: T0 + 2 * M, price: 910 }]);
    const moved = TOOLS.channel.handles(d)[1]!.move(d, { time: T0 + 4 * M, price: 940 }, vp);
    // Base now rises 40 over 4 bars: at bar 2 it's at 920, so C sits 10 above at 930.
    expect(moved[2]).toEqual({ time: T0 + 2 * M, price: 930 });
  });
  it('rectangle corner handles move the right edges', () => {
    const d = drawing('rect', [{ time: T0, price: 900 }, { time: T0 + 4 * M, price: 850 }]);
    const pts = TOOLS.rect.handles(d)[2]!.move(d, { time: T0 + M, price: 840 }, vp);
    expect(pts).toEqual([{ time: T0 + M, price: 900 }, { time: T0 + 4 * M, price: 840 }]);
  });
});
