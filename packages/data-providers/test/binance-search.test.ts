import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceProvider } from '../src/index.ts';

const exchangeInfo = {
  symbols: [
    ['ETHBTC', 'ETH', 'BTC', '0.00001'],
    ['BTCUSDT', 'BTC', 'USDT', '0.01'],
    ['BTCEUR', 'BTC', 'EUR', '0.01'],
    ['WBTCUSDT', 'WBTC', 'USDT', '0.01'],
    ['BTCUSDC', 'BTC', 'USDC', '0.01'],
  ].map(([symbol, baseAsset, quoteAsset, tickSize]) => ({
    symbol, baseAsset, quoteAsset, status: 'TRADING',
    filters: [{ filterType: 'PRICE_FILTER', tickSize }],
  })),
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (_url: string | URL) => new Response(JSON.stringify(body), { headers: { 'x-mbx-used-weight-1m': '20' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('BinanceProvider', () => {
  it('ranks exact, base-asset and preferred-quote matches first', async () => {
    stubFetch(exchangeInfo);
    const p = new BinanceProvider();
    const res = await p.searchSymbols('btc', 10);
    expect(res.map((s) => s.ticker)).toEqual(['BTCUSDT', 'BTCUSDC', 'BTCEUR', 'WBTCUSDT', 'ETHBTC']);
    expect(res[0]).toMatchObject({ id: 'binance:BTCUSDT', tickSize: 0.01, description: 'BTC / USDT' });
  });

  it('caches exchangeInfo between searches', async () => {
    const f = stubFetch(exchangeInfo);
    const p = new BinanceProvider();
    await p.searchSymbols('btc', 5);
    await p.getSymbol('ETHBTC');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('maps kline rows and timeframe names', async () => {
    const f = stubFetch([[1000, '1.5', '2', '1', '1.75', '10.5', 1999, '0', 3]]);
    const p = new BinanceProvider();
    const rows = await p.getCandles('BTCUSDT', '1D', { limit: 1 });
    expect(rows).toEqual([{ time: 1000, open: 1.5, high: 2, low: 1, close: 1.75, volume: 10.5 }]);
    expect(String(f.mock.calls[0]![0])).toContain('interval=1d');
  });
});
