/** Static per-market configuration for the Yahoo-backed providers. */
export interface MarketDef {
  id: 'india' | 'us';
  /** Yahoo exchange code -> the name shown in ChartDeck. Quotes from other exchanges are ignored. */
  exchanges: Record<string, string>;
  tickSize: number;
}

export const INDIA: MarketDef = {
  id: 'india',
  exchanges: { NSI: 'NSE', BSE: 'BSE' },
  tickSize: 0.05,
};

export const US: MarketDef = {
  id: 'us',
  exchanges: {
    NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ', NIM: 'NASDAQ',
    NYQ: 'NYSE', ASE: 'NYSE American', PCX: 'NYSE Arca', BTS: 'Cboe BZX',
    SNP: 'S&P', DJI: 'Dow Jones', CXI: 'Cboe',
  },
  tickSize: 0.01,
};

interface Popular {
  ticker: string;
  name: string;
  exchange: string;
  type: 'stock' | 'index';
}

const p = (ticker: string, name: string, exchange: string, type: 'stock' | 'index' = 'stock'): Popular => ({ ticker, name, exchange, type });

/** Shown in search before anything is typed, and known without a lookup. */
export const POPULAR: Record<MarketDef['id'], Popular[]> = {
  india: [
    p('^NSEI', 'NIFTY 50', 'NSE', 'index'),
    p('^BSESN', 'S&P BSE SENSEX', 'BSE', 'index'),
    p('^NSEBANK', 'NIFTY BANK', 'NSE', 'index'),
    p('RELIANCE.NS', 'Reliance Industries', 'NSE'),
    p('HDFCBANK.NS', 'HDFC Bank', 'NSE'),
    p('TCS.NS', 'Tata Consultancy Services', 'NSE'),
    p('BHARTIARTL.NS', 'Bharti Airtel', 'NSE'),
    p('ICICIBANK.NS', 'ICICI Bank', 'NSE'),
    p('INFY.NS', 'Infosys', 'NSE'),
    p('SBIN.NS', 'State Bank of India', 'NSE'),
    p('ITC.NS', 'ITC', 'NSE'),
    p('LT.NS', 'Larsen & Toubro', 'NSE'),
    p('HINDUNILVR.NS', 'Hindustan Unilever', 'NSE'),
    p('KOTAKBANK.NS', 'Kotak Mahindra Bank', 'NSE'),
    p('AXISBANK.NS', 'Axis Bank', 'NSE'),
    p('BAJFINANCE.NS', 'Bajaj Finance', 'NSE'),
    p('MARUTI.NS', 'Maruti Suzuki India', 'NSE'),
    p('SUNPHARMA.NS', 'Sun Pharmaceutical Industries', 'NSE'),
  ],
  us: [
    p('^GSPC', 'S&P 500', 'S&P', 'index'),
    p('^IXIC', 'NASDAQ Composite', 'NASDAQ', 'index'),
    p('^DJI', 'Dow Jones Industrial Average', 'Dow Jones', 'index'),
    p('SPY', 'SPDR S&P 500 ETF Trust', 'NYSE Arca'),
    p('QQQ', 'Invesco QQQ Trust', 'NASDAQ'),
    p('AAPL', 'Apple Inc.', 'NASDAQ'),
    p('MSFT', 'Microsoft Corporation', 'NASDAQ'),
    p('NVDA', 'NVIDIA Corporation', 'NASDAQ'),
    p('AMZN', 'Amazon.com, Inc.', 'NASDAQ'),
    p('GOOGL', 'Alphabet Inc.', 'NASDAQ'),
    p('META', 'Meta Platforms, Inc.', 'NASDAQ'),
    p('TSLA', 'Tesla, Inc.', 'NASDAQ'),
    p('BRK-B', 'Berkshire Hathaway Inc.', 'NYSE'),
    p('JPM', 'JPMorgan Chase & Co.', 'NYSE'),
    p('V', 'Visa Inc.', 'NYSE'),
    p('NFLX', 'Netflix, Inc.', 'NASDAQ'),
  ],
};
