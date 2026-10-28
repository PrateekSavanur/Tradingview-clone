import { INDICATOR_BY_ID, sanitizeInputs } from '@chartdeck/indicators';
import { useEffect } from 'react';
import { useIndicators } from '../store/indicators.ts';

/** Inputs and style for one indicator instance. Changes apply live. */
export function IndicatorSettings() {
  const { editing, edit, list, update, remove } = useIndicators();
  const inst = list.find((i) => i.uid === editing);
  const meta = inst && INDICATOR_BY_ID.get(inst.type);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && edit(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, edit]);

  if (!inst || !meta) return null;

  const setInput = (key: string, value: string) => update(inst.uid, { inputs: sanitizeInputs(meta, { ...inst.inputs, [key]: value }) });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]" onMouseDown={() => edit(null)}>
      <div role="dialog" aria-label={`${meta.name} settings`} onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-base font-semibold">{meta.name}</h2>
          <button onClick={() => edit(null)} className="rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="Close">✕</button>
        </div>
        {meta.inputs.length > 0 && (
          <section className="border-b border-[var(--border)] px-4 py-3">
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">Inputs</h3>
            <div className="grid grid-cols-[1fr_9rem] items-center gap-x-3 gap-y-2 text-sm">
              {meta.inputs.map((def) => (
                <label key={def.key} className="contents">
                  <span>{def.label}</span>
                  {def.type === 'select' ? (
                    <select value={String(inst.inputs[def.key])} onChange={(e) => setInput(def.key, e.target.value)}
                      className="h-8 rounded border border-[var(--border)] bg-[var(--panel)] px-2 outline-none focus:border-[var(--accent)]">
                      {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type="number" min={def.min} max={def.max} step={def.type === 'float' ? def.step : 1}
                      defaultValue={Number(inst.inputs[def.key])}
                      onBlur={(e) => setInput(def.key, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && setInput(def.key, (e.target as HTMLInputElement).value)}
                      className="tabular h-8 rounded border border-[var(--border)] bg-transparent px-2 outline-none focus:border-[var(--accent)]" />
                  )}
                </label>
              ))}
            </div>
          </section>
        )}
        {meta.plots.length > 0 && (
          <section className="px-4 py-3">
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">Style</h3>
            <div className="space-y-2 text-sm">
              {meta.plots.map((p) => {
                const st = inst.plots[p.key] ?? { color: p.color, width: p.width ?? 2, visible: !p.hidden };
                const set = (patch: Partial<typeof st>) => update(inst.uid, { plots: { ...inst.plots, [p.key]: { ...st, ...patch } } });
                return (
                  <div key={p.key} className="flex items-center gap-3">
                    <input type="checkbox" checked={st.visible} onChange={(e) => set({ visible: e.target.checked })} aria-label={`Show ${p.label}`} />
                    <span className="flex-1">{p.label}</span>
                    {p.kind !== 'columns-signed' && (
                      <input type="color" value={st.color} onChange={(e) => set({ color: e.target.value })} aria-label={`${p.label} colour`}
                        className="h-7 w-9 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
                    )}
                    {(p.kind === 'line' || p.kind === 'steps' || p.kind === 'dots') && (
                      <select value={st.width} onChange={(e) => set({ width: Number(e.target.value) })} aria-label={`${p.label} width`}
                        className="h-7 rounded border border-[var(--border)] bg-[var(--panel)] px-1">
                        {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        <div className="flex justify-between border-t border-[var(--border)] px-4 py-3">
          <button onClick={() => remove(inst.uid)} className="rounded px-3 py-1.5 text-sm text-[#f23645] hover:bg-[var(--hover)]">Remove</button>
          <button onClick={() => edit(null)} className="rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white">Done</button>
        </div>
      </div>
    </div>
  );
}
