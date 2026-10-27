import type { Candle, Timeframe } from '@chartdeck/shared';
import pg from 'pg';

const MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS timescaledb`,
  `CREATE TABLE IF NOT EXISTS candles (
     provider text NOT NULL,
     symbol   text NOT NULL,
     tf       text NOT NULL,
     time     timestamptz NOT NULL,
     open     double precision NOT NULL,
     high     double precision NOT NULL,
     low      double precision NOT NULL,
     close    double precision NOT NULL,
     volume   double precision NOT NULL,
     PRIMARY KEY (provider, symbol, tf, time)
   )`,
  `SELECT create_hypertable('candles', by_range('time', INTERVAL '30 days'), if_not_exists => TRUE)`,
];

/** Closed-candle store. Only candles whose bucket has ended are written, so rows never change. */
export class CandleStore {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }

  async migrate(): Promise<void> {
    for (const sql of MIGRATIONS) await this.pool.query(sql);
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  /** Newest-first rows with open time <= `end`, returned ascending. */
  async before(provider: string, symbol: string, tf: Timeframe, end: number, limit: number): Promise<Candle[]> {
    const { rows } = await this.pool.query<{ t: string; open: number; high: number; low: number; close: number; volume: number }>(
      `SELECT (extract(epoch FROM time) * 1000)::bigint AS t, open, high, low, close, volume
         FROM candles
        WHERE provider = $1 AND symbol = $2 AND tf = $3 AND time <= to_timestamp($4 / 1000.0)
        ORDER BY time DESC
        LIMIT $5`,
      [provider, symbol, tf, end, limit],
    );
    return rows.reverse().map((r) => ({ time: Number(r.t), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }

  async upsert(provider: string, symbol: string, tf: Timeframe, candles: Candle[]): Promise<void> {
    if (!candles.length) return;
    const n = candles.length;
    const cols = { t: new Array<number>(n), o: new Array<number>(n), h: new Array<number>(n), l: new Array<number>(n), c: new Array<number>(n), v: new Array<number>(n) };
    candles.forEach((k, i) => {
      cols.t[i] = k.time / 1000; cols.o[i] = k.open; cols.h[i] = k.high; cols.l[i] = k.low; cols.c[i] = k.close; cols.v[i] = k.volume;
    });
    await this.pool.query(
      `INSERT INTO candles (provider, symbol, tf, time, open, high, low, close, volume)
       SELECT $1, $2, $3, to_timestamp(t), o, h, l, c, v
         FROM unnest($4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[]) AS u(t, o, h, l, c, v)
       ON CONFLICT (provider, symbol, tf, time) DO NOTHING`,
      [provider, symbol, tf, cols.t, cols.o, cols.h, cols.l, cols.c, cols.v],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
