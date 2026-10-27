import { ProviderError } from '../types.ts';

/**
 * Minimal Binance REST client that respects the IP weight budget: it tracks
 * X-MBX-USED-WEIGHT-1M, slows down near the limit, and fails fast while banned (418/429).
 */
export class BinanceRest {
  private usedWeight = 0;
  private weightWindow = 0;
  private blockedUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly weightLimit = 6000,
  ) {}

  async get<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
    const now = Date.now();
    if (now < this.blockedUntil) {
      throw new ProviderError(`Binance rate limit: blocked for ${Math.ceil((this.blockedUntil - now) / 1000)}s`, 429, this.blockedUntil);
    }
    const minute = Math.floor(now / 60_000);
    if (minute !== this.weightWindow) {
      this.weightWindow = minute;
      this.usedWeight = 0;
    }
    if (this.usedWeight + weight > this.weightLimit * 0.9) {
      throw new ProviderError('Binance request weight budget exhausted for this minute', 429, (minute + 1) * 60_000);
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const res = await fetch(`${this.baseUrl}${path}?${qs}`, { signal: AbortSignal.timeout(10_000) });

    const used = Number(res.headers.get('x-mbx-used-weight-1m'));
    this.usedWeight = Number.isFinite(used) && used > 0 ? used : this.usedWeight + weight;

    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      this.blockedUntil = Date.now() + retryAfter * 1000;
      throw new ProviderError(`Binance returned ${res.status}`, res.status, this.blockedUntil);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(`Binance ${path} failed: ${res.status} ${body.slice(0, 200)}`, res.status === 400 ? 400 : 502);
    }
    return (await res.json()) as T;
  }
}
