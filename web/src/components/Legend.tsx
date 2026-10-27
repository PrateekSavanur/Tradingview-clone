import type { SymbolInfo, Timeframe } from '@chartdeck/shared';
import type { LegendData } from '../chart/ChartController.ts';
import { decimalsFor, formatBarTime, formatPercent, formatPrice, formatVolume } from '../lib/format.ts';

export function Legend({ symbol, tf, data }: { symbol: SymbolInfo; tf: Timeframe; data: LegendData | null }) {
  const d = decimalsFor(symbol.tickSize);
  const bar = data?.bar;
  const ref = data?.prevClose ?? bar?.open;
  const change = bar && ref ? bar.close - ref : 0;
  const pct = bar && ref ? (change / ref) * 100 : 0;
  const color = change >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]';

  return (
    <div className="pointer-events-none absolute left-3 top-2 z-10 select-none text-xs leading-5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{symbol.ticker}</span>
        <span className="text-[var(--muted)]">· {tf} · {symbol.exchange}</span>
        {bar && !data?.live && <span className="text-[var(--muted)]">{formatBarTime(bar.time, tf)}</span>}
      </div>
      {bar && (
        <div className="tabular flex flex-wrap gap-x-2.5">
          <Field k="O" v={formatPrice(bar.open, d)} color={color} />
          <Field k="H" v={formatPrice(bar.high, d)} color={color} />
          <Field k="L" v={formatPrice(bar.low, d)} color={color} />
          <Field k="C" v={formatPrice(bar.close, d)} color={color} />
          <span className={color}>
            {change >= 0 ? '+' : ''}{formatPrice(change, d)} ({formatPercent(pct)})
          </span>
          <Field k="Vol" v={formatVolume(bar.volume)} color="" />
        </div>
      )}
    </div>
  );
}

function Field({ k, v, color }: { k: string; v: string; color: string }) {
  return (
    <span>
      <span className="text-[var(--muted)]">{k}</span> <span className={color}>{v}</span>
    </span>
  );
}
