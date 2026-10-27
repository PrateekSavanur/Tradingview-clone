import type { Timeframe } from '@chartdeck/shared';

export function decimalsFor(tickSize: number): number {
  if (tickSize >= 1) return 0;
  const s = tickSize.toFixed(12).replace(/0+$/, '');
  return Math.max(0, s.length - s.indexOf('.') - 1);
}

export function formatPrice(v: number, decimals: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(a < 10 ? 4 : 2).replace(/\.?0+$/, '');
}

export function formatPercent(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, (f = new Intl.DateTimeFormat(undefined, { hourCycle: 'h23', ...opts })));
  return f;
}

/** Crosshair / legend time label, in the viewer's local time zone. */
export function formatBarTime(ms: number, tf: Timeframe): string {
  if (tf === '1M') return fmt({ year: 'numeric', month: 'short' }).format(ms);
  if (tf === '1D' || tf === '1W') return fmt({ year: 'numeric', month: 'short', day: '2-digit' }).format(ms);
  const withSeconds = tf === '1s';
  return fmt({
    year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(ms);
}
