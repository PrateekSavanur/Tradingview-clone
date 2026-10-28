import { INDICATOR_BY_ID, sanitizeInputs, type IndicatorMeta, type PlotDef } from '@chartdeck/indicators';
import {
  AlertSpec, MAX_ALERT_EXPIRY_MS, type AlertOperator, type AlertSeries, type AlertTarget, type IndicatorSeries,
} from '@chartdeck/shared';

/** Plots an alert can watch: computed bar by bar and drawn on the bar they belong to. */
export function alertablePlots(meta: IndicatorMeta): PlotDef[] {
  if (!meta.create || meta.special) return [];
  return meta.plots.filter((p) => !p.offset);
}

export class AlertSpecError extends Error {}

function checkIndicator(s: IndicatorSeries): IndicatorSeries {
  const meta = INDICATOR_BY_ID.get(s.type);
  if (!meta) throw new AlertSpecError(`Unknown indicator "${s.type}"`);
  if (!alertablePlots(meta).some((p) => p.key === s.plot)) throw new AlertSpecError(`${meta.short} has no alertable plot "${s.plot}"`);
  return { ...s, inputs: sanitizeInputs(meta, s.inputs) };
}

/**
 * Parse and normalise an alert from an untrusted body: schema, known indicator and plot,
 * clamped inputs, expiry in the future and within a year. Throws ZodError or AlertSpecError.
 */
export function normalizeSpec(raw: unknown, now = Date.now()): AlertSpec {
  const spec = AlertSpec.parse(raw);
  if (spec.expiresAt !== null && (spec.expiresAt <= now || spec.expiresAt > now + MAX_ALERT_EXPIRY_MS)) {
    throw new AlertSpecError('Expiry must be in the future and within a year');
  }
  const source = spec.source.kind === 'indicator' ? checkIndicator(spec.source) : spec.source;
  const target = spec.target.kind === 'indicator' ? checkIndicator(spec.target) : spec.target;
  return { ...spec, source, target };
}

export const OPERATOR_LABELS: Record<AlertOperator, string> = {
  crossing: 'crossing',
  crossing_up: 'crossing up',
  crossing_down: 'crossing down',
  greater: 'greater than',
  less: 'less than',
};

/** "RSI(14, close) · RSI" for an indicator series, "Price" for price. */
export function seriesLabel(s: AlertSeries | AlertTarget, fmtValue: (v: number) => string = String): string {
  if (s.kind === 'price') return 'Price';
  if (s.kind === 'value') return fmtValue(s.value);
  const meta = INDICATOR_BY_ID.get(s.type);
  if (!meta) return s.type.toUpperCase();
  const inputs = meta.inputs.map((d) => s.inputs[d.key]).filter((v) => v !== undefined).join(', ');
  const plot = meta.plots.find((p) => p.key === s.plot);
  const name = `${meta.short}${inputs ? `(${inputs})` : ''}`;
  return plot && meta.plots.length > 1 ? `${name} · ${plot.label}` : name;
}

/** Generated description, used when the alert has no message: "BTCUSDT 1h: Price crossing up 70000". */
export function describeAlert(spec: Pick<AlertSpec, 'symbol' | 'tf' | 'source' | 'operator' | 'target'>, fmtValue?: (v: number) => string): string {
  return `${spec.symbol.ticker} ${spec.tf}: ${seriesLabel(spec.source, fmtValue)} ${OPERATOR_LABELS[spec.operator]} ${seriesLabel(spec.target, fmtValue)}`;
}

/** Same indicator configuration, so both series can share one computation. */
export const seriesKey = (s: IndicatorSeries) => `${s.type}:${JSON.stringify(Object.entries(s.inputs).sort(([a], [b]) => a.localeCompare(b)))}`;
