import { ProviderError } from '../types.ts';
import type { ChartResult } from './bars.ts';

export interface YahooClientOptions {
  baseUrl?: string;
  /** Minimum gap between any two upstream requests, across every symbol and both markets. */
  minGapMs?: number;
}

interface CacheEntry<T> {
  at: number;
  value?: T;
  pending?: Promise<T>;
}

export interface SearchQuote {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
}

const MAX_QUEUE = 40;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Yahoo Finance's public chart and search endpoints. They are unofficial, need no account, and
 * rate-limit by IP without publishing limits, so this client is deliberately conservative:
 * requests are serialised with a minimum gap, identical requests share one call, results are
 * cached, and a 429 stops all traffic with exponential backoff (1 min doubling to 15 min).
 * While backed off, calls fail immediately rather than queueing more load.
 *
 * One instance is shared by every Yahoo-backed provider so the budget is global.
 */
export class YahooClient {
  private readonly baseUrl: string;
  private readonly minGapMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastRequest = 0;
  private blockedUntil = 0;
  private backoffMs = BACKOFF_START_MS;
  private readonly charts = new Map<string, CacheEntry<ChartResult>>();
  private readonly searches = new Map<string, CacheEntry<SearchQuote[]>>();

  constructor(opts: YahooClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://query1.finance.yahoo.com';
    this.minGapMs = opts.minGapMs ?? 1500;
  }

  /** Epoch ms until which Yahoo is being left alone after a 429, or 0. */
  get backedOffUntil(): number {
    return this.blockedUntil > Date.now() ? this.blockedUntil : 0;
  }

  /** Chart data for one symbol; cached for `ttlMs`. Stale data is served if a refresh fails. */
  chart(symbol: string, params: { interval: string; range: string }, ttlMs: number): Promise<ChartResult> {
    const key = `${symbol}|${params.interval}|${params.range}`;
    return this.cached(this.charts, key, ttlMs, 400, async () => {
      const body = await this.get<{ chart: { result: ChartResult[] | null; error: { code: string; description: string } | null } }>(
        `/v8/finance/chart/${encodeURIComponent(symbol)}`,
        {
          interval: params.interval,
          // `range=max` silently coarsens daily bars to monthly; an explicit window keeps them daily.
          ...(params.range === 'max' ? { period1: '0', period2: String(Math.floor(Date.now() / 1000)) } : { range: params.range }),
          includePrePost: 'false',
          events: '',
        },
      );
      const r = body.chart.result?.[0];
      if (!r) throw new ProviderError(`Yahoo: ${body.chart.error?.description ?? 'no data'} (${symbol})`, 404);
      return r;
    });
  }

  search(q: string): Promise<SearchQuote[]> {
    return this.cached(this.searches, q.toLowerCase(), 30 * 60_000, 500, async () => {
      const body = await this.get<{ quotes?: SearchQuote[] }>('/v1/finance/search', {
        q, quotesCount: '25', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false',
      });
      return body.quotes ?? [];
    });
  }

  private cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, maxEntries: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = map.get(key);
    if (hit?.value !== undefined && now - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (hit?.pending) return hit.pending;
    const entry: CacheEntry<T> = hit ?? { at: 0 };
    entry.pending = load()
      .then((v) => {
        entry.value = v;
        entry.at = Date.now();
        return v;
      })
      .catch((err) => {
        if (entry.value !== undefined) return entry.value; // stale beats nothing
        throw err;
      })
      .finally(() => {
        entry.pending = undefined;
        if (entry.value === undefined) map.delete(key);
      });
    map.set(key, entry);
    if (map.size > maxEntries) map.delete(map.keys().next().value!); // oldest inserted
    return entry.pending;
  }

  private get<T>(path: string, params: Record<string, string>): Promise<T> {
    this.assertNotBlocked();
    if (this.queued >= MAX_QUEUE) throw new ProviderError('Yahoo request queue is full; try again shortly', 429, Date.now() + 5000);
    this.queued++;
    const run = this.tail.then(async () => {
      this.queued--;
      this.assertNotBlocked();
      const wait = this.lastRequest + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest = Date.now();
      return this.request<T>(path, params);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${this.baseUrl}${path}?${qs}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; ChartDeck/0.1)' },
      signal: AbortSignal.timeout(15_000),
    }).catch((err: Error) => {
      throw new ProviderError(`Yahoo unreachable: ${err.message}`, 502);
    });
    if (res.status === 429) {
      this.blockedUntil = Date.now() + this.backoffMs;
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      throw new ProviderError('Yahoo Finance is rate-limiting this server; backing off', 429, this.blockedUntil);
    }
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as T | null;
      if (body) return body; // chart 404s carry a JSON error the caller reports
    }
    if (!res.ok) throw new ProviderError(`Yahoo ${path} failed: ${res.status}`, 502);
    this.backoffMs = BACKOFF_START_MS;
    return (await res.json()) as T;
  }

  private assertNotBlocked(): void {
    const until = this.backedOffUntil;
    if (until) throw new ProviderError(`Yahoo Finance rate limit: retrying in ${Math.ceil((until - Date.now()) / 1000)}s`, 429, until);
  }
}
