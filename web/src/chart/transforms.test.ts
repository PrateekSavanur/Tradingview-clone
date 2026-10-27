import { describe, expect, it } from 'vitest';
import { fromChartTime, heikinAshi, hollowStyle, toChartTime } from './transforms.ts';

const bar = (time: number, open: number, high: number, low: number, close: number) => ({ time, open, high, low, close, volume: 1 });

describe('heikinAshi', () => {
  it('matches hand-computed reference values', () => {
    const ha = heikinAshi([bar(1, 10, 12, 9, 11), bar(2, 11, 14, 10, 13), bar(3, 13, 13, 8, 9)]);
    // HA1: close=(10+12+9+11)/4=10.5, open=(10+11)/2=10.5
    expect(ha[0]).toMatchObject({ open: 10.5, close: 10.5, high: 12, low: 9 });
    // HA2: close=(11+14+10+13)/4=12, open=(10.5+10.5)/2=10.5
    expect(ha[1]).toMatchObject({ open: 10.5, close: 12, high: 14, low: 10 });
    // HA3: close=(13+13+8+9)/4=10.75, open=(10.5+12)/2=11.25, high=max(13,11.25,10.75)=13
    expect(ha[2]).toMatchObject({ open: 11.25, close: 10.75, high: 13, low: 8 });
  });
});

describe('hollowStyle', () => {
  it('is hollow on up-bodies and coloured by change from previous close', () => {
    expect(hollowStyle(bar(1, 10, 12, 9, 11), 9, 'G', 'R')).toEqual({ color: 'rgba(0,0,0,0)', borderColor: 'G', wickColor: 'G' });
    expect(hollowStyle(bar(1, 10, 12, 9, 11), 12, 'G', 'R')).toEqual({ color: 'rgba(0,0,0,0)', borderColor: 'R', wickColor: 'R' });
    expect(hollowStyle(bar(1, 11, 12, 9, 10), 9, 'G', 'R')).toEqual({ color: 'G', borderColor: 'G', wickColor: 'G' });
  });
});

describe('chart time', () => {
  it('round-trips and leaves daily+ bars on UTC midnight', () => {
    const ms = Date.parse('2026-10-27T00:00:00Z');
    expect(fromChartTime(toChartTime(ms, '1m'), '1m')).toBe(ms);
    expect(toChartTime(ms, '1D')).toBe(ms / 1000);
  });
});
