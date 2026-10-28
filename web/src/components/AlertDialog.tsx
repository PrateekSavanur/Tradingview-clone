import { OPERATOR_LABELS, alertablePlots, describeAlert, seriesLabel } from '@chartdeck/alert-engine';
import { INDICATOR_BY_ID } from '@chartdeck/indicators';
import {
  ALERT_FREQUENCIES, ALERT_OPERATORS, TIMEFRAMES,
  type AlertFrequency, type AlertOperator, type AlertSeries, type AlertSpec, type Timeframe,
} from '@chartdeck/shared';
import { useEffect, useMemo, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { sendVerification, useAuth } from '../lib/auth.ts';
import { decimalsFor } from '../lib/format.ts';
import { useAlerts, type AlertDialogState } from '../store/alerts.ts';
import { toast } from '../store/toasts.ts';
import { useUi } from '../store/ui.ts';
import { useActiveChart } from '../store/workspace.ts';

const FREQUENCY_LABELS: Record<AlertFrequency, string> = {
  once: 'Only once',
  once_per_bar: 'Once per bar',
  once_per_bar_close: 'Once per bar close',
};
const FREQUENCY_HINTS: Record<AlertFrequency, string> = {
  once: 'Fires the first time the condition is met, then stops.',
  once_per_bar: 'Fires as soon as the condition is met, at most once per bar.',
  once_per_bar_close: 'Checked when each bar closes, so intrabar moves that reverse don’t count.',
};
const DAY = 86_400_000;
const EXPIRY: Array<{ key: string; label: string; days: number | null }> = [
  { key: '1d', label: '1 day', days: 1 },
  { key: '1w', label: '1 week', days: 7 },
  { key: '1m', label: '1 month', days: 30 },
  { key: '3m', label: '3 months', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
  { key: 'never', label: 'Never', days: null },
];

interface SeriesOption {
  key: string;
  label: string;
  series: AlertSeries;
  current: number | null;
}

const keyOf = (s: AlertSeries) => JSON.stringify(s);

/** Create or edit an alert. Opened through `useAlerts.openCreate / openEdit`. */
export function AlertDialog({ controller }: { controller: ChartController | null }) {
  const dialog = useAlerts((s) => s.dialog);
  const close = useAlerts((s) => s.closeDialog);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, close]);

  if (!dialog) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[8vh]" onMouseDown={close}>
      <div role="dialog" aria-label={dialog.mode === 'edit' ? 'Edit alert' : 'Create alert'} onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        {user ? (
          <AlertForm key={dialog.mode === 'edit' ? dialog.alert.id : 'new'} dialog={dialog} controller={controller} emailVerified={user.emailVerified} />
        ) : (
          <div className="p-5 text-sm">
            <h2 className="mb-2 text-lg font-semibold">Create alert</h2>
            <p className="mb-4 text-[var(--muted)]">Alerts run on the server, so they fire even when this tab is closed. Sign in to create one.</p>
            <div className="flex justify-end gap-2">
              <button onClick={close} className="h-9 rounded border border-[var(--border)] px-4 hover:bg-[var(--hover)]">Cancel</button>
              <button onClick={() => { close(); useUi.getState().setAuthOpen(true); }} className="h-9 rounded bg-[var(--accent)] px-4 font-medium text-white">Sign in</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertForm({ dialog, controller, emailVerified }: { dialog: NonNullable<AlertDialogState>; controller: ChartController | null; emailVerified: boolean }) {
  const chart = useActiveChart();
  const { save, closeDialog } = useAlerts.getState();
  const editing = dialog.mode === 'edit' ? dialog.alert : null;
  const draft = dialog.mode === 'create' ? dialog.draft : {};
  const symbol = editing?.symbol ?? draft.symbol ?? chart.symbol;
  const decimals = decimalsFor(symbol.tickSize);
  // Live readings only make sense for what the active chart is showing.
  const onChart = chart.symbol.id === symbol.id;
  const values = useMemo(() => controller?.currentValues() ?? { close: null, indicators: new Map() }, [controller]);

  const [tf, setTf] = useState<Timeframe>(editing?.tf ?? draft.tf ?? chart.tf);
  const options = useMemo(() => {
    const opts: SeriesOption[] = [{ key: keyOf({ kind: 'price' }), label: 'Price', series: { kind: 'price' }, current: onChart ? values.close : null }];
    const seen = new Set(opts.map((o) => o.key));
    const add = (series: AlertSeries, current: number | null) => {
      const key = keyOf(series);
      if (seen.has(key)) return;
      seen.add(key);
      opts.push({ key, label: seriesLabel(series), series, current });
    };
    for (const inst of chart.indicators) {
      const meta = INDICATOR_BY_ID.get(inst.type);
      if (!meta) continue;
      for (const p of alertablePlots(meta)) {
        const v = onChart && chart.tf === tf ? (values.indicators.get(inst.uid)?.[p.key] ?? null) : null;
        add({ kind: 'indicator', type: inst.type, inputs: inst.inputs, plot: p.key }, v);
      }
    }
    // An edited alert may watch an indicator this chart doesn't have.
    for (const s of [editing?.source, editing?.target, draft.source]) if (s && s.kind === 'indicator') add(s, null);
    return opts;
  }, [chart, onChart, tf, values, editing, draft.source]);

  const initialSource = editing?.source ?? draft.source ?? { kind: 'price' as const };
  const initialTarget = editing?.target ?? draft.target ?? null;
  const [sourceKey, setSourceKey] = useState(keyOf(initialSource));
  const [operator, setOperator] = useState<AlertOperator>(editing?.operator ?? draft.operator ?? 'crossing');
  const [targetKey, setTargetKey] = useState(initialTarget && initialTarget.kind !== 'value' ? keyOf(initialTarget) : 'value');
  const source = options.find((o) => o.key === sourceKey) ?? options[0]!;
  // Plain digits, not locale formatting: this goes into an input that is parsed with Number().
  const defaultValue = (cur: number | null) => (cur === null ? '' : source.series.kind === 'price' ? cur.toFixed(decimals) : String(Number(cur.toPrecision(6))));
  const [value, setValue] = useState(() => (initialTarget?.kind === 'value' ? String(initialTarget.value) : defaultValue(source.current)));
  const [valueTouched, setValueTouched] = useState(initialTarget?.kind === 'value');
  const [frequency, setFrequency] = useState<AlertFrequency>(editing?.frequency ?? draft.frequency ?? 'once');
  const [expiry, setExpiry] = useState(editing ? (editing.expiresAt === null ? 'never' : 'keep') : '1m');
  const [message, setMessage] = useState(editing?.message ?? draft.message ?? '');
  const [email, setEmail] = useState(editing?.notify.email ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Picking another source suggests its current reading as the level, until the user types one.
  useEffect(() => {
    if (!valueTouched) setValue(defaultValue(source.current));
  }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = options.filter((o) => o.key !== sourceKey && !(o.series.kind === 'price' && source.series.kind === 'price'));
  const target: AlertSpec['target'] =
    targetKey === 'value' ? { kind: 'value', value: Number(value) } : (targets.find((o) => o.key === targetKey)?.series ?? { kind: 'value', value: Number(value) });

  const expiresAt = (() => {
    if (expiry === 'keep') return editing?.expiresAt ?? null;
    const days = EXPIRY.find((e) => e.key === expiry)?.days ?? null;
    return days === null ? null : Date.now() + days * DAY;
  })();

  const spec: AlertSpec = { symbol, tf, source: source.series, operator, target, frequency, expiresAt, message: message.trim(), notify: { email: email && emailVerified } };
  const preview = describeAlert(spec, (v) => (Number.isFinite(v) ? String(v) : '…'));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (target.kind === 'value' && (value.trim() === '' || !Number.isFinite(target.value))) return setError('Enter a number for the value');
    if (expiry === 'keep' && editing?.expiresAt && editing.expiresAt <= Date.now()) return setError('That expiry has passed; pick a new one');
    setBusy(true);
    setError(null);
    try {
      await save(spec, editing?.id);
      toast({ tone: 'success', title: editing ? 'Alert updated' : 'Alert created', body: spec.message || preview });
      closeDialog();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-8 w-full rounded border border-[var(--border)] bg-[var(--panel)] px-2 text-sm outline-none focus:border-[var(--accent)]';
  return (
    <form onSubmit={submit}>
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-base font-semibold">{editing ? 'Edit alert' : 'Create alert'} · {symbol.ticker}</h2>
        <button type="button" onClick={closeDialog} className="rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="Close">✕</button>
      </div>
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2.5 px-4 py-4 text-sm">
        <Label htmlFor="al-source">Condition</Label>
        <select id="al-source" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} className={field}>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        <span />
        <select aria-label="Operator" value={operator} onChange={(e) => setOperator(e.target.value as AlertOperator)} className={field}>
          {ALERT_OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op][0]!.toUpperCase() + OPERATOR_LABELS[op].slice(1)}</option>)}
        </select>

        <span />
        <div className="flex gap-2">
          <select aria-label="Compare with" value={targetKey} onChange={(e) => setTargetKey(e.target.value)} className={`${field} ${targetKey === 'value' ? 'w-28 shrink-0' : ''}`}>
            <option value="value">Value</option>
            {targets.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          {targetKey === 'value' && (
            <input aria-label="Value" inputMode="decimal" value={value} required
              onChange={(e) => { setValue(e.target.value); setValueTouched(true); }}
              className={`${field} tabular`} />
          )}
        </div>

        <Label htmlFor="al-tf">Timeframe</Label>
        <select id="al-tf" value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={field}>
          {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <Label htmlFor="al-freq">Trigger</Label>
        <select id="al-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as AlertFrequency)} className={field}>
          {ALERT_FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
        </select>
        <span />
        <p className="-mt-1 text-xs text-[var(--muted)]">{FREQUENCY_HINTS[frequency]}</p>

        <Label htmlFor="al-exp">Expires</Label>
        <select id="al-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={field}>
          {editing?.expiresAt && <option value="keep">Keep: {new Date(editing.expiresAt).toLocaleString()}</option>}
          {EXPIRY.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>

        <Label htmlFor="al-msg">Message</Label>
        <input id="al-msg" value={message} maxLength={200} placeholder={preview} onChange={(e) => setMessage(e.target.value)} className={field} />

        <span className="self-start pt-0.5 text-[var(--muted)]">Notify</span>
        <div className="space-y-1.5 text-[13px]">
          <label className="flex items-center gap-2 text-[var(--muted)]"><input type="checkbox" checked disabled /> In the app (and as a desktop notification if allowed)</label>
          <label className={`flex items-center gap-2 ${emailVerified ? '' : 'text-[var(--muted)]'}`}>
            <input type="checkbox" checked={email && emailVerified} disabled={!emailVerified} onChange={(e) => setEmail(e.target.checked)} /> By email
          </label>
          {!emailVerified && (
            <p className="text-xs text-[var(--muted)]">
              Confirm your email first.{' '}
              <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => sendVerification()
                .then(() => toast({ tone: 'success', title: 'Confirmation email sent' }))
                .catch((err: Error) => toast({ tone: 'error', title: 'Could not send the email', body: err.message }))}>
                Send link
              </button>
            </p>
          )}
        </div>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-[#f23645]" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
        <button type="button" onClick={closeDialog} className="h-8 rounded border border-[var(--border)] px-4 text-sm hover:bg-[var(--hover)]">Cancel</button>
        <button disabled={busy} className="h-8 rounded bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : editing ? 'Save' : 'Create'}</button>
      </div>
    </form>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="text-[var(--muted)]">{children}</label>;
}
