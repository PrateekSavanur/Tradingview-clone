import { fromTuple, type Candle, type CandleTuple, type SymbolInfo, type Timeframe } from '@chartdeck/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? body.error ?? res.statusText, res.status);
  }
  return (await res.json()) as T;
}

export function searchSymbols(q: string, signal?: AbortSignal): Promise<SymbolInfo[]> {
  return getJson(`/api/symbols/search?q=${encodeURIComponent(q)}&limit=30`, signal);
}

export function getSymbol(id: string): Promise<SymbolInfo> {
  return getJson(`/api/symbols/${encodeURIComponent(id)}`);
}

/** Candles with open time strictly before `to` (or the latest page when `to` is omitted), ascending. */
export async function getHistory(symbol: string, tf: Timeframe, opts: { to?: number; limit?: number } = {}, signal?: AbortSignal): Promise<Candle[]> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(opts.limit ?? 500) });
  if (opts.to !== undefined) qs.set('to', String(opts.to));
  const res = await getJson<{ candles: CandleTuple[] }>(`/api/history?${qs}`, signal);
  return res.candles.map(fromTuple);
}
