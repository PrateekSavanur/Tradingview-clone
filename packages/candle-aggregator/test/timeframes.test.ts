import { describe, expect, it } from 'vitest';
import { bucketStart, nextBucket, prevBucket } from '@chartdeck/shared';

const utc = (s: string) => Date.parse(s + 'Z');

describe('bucketStart', () => {
  it('floors fixed-length timeframes', () => {
    const ts = utc('2026-10-27T13:47:59.999');
    expect(bucketStart('1s', ts)).toBe(utc('2026-10-27T13:47:59'));
    expect(bucketStart('1m', ts)).toBe(utc('2026-10-27T13:47:00'));
    expect(bucketStart('3m', ts)).toBe(utc('2026-10-27T13:45:00'));
    expect(bucketStart('15m', ts)).toBe(utc('2026-10-27T13:45:00'));
    expect(bucketStart('2h', ts)).toBe(utc('2026-10-27T12:00:00'));
    expect(bucketStart('4h', ts)).toBe(utc('2026-10-27T12:00:00'));
    expect(bucketStart('1D', ts)).toBe(utc('2026-10-27T00:00:00'));
  });

  it('opens weeks on Monday 00:00 UTC (Binance convention)', () => {
    // 2026-10-26 is a Monday; matches the open time Binance returned for the current 1w kline.
    expect(bucketStart('1W', utc('2026-10-27T13:00:00'))).toBe(utc('2026-10-26T00:00:00'));
    expect(bucketStart('1W', utc('2026-10-26T00:00:00'))).toBe(utc('2026-10-26T00:00:00'));
    expect(bucketStart('1W', utc('2026-10-25T23:59:59'))).toBe(utc('2026-10-19T00:00:00'));
    expect(bucketStart('1W', utc('1970-01-04T00:00:00'))).toBe(utc('1969-12-29T00:00:00'));
  });

  it('opens months on the 1st, across year boundaries and leap years', () => {
    expect(bucketStart('1M', utc('2026-10-27T13:00:00'))).toBe(utc('2026-10-01T00:00:00'));
    expect(nextBucket('1M', utc('2026-12-01T00:00:00'))).toBe(utc('2027-01-01T00:00:00'));
    expect(prevBucket('1M', utc('2026-01-01T00:00:00'))).toBe(utc('2025-12-01T00:00:00'));
    expect(nextBucket('1M', utc('2028-02-01T00:00:00')) - utc('2028-02-01T00:00:00')).toBe(29 * 86_400_000);
  });
});
