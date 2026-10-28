import { z } from 'zod';
import { TIMEFRAMES, type Timeframe } from './timeframes.ts';
import { SymbolRef } from './workspace.ts';

/**
 * Server-side alerts. A condition compares a source series with a target (a constant or another
 * series) on one symbol and timeframe, the way TradingView's "Create alert" dialog does.
 */

export const ALERT_OPERATORS = ['crossing', 'crossing_up', 'crossing_down', 'greater', 'less'] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

/**
 * - `once`: fire the first time the condition is met, then stop.
 * - `once_per_bar`: at most once per bar, as soon as it is met (intrabar).
 * - `once_per_bar_close`: only evaluated when a bar closes.
 */
export const ALERT_FREQUENCIES = ['once', 'once_per_bar', 'once_per_bar_close'] as const;
export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];

export const ALERT_STATUSES = ['active', 'paused', 'triggered', 'expired'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const MAX_ALERTS_PER_USER = 100;
/** Expiry can be at most this far ahead; `null` means it never expires. */
export const MAX_ALERT_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;

const finite = z.number().finite();

/** One plot of an indicator configuration, computed by the alert service on the alert's timeframe. */
export const IndicatorSeries = z.object({
  kind: z.literal('indicator'),
  type: z.string().regex(/^[a-z0-9]{1,24}$/),
  inputs: z.record(z.string().max(32), z.union([finite, z.string().max(32)])),
  plot: z.string().regex(/^[A-Za-z0-9_]{1,32}$/),
});
export type IndicatorSeries = z.infer<typeof IndicatorSeries>;

/** The close of the alert timeframe's candle, which is the last price while the bar is open. */
export const PriceSeries = z.object({ kind: z.literal('price') });

export const AlertSeries = z.discriminatedUnion('kind', [PriceSeries, IndicatorSeries]);
export type AlertSeries = z.infer<typeof AlertSeries>;

export const AlertTarget = z.discriminatedUnion('kind', [PriceSeries, IndicatorSeries, z.object({ kind: z.literal('value'), value: finite })]);
export type AlertTarget = z.infer<typeof AlertTarget>;

export const AlertSpec = z
  .object({
    symbol: SymbolRef,
    tf: z.enum(TIMEFRAMES),
    source: AlertSeries,
    operator: z.enum(ALERT_OPERATORS),
    target: AlertTarget,
    frequency: z.enum(ALERT_FREQUENCIES),
    /** Epoch ms, or null for no expiry. */
    expiresAt: z.number().int().positive().nullable(),
    /** Shown in notifications instead of the generated description. */
    message: z.string().trim().max(200),
    notify: z.object({ email: z.boolean() }),
  })
  .refine((s) => !(s.source.kind === 'price' && s.target.kind === 'price'), { message: 'Compare price with something else', path: ['target'] });
export type AlertSpec = z.infer<typeof AlertSpec>;

export interface Alert extends AlertSpec {
  id: string;
  status: AlertStatus;
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

export interface AlertEvent {
  id: number;
  alertId: string | null;
  firedAt: number;
  symbol: string;
  tf: Timeframe;
  message: string;
  /** Close of the alert timeframe's candle when it fired. */
  price: number;
  /** Source and target values that met the condition. */
  value: number | null;
  target: number | null;
  read: boolean;
}

/** Pushed to the browser over `/api/alerts/stream` (server-sent events). */
export type AlertStreamMessage =
  | { type: 'fired'; event: AlertEvent; alertId: string; status: AlertStatus }
  /** Alerts changed (created, edited, expired, deleted) somewhere; reload the list. */
  | { type: 'changed' };

export const ALERT_REDIS_KEYS = {
  /** api → alerts service: an alert was created, edited or deleted (message: alert id). */
  changed: 'cd:alerts-changed',
  /** alerts service / api → api replicas: `{ userId, msg: AlertStreamMessage }` for that user's streams. */
  userEvents: 'cd:alert-events',
  /** The alerts service's demand set, read by ingest like a gateway's. */
  demand: 'cd:demand:alerts',
} as const;
