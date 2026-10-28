import { MAX_FIB_LEVELS, type Drawing, type FibLevel } from '@chartdeck/shared';
import { useState } from 'react';
import { FIB_PRESETS, fibBands, fibLevelsOf, saveDefaultFibLevels, type FibTool } from '../drawings/tools.ts';
import { toast } from '../store/toasts.ts';

export const LEVEL_COLORS = ['#787b86', '#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#d1d4dc', '#131722'];

/** Pick which Fibonacci levels show, their values and colours; ranges follow the level colours. */
export function FibLevelsEditor({ drawing, onChange }: { drawing: Drawing; onChange(levels: FibLevel[]): void }) {
  const type = drawing.type as FibTool;
  const levels = fibLevelsOf(drawing);
  const [palette, setPalette] = useState<number | null>(null);
  // Rows keep their order while editing; sorted by value for display.
  const rows = levels.map((l, i) => ({ l, i })).sort((a, b) => a.l.value - b.l.value);
  const visible = rows.filter((r) => r.l.visible).map((r) => ({ level: r.l.value, color: r.l.color }));
  const set = (i: number, patch: Partial<FibLevel>) => onChange(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const fmt = (v: number) => String(Number(v.toFixed(3)));

  const addLevel = () => {
    const used = new Set(levels.map((l) => l.value));
    const value = [1.272, 1.414, 2, 3.618, 4.236, -0.272, -0.618].find((v) => !used.has(v)) ?? Math.max(...levels.map((l) => l.value), 0) + 0.5;
    onChange([...levels, { value, color: '#9c27b0', visible: true }]);
  };

  return (
    <div className="w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] text-xs shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-1 border-b border-[var(--border)] p-2">
        {FIB_PRESETS.map((p) => (
          <button key={p.id} title={p.hint} onClick={() => onChange(p.apply(levels, type))}
            className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]">
            {p.label}
          </button>
        ))}
      </div>

      <ul className="max-h-64 overflow-y-auto py-1">
        {rows.map(({ l, i }) => (
          <li key={i} className="relative flex items-center gap-2 px-2 py-0.5">
            <input type="checkbox" checked={l.visible} onChange={(e) => set(i, { visible: e.target.checked })} aria-label={`Show level ${fmt(l.value)}`} />
            <LevelInput value={l.value} onCommit={(value) => set(i, { value })} />
            <button aria-label={`Colour of level ${fmt(l.value)}`} title="Colour" onClick={() => setPalette(palette === i ? null : i)}
              className="h-5 w-5 shrink-0 rounded-sm border border-black/20" style={{ background: l.color }} />
            <span className={`flex-1 truncate ${l.visible ? '' : 'text-[var(--muted)] line-through'}`}>{l.value === 0 ? 'start' : l.value === 1 ? 'end' : ''}</span>
            <button aria-label={`Remove level ${fmt(l.value)}`} title="Remove" disabled={levels.length <= 1}
              onClick={() => onChange(levels.filter((_, j) => j !== i))}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-30">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
            {palette === i && (
              <div className="absolute right-8 top-6 z-10 grid grid-cols-6 gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 shadow-xl">
                {LEVEL_COLORS.map((c) => (
                  <button key={c} aria-label={c} onClick={() => { set(i, { color: c }); setPalette(null); }}
                    className={`h-5 w-5 rounded-sm border ${c === l.color ? 'ring-2 ring-[var(--accent)]' : 'border-black/20'}`} style={{ background: c }} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {visible.length > 1 && (
        <div className="border-t border-[var(--border)] px-2 py-2">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-[var(--muted)]">Ranges</div>
          <div className="flex flex-wrap gap-1">
            {fibBands(visible).map((b) => (
              <span key={`${b.from}-${b.to}`} className="tabular flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: `${b.color}26` }}>
                <span className="h-2 w-2 rounded-sm" style={{ background: b.color }} aria-hidden />
                {fmt(b.from)}–{fmt(b.to)}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] text-[var(--muted)]">A range takes the colour of the level farther from 0. Hiding a level merges its range into the next.</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-[var(--border)] px-2 py-1.5">
        <button onClick={addLevel} disabled={levels.length >= MAX_FIB_LEVELS} className="rounded px-1.5 py-0.5 text-[var(--accent)] hover:bg-[var(--hover)] disabled:opacity-40">+ Add level</button>
        <button
          title="New drawings of this tool start with these levels and colours"
          onClick={() => {
            saveDefaultFibLevels(type, levels);
            toast({ tone: 'success', title: 'Saved as default', body: `New ${type === 'fib' ? 'retracements' : 'extensions'} start with these levels.` });
          }}
          className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]"
        >
          Use as default
        </button>
      </div>
    </div>
  );
}

/** Level value, committed on blur or Enter so typing "0.7" doesn't create an undo step per key. */
function LevelInput({ value, onCommit }: { value: number; onCommit(v: number): void }) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(String(value));
  }
  const commit = () => {
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v) && v >= -10 && v <= 10) {
      if (v !== value) onCommit(v);
    } else {
      setText(String(value));
    }
  };
  return (
    <input value={text} inputMode="decimal" aria-label="Level" onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      className="tabular h-6 w-16 rounded border border-[var(--border)] bg-transparent px-1.5 outline-none focus:border-[var(--accent)]" />
  );
}
