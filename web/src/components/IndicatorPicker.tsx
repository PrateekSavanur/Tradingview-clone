import { INDICATORS, type IndicatorMeta } from '@chartdeck/indicators';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_INDICATORS, useIndicators } from '../store/indicators.ts';

export function IndicatorPicker() {
  const { pickerOpen, openPicker, add, list } = useIndicators();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // "/" opens the picker, as on most charting platforms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !t.closest('input, textarea, [contenteditable]')) {
        e.preventDefault();
        openPicker(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPicker]);

  useEffect(() => {
    if (pickerOpen) {
      setQ('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [pickerOpen]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? INDICATORS.filter((m) => `${m.name} ${m.short} ${m.description}`.toLowerCase().includes(needle))
      : INDICATORS;
  }, [q]);

  if (!pickerOpen) return null;
  const full = list.length >= MAX_INDICATORS;
  const choose = (m: IndicatorMeta | undefined) => {
    if (!m || full) return;
    add(m.id);
  };

  let lastCategory = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[8vh]" onMouseDown={() => openPicker(false)}>
      <div role="dialog" aria-label="Indicators" onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-base font-semibold">Indicators</h2>
          <button onClick={() => openPicker(false)} className="rounded px-1.5 text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="Close">✕</button>
        </div>
        <div className="border-b border-[var(--border)] px-4 py-2">
          <input ref={input} value={q} placeholder="Search, e.g. RSI, Bollinger, VWAP" spellCheck={false}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') choose(results[active]);
              else if (e.key === 'Escape') openPicker(false);
            }}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted)]" />
        </div>
        {full && <p className="px-4 py-2 text-xs text-amber-500">Limit of {MAX_INDICATORS} indicators reached. Remove one to add another.</p>}
        <ul className="overflow-y-auto py-1" role="listbox">
          {results.map((m, i) => {
            const header = !q && m.category !== lastCategory ? (lastCategory = m.category) : null;
            const count = list.filter((x) => x.type === m.id).length;
            return (
              <li key={m.id}>
                {header && <div className="px-4 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted)]">{header}</div>}
                <button role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(m)}
                  className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-sm ${i === active ? 'bg-[var(--hover)]' : ''}`}>
                  <span className="font-medium">{m.name}</span>
                  <span className="flex-1 truncate text-xs text-[var(--muted)]">{m.description}</span>
                  {count > 0 && <span className="rounded bg-[var(--accent)]/15 px-1.5 text-[11px] text-[var(--accent)]">{count} on chart</span>}
                  <span className="text-[11px] text-[var(--muted)]">{m.pane === 'overlay' ? 'overlay' : 'pane'}</span>
                </button>
              </li>
            );
          })}
          {!results.length && <li className="px-4 py-6 text-center text-sm text-[var(--muted)]">No indicators match “{q}”</li>}
        </ul>
        <p className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">Click to add; add the same indicator several times with different settings. Shortcut: /</p>
      </div>
    </div>
  );
}
