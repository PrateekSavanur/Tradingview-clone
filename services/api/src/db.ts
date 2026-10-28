import type { Alert, AlertEvent, AlertSpec, AlertStatus, Candle, Drawing, Timeframe } from '@chartdeck/shared';
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
  `CREATE TABLE IF NOT EXISTS user_docs (
     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind       text NOT NULL,
     name       text NOT NULL,
     data       jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, kind, name)
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
  // One-time links for email verification and password reset; only the hash is stored.
  `CREATE TABLE IF NOT EXISTS email_tokens (
     token_hash bytea PRIMARY KEY,
     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     purpose    text NOT NULL,
     expires_at timestamptz NOT NULL,
     used_at    timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, purpose)`,
  // Written by the api (CRUD) and the alerts service (fired, triggered, expired).
  `CREATE TABLE IF NOT EXISTS alerts (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     symbol        text NOT NULL,
     spec          jsonb NOT NULL,
     status        text NOT NULL DEFAULT 'active',
     expires_at    timestamptz,
     last_fired_at timestamptz,
     fire_count    integer NOT NULL DEFAULT 0,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS alerts_user ON alerts (user_id)`,
  `CREATE INDEX IF NOT EXISTS alerts_active ON alerts (status) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS alert_events (
     id        bigserial PRIMARY KEY,
     alert_id  uuid REFERENCES alerts(id) ON DELETE SET NULL,
     user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     fired_at  timestamptz NOT NULL,
     symbol    text NOT NULL,
     tf        text NOT NULL,
     message   text NOT NULL,
     price     double precision NOT NULL,
     value     double precision,
     target    double precision,
     read_at   timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS alert_events_user ON alert_events (user_id, id DESC)`,
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
  email_verified_at: Date | null;
}

const USER_COLS = 'id, email, password_hash, email_verified_at';

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
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING ${USER_COLS}`,
      [email, passwordHash],
    );
    return rows[0] ?? null;
  }

  async byEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db.pool.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  async byId(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.pool.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
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

  /** Sign out every session (after a password reset). */
  async revokeAll(userId: string): Promise<void> {
    await this.db.pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
  }

  async markVerified(userId: string): Promise<void> {
    await this.db.pool.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [userId]);
  }

  /** New one-time token; earlier unused ones for the same purpose stop working. */
  async addEmailToken(userId: string, purpose: EmailTokenPurpose, hash: Buffer, expiresAt: Date): Promise<void> {
    await this.db.pool.query(`DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
    await this.db.pool.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)`,
      [hash, userId, purpose, expiresAt],
    );
  }

  /** Consume a token: returns its user if it was valid, unused and unexpired. Single use, atomically. */
  async useEmailToken(hash: Buffer, purpose: EmailTokenPurpose): Promise<string | null> {
    const { rows } = await this.db.pool.query<{ user_id: string }>(
      `UPDATE email_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hash, purpose],
    );
    return rows[0]?.user_id ?? null;
  }
}

export type EmailTokenPurpose = 'verify' | 'reset';

interface AlertRow {
  id: string;
  spec: AlertSpec;
  status: AlertStatus;
  last_fired_at: Date | null;
  fire_count: number;
  created_at: Date;
  updated_at: Date;
}

const toAlert = (r: AlertRow): Alert => ({
  ...r.spec, id: r.id, status: r.status, lastFiredAt: r.last_fired_at?.getTime() ?? null, fireCount: r.fire_count,
  createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
});

interface EventRow {
  id: string;
  alert_id: string | null;
  fired_at: Date;
  symbol: string;
  tf: Timeframe;
  message: string;
  price: number;
  value: number | null;
  target: number | null;
  read_at: Date | null;
}

export const toAlertEvent = (r: EventRow): AlertEvent => ({
  id: Number(r.id), alertId: r.alert_id, firedAt: r.fired_at.getTime(), symbol: r.symbol, tf: r.tf, message: r.message,
  price: r.price, value: r.value, target: r.target, read: r.read_at !== null,
});

const ALERT_COLS = 'id, spec, status, last_fired_at, fire_count, created_at, updated_at';

export class AlertStore {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<Alert[]> {
    const { rows } = await this.db.pool.query<AlertRow>(`SELECT ${ALERT_COLS} FROM alerts WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(toAlert);
  }

  /** Returns null when the user already has `max` alerts. */
  async create(userId: string, spec: AlertSpec, max: number): Promise<Alert | null> {
    const { rows } = await this.db.pool.query<AlertRow>(
      `INSERT INTO alerts (user_id, symbol, spec, expires_at)
       SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM alerts WHERE user_id = $1) < $5
       RETURNING ${ALERT_COLS}`,
      [userId, spec.symbol.id, JSON.stringify(spec), toDate(spec.expiresAt), max],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  /** Replace the condition; the alert becomes active again with a fresh start. */
  async update(userId: string, id: string, spec: AlertSpec): Promise<Alert | null> {
    const { rows } = await this.db.pool.query<AlertRow>(
      `UPDATE alerts SET symbol = $3, spec = $4, expires_at = $5, status = 'active', updated_at = now()
        WHERE id = $1 AND user_id = $2 RETURNING ${ALERT_COLS}`,
      [id, userId, spec.symbol.id, JSON.stringify(spec), toDate(spec.expiresAt)],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async setStatus(userId: string, id: string, status: 'active' | 'paused'): Promise<Alert | null> {
    const { rows } = await this.db.pool.query<AlertRow>(
      `UPDATE alerts SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${ALERT_COLS}`,
      [id, userId, status],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async get(userId: string, id: string): Promise<Alert | null> {
    const { rows } = await this.db.pool.query<AlertRow>(`SELECT ${ALERT_COLS} FROM alerts WHERE id = $1 AND user_id = $2`, [id, userId]);
    return rows[0] ? toAlert(rows[0]) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const r = await this.db.pool.query(`DELETE FROM alerts WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Newest first, `before` an event id for paging. */
  async events(userId: string, limit: number, before?: number): Promise<{ events: AlertEvent[]; unread: number }> {
    const [list, unread] = await Promise.all([
      this.db.pool.query<EventRow>(
        `SELECT id, alert_id, fired_at, symbol, tf, message, price, value, target, read_at FROM alert_events
          WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
        [userId, before ?? null, limit],
      ),
      this.db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM alert_events WHERE user_id = $1 AND read_at IS NULL`, [userId]),
    ]);
    return { events: list.rows.map(toAlertEvent), unread: Number(unread.rows[0]?.n ?? 0) };
  }

  async markRead(userId: string): Promise<void> {
    await this.db.pool.query(`UPDATE alert_events SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  }

  async clearEvents(userId: string): Promise<void> {
    await this.db.pool.query(`DELETE FROM alert_events WHERE user_id = $1`, [userId]);
  }
}

const toDate = (ms: number | null) => (ms === null ? null : new Date(ms));

export class DocStore {
  constructor(private readonly db: Database) {}

  async list(userId: string, kind: string): Promise<Array<{ name: string; updatedAt: number }>> {
    const { rows } = await this.db.pool.query<{ name: string; updated_at: Date }>(
      `SELECT name, updated_at FROM user_docs WHERE user_id = $1 AND kind = $2 ORDER BY lower(name)`,
      [userId, kind],
    );
    return rows.map((r) => ({ name: r.name, updatedAt: r.updated_at.getTime() }));
  }

  async get(userId: string, kind: string, name: string): Promise<{ data: unknown; updatedAt: number } | null> {
    const { rows } = await this.db.pool.query<{ data: unknown; updated_at: Date }>(
      `SELECT data, updated_at FROM user_docs WHERE user_id = $1 AND kind = $2 AND name = $3`,
      [userId, kind, name],
    );
    return rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at.getTime() } : null;
  }

  /** Upsert; returns null when creating it would exceed `maxPerKind`. */
  async put(userId: string, kind: string, name: string, data: unknown, maxPerKind: number): Promise<number | null> {
    const { rows } = await this.db.pool.query<{ updated_at: Date }>(
      `INSERT INTO user_docs (user_id, kind, name, data)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (SELECT 1 FROM user_docs WHERE user_id = $1 AND kind = $2 AND name = $3)
           OR (SELECT count(*) FROM user_docs WHERE user_id = $1 AND kind = $2) < $5
       ON CONFLICT (user_id, kind, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING updated_at`,
      [userId, kind, name, JSON.stringify(data), maxPerKind],
    );
    return rows[0]?.updated_at.getTime() ?? null;
  }

  async delete(userId: string, kind: string, name: string): Promise<boolean> {
    const r = await this.db.pool.query(`DELETE FROM user_docs WHERE user_id = $1 AND kind = $2 AND name = $3`, [userId, kind, name]);
    return (r.rowCount ?? 0) > 0;
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
