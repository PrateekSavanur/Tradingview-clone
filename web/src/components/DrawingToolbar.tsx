import type { DrawingType } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { TOOLS } from '../drawings/tools.ts';
import { useDrawings } from '../lib/useDrawings.ts';
import { ToolIcon } from './ToolIcon.tsx';

const GROUPS: Array<{ id: string; label: string; tools: DrawingType[] }> = [
  { id: 'lines', label: 'Lines', tools: ['trendline', 'ray', 'arrow', 'hline', 'vline', 'channel'] },
  { id: 'fib', label: 'Fibonacci', tools: ['fib', 'fibext'] },
  { id: 'shapes', label: 'Shapes & text', tools: ['rect', 'text'] },
  { id: 'forecast', label: 'Forecasting & measurement', tools: ['long', 'short', 'measure'] },
];

export const SHORTCUTS: Partial<Record<DrawingType, string>> = {
  trendline: 'Alt+T', hline: 'Alt+H', vline: 'Alt+V', fib: 'Alt+F', rect: 'Alt+R', channel: 'Alt+P', measure: 'Alt+M',
};

export function DrawingToolbar({ controller }: { controller: ChartController | null }) {
  const st = useDrawings(controller);
  const [lastUsed, setLastUsed] = useState<Record<string, DrawingType>>(() => Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]!])));
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const dm = controller?.drawings;

  // Tools picked by keyboard shortcut also become their group's face.
  useEffect(() => {
    const t = st?.tool;
    const g = t && GROUPS.find((x) => x.tools.includes(t));
    if (g && t) setLastUsed((prev) => (prev[g.id] === t ? prev : { ...prev, [g.id]: t }));
  }, [st?.tool]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!dm || !st) return <aside className="w-11 shrink-0 border-r border-[var(--border)] bg-[var(--panel)]" />;

  const pick = (group: string, tool: DrawingType) => {
    setLastUsed((p) => ({ ...p, [group]: tool }));
    setOpen(null);
    dm.setTool(st.tool === tool ? null : tool);
  };

  return (
    <aside
      ref={ref}
      className="relative z-30 flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto overflow-x-visible border-r border-[var(--border)] bg-[var(--panel)] py-1.5 [scrollbar-width:none]"
      aria-label="Drawing tools"
    >
      <Btn title="Cursor (Esc)" active={!st.tool} onClick={() => dm.setTool(null)}>
        <ToolIcon name="cursor" />
      </Btn>
      <Sep />
      {GROUPS.map((g) => {
        const face = lastUsed[g.id]!;
        const activeInGroup = st.tool && g.tools.includes(st.tool) ? st.tool : null;
        return (
          <div key={g.id} className="group relative">
            <Btn
              title={`${TOOLS[activeInGroup ?? face].label}${SHORTCUTS[activeInGroup ?? face] ? ` (${SHORTCUTS[activeInGroup ?? face]})` : ''}`}
              active={!!activeInGroup}
              onClick={() => pick(g.id, activeInGroup ?? face)}
            >
              <ToolIcon name={activeInGroup ?? face} />
            </Btn>
            <button
              aria-label={`More ${g.label.toLowerCase()} tools`}
              aria-expanded={open === g.id}
              onClick={() => setOpen(open === g.id ? null : g.id)}
              className="absolute bottom-0.5 right-0 flex h-3.5 w-3 items-end justify-end text-[var(--muted)] opacity-60 hover:opacity-100 group-hover:opacity-100"
            >
              <svg width="6" height="6" viewBox="0 0 6 6"><path d="M6 0v6H0z" fill="currentColor" /></svg>
            </button>
            {open === g.id && (
              <div role="menu" className="fixed left-12 z-50 mt-[-38px] w-60 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-xl">
                <div className="px-3 pb-1 pt-0.5 text-[10.5px] uppercase tracking-wide text-[var(--muted)]">{g.label}</div>
                {g.tools.map((t) => (
                  <button
                    key={t}
                    role="menuitem"
                    onClick={() => pick(g.id, t)}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hover)] ${st.tool === t ? 'text-[var(--accent)]' : ''}`}
                  >
                    <ToolIcon name={t} />
                    <span className="flex-1">{TOOLS[t].label}</span>
                    {SHORTCUTS[t] && <span className="text-[11px] text-[var(--muted)]">{SHORTCUTS[t]}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <Sep />
      <Btn title="Magnet: snap to open/high/low/close" active={st.magnet} onClick={() => dm.setMagnet(!st.magnet)}>
        <ToolIcon name="magnet" />
      </Btn>
      <Btn title={st.hidden ? 'Show drawings' : 'Hide drawings'} active={st.hidden} onClick={() => dm.setHidden(!st.hidden)}>
        <ToolIcon name={st.hidden ? 'eyeOff' : 'eye'} />
      </Btn>
      <Btn title={`Remove all drawings (${st.count})`} disabled={!st.count} onClick={() => dm.removeAll()}>
        <ToolIcon name="trash" />
      </Btn>
      <div className="flex-1" />
      <Btn title="Undo (Ctrl+Z)" disabled={!st.canUndo} onClick={() => dm.undo()}>
        <ToolIcon name="undo" />
      </Btn>
      <Btn title="Redo (Ctrl+Shift+Z)" disabled={!st.canRedo} onClick={() => dm.redo()}>
        <ToolIcon name="redo" />
      </Btn>
    </aside>
  );
}

function Btn(props: { title: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-35 ${
        props.active ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text)] hover:bg-[var(--hover)]'
      }`}
    >
      {props.children}
    </button>
  );
}

function Sep() {
  return <div className="my-1 h-px w-6 shrink-0 bg-[var(--border)]" />;
}
