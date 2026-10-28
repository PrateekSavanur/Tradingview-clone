import { ALERT_STATUSES, type AlertEvent, type AlertSpec, type AlertStatus, type Timeframe } from '@chartdeck/shared';
import pg from 'pg';

export interface ActiveAlert {
  id: string;
  userId: string;
  spec: AlertSpec;
}

export interface FireRecord {
  alertId: string;
  userId: string;
  firedAt: number;
  symbol: string;
  tf: Timeframe;
  message: string;
  price: number;
  value: number;
  target: number;
  status: AlertStatus;
}

/** Fired events kept per user; older ones are pruned. */
const EVENTS_KEPT = 500;

/** The alert service's view of the database. The api owns the schema and runs migrations. */
export class AlertDb {
  readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
  }

  /** Wait for the api to have created the tables. */
  async ready(): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(`SELECT to_regclass('alert_events') IS NOT NULL AS ok`);
    return !!rows[0]?.ok;
  }

  async active(): Promise<ActiveAlert[]> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; spec: AlertSpec }>(
      `SELECT id, user_id, spec FROM alerts WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())`,
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, spec: r.spec }));
  }

  /** The alert if it exists and is active and unexpired. */
  async activeOne(id: string): Promise<ActiveAlert | null> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; spec: AlertSpec }>(
      `SELECT id, user_id, spec FROM alerts WHERE id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`,
      [id],
    );
    return rows[0] ? { id: rows[0].id, userId: rows[0].user_id, spec: rows[0].spec } : null;
  }

  /**
   * Record a fire: bump the alert (only if still active, so a pause or delete racing with the
   * tick wins) and log the event. Returns the event, or null if the alert was no longer active.
   */
  async recordFire(f: FireRecord): Promise<AlertEvent | null> {
    if (!ALERT_STATUSES.includes(f.status)) throw new Error(`bad status ${f.status}`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE alerts SET last_fired_at = to_timestamp($2 / 1000.0), fire_count = fire_count + 1, status = $3, updated_at = now()
          WHERE id = $1 AND status = 'active'`,
        [f.alertId, f.firedAt, f.status],
      );
      if (!upd.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO alert_events (alert_id, user_id, fired_at, symbol, tf, message, price, value, target)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9) RETURNING id`,
        [f.alertId, f.userId, f.firedAt, f.symbol, f.tf, f.message, f.price, f.value, f.target],
      );
      await client.query(
        `DELETE FROM alert_events WHERE user_id = $1 AND id <= (
           SELECT id FROM alert_events WHERE user_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
        [f.userId, EVENTS_KEPT],
      );
      await client.query('COMMIT');
      return {
        id: Number(rows[0]!.id), alertId: f.alertId, firedAt: f.firedAt, symbol: f.symbol, tf: f.tf, message: f.message,
        price: f.price, value: f.value, target: f.target, read: false,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Mark active alerts past their expiry; returns them. */
  async expireDue(): Promise<Array<{ id: string; userId: string }>> {
    const { rows } = await this.pool.query<{ id: string; user_id: string }>(
      `UPDATE alerts SET status = 'expired', updated_at = now()
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id, user_id`,
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id }));
  }

  /** The address alert emails go to, only once it has been confirmed. */
  async verifiedEmail(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND email_verified_at IS NOT NULL`,
      [userId],
    );
    return rows[0]?.email ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
