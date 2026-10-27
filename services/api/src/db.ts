import type { Candle, Drawing, Timeframe } from '@chartdeck/shared';
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
  `CREATE TABLE IF NOT EXISTS users (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email         text NOT NULL UNIQUE,
     password_hash text NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     family      uuid NOT NULL,
     token_hash  bytea NOT NULL UNIQUE,
     expires_at  timestamptz NOT NULL,
     revoked_at  timestamptz,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens (family)`,
  // used_at: rotated (successor issued). revoked_at: logged out or family killed after reuse.
  `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS drawings (
     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     symbol     text NOT NULL,
     data       jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, symbol)
   )`,
];

export class Database {
  readonly pool: pg.Pool;

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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Closed-candle store. Only candles whose bucket has ended are written, so rows never change. */
export class CandleStore {
  constructor(private readonly db: Database) {}

  /** Newest-first rows with open time <= `end`, returned ascending. */
  async before(provider: string, symbol: string, tf: Timeframe, end: number, limit: number): Promise<Candle[]> {
    const { rows } = await this.db.pool.query<{ t: string; open: number; high: number; low: number; close: number; volume: number }>(
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
    await this.db.pool.query(
      `INSERT INTO candles (provider, symbol, tf, time, open, high, low, close, volume)
       SELECT $1, $2, $3, to_timestamp(t), o, h, l, c, v
         FROM unnest($4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[]) AS u(t, o, h, l, c, v)
       ON CONFLICT (provider, symbol, tf, time) DO NOTHING`,
      [provider, symbol, tf, cols.t, cols.o, cols.h, cols.l, cols.c, cols.v],
    );
  }
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export interface RefreshRow {
  id: string;
  user_id: string;
  family: string;
  expires_at: Date;
  /** When the token was first rotated, before this call (null if this is its first use). */
  used_at: Date | null;
  revoked_at: Date | null;
}

export class UserStore {
  constructor(private readonly db: Database) {}

  async create(email: string, passwordHash: string): Promise<UserRow | null> {
    const { rows } = await this.db.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, email, password_hash`,
      [email, passwordHash],
    );
    return rows[0] ?? null;
  }

  async byEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db.pool.query<UserRow>(`SELECT id, email, password_hash FROM users WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  async byId(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.pool.query<UserRow>(`SELECT id, email, password_hash FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async addRefreshToken(userId: string, family: string, hash: Buffer, expiresAt: Date): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO refresh_tokens (user_id, family, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [userId, family, hash, expiresAt],
    );
  }

  /**
   * Atomically mark the token with this hash as used and return its row as it was before,
   * or null if unknown. Row locking serialises concurrent refreshes of the same token.
   */
  async useRefreshToken(hash: Buffer): Promise<RefreshRow | null> {
    const { rows } = await this.db.pool.query<RefreshRow>(
      `UPDATE refresh_tokens t SET used_at = COALESCE(t.used_at, now())
         FROM (SELECT id, used_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE) prev
        WHERE t.id = prev.id
        RETURNING t.id, t.user_id, t.family, t.expires_at, t.revoked_at, prev.used_at`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async familyOf(hash: Buffer): Promise<string | null> {
    const { rows } = await this.db.pool.query<{ family: string }>(`SELECT family FROM refresh_tokens WHERE token_hash = $1`, [hash]);
    return rows[0]?.family ?? null;
  }

  async revokeFamily(family: string): Promise<void> {
    await this.db.pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL`, [family]);
  }
}

export class DrawingStore {
  constructor(private readonly db: Database) {}

  async get(userId: string, symbol: string): Promise<{ drawings: Drawing[]; updatedAt: number } | null> {
    const { rows } = await this.db.pool.query<{ data: Drawing[]; updated_at: Date }>(
      `SELECT data, updated_at FROM drawings WHERE user_id = $1 AND symbol = $2`,
      [userId, symbol],
    );
    const r = rows[0];
    return r ? { drawings: r.data, updatedAt: r.updated_at.getTime() } : null;
  }

  async put(userId: string, symbol: string, drawings: Drawing[]): Promise<number> {
    const { rows } = await this.db.pool.query<{ updated_at: Date }>(
      `INSERT INTO drawings (user_id, symbol, data, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, symbol) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING updated_at`,
      [userId, symbol, JSON.stringify(drawings)],
    );
    return rows[0]!.updated_at.getTime();
  }
}
