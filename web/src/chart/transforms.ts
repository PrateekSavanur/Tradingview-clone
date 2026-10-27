import { TF_MS, type Candle, type Timeframe } from '@chartdeck/shared';
import type { UTCTimestamp } from 'lightweight-charts';

/**
 * Lightweight Charts renders time in UTC. Intraday bars are shifted by the viewer's UTC offset
 * so axis labels read in local time. Daily and longer bars are left on UTC midnight, otherwise
 * viewers west of UTC would see each day labelled with the previous date. A single offset is
 * used for the whole session to keep times strictly increasing across DST changes.
 */
const LOCAL_OFFSET_SEC = -new Date().getTimezoneOffset() * 60;

export function toChartTime(ms: number, tf: Timeframe): UTCTimestamp {
  const shift = TF_MS[tf] < TF_MS['1D'] ? LOCAL_OFFSET_SEC : 0;
  return (Math.floor(ms / 1000) + shift) as UTCTimestamp;
}

export function fromChartTime(t: number, tf: Timeframe): number {
  const shift = TF_MS[tf] < TF_MS['1D'] ? LOCAL_OFFSET_SEC : 0;
  return (t - shift) * 1000;
}

/** Heikin Ashi bar given the raw bar and the previous HA bar (if any). */
export function heikinAshiBar(c: Candle, prev: Candle | undefined): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, volume: c.volume };
}

export function heikinAshi(bars: Candle[]): Candle[] {
  const out: Candle[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = heikinAshiBar(bars[i]!, out[i - 1]);
  return out;
}

export interface HollowStyle {
  color: string;
  borderColor: string;
  wickColor: string;
}

/**
 * Hollow candles: the body is hollow when close >= open and filled otherwise; the colour
 * follows the change from the previous close (up = green, down = red).
 */
export function hollowStyle(c: Candle, prevClose: number | undefined, up: string, down: string): HollowStyle {
  const rising = prevClose === undefined ? c.close >= c.open : c.close >= prevClose;
  const col = rising ? up : down;
  return { color: c.close >= c.open ? 'rgba(0,0,0,0)' : col, borderColor: col, wickColor: col };
}
