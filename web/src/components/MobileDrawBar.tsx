import type { DrawingType } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { TOOLS } from '../drawings/tools.ts';
import { useDrawings } from '../lib/useDrawings.ts';
import { GROUPS } from './DrawingToolbar.tsx';
import { ToolIcon } from './ToolIcon.tsx';

/**
 * Drawing on phones, where the desktop's left toolbar doesn't fit: a floating pen button opens a
 * sheet with every tool and the drawing actions. While a tool is armed, a hint says how to place
 * it (tap, or press and drag for two-point tools) with a cancel button.
 */
export function MobileDrawBar({ controller }: { controller: ChartController | null }) {
  const st = useDrawings(controller);
  const dm = controller?.drawings;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  if (!dm || !st) return null;

  const pick = (t: DrawingType) => {
    dm.setTool(t);
    setOpen(false);
  };
  const tool = st.tool;

  return (
    <div ref={ref} className="md:hidden">
      {tool && (
        <div className="absolute left-1/2 top-2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] py-1 pl-3 pr-1 text-xs shadow-lg">
          <ToolIcon name={tool} />
          <span className="truncate">
            <b className="font-semibold">{TOOLS[tool].label}</b>
            <span className="text-[var(--muted)]"> · {TOOLS[tool].create ? 'tap the chart' : 'tap two points, or press and drag'}</span>
          </span>
          <button onClick={() => dm.setTool(null)} aria-label="Cancel drawing" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-[var(--hover)]">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      )}

      {open && (
        <div role="dialog" aria-label="Drawing tools" className="absolute bottom-16 left-2 right-2 z-40 max-h-[70%] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 shadow-2xl">
          {GROUPS.map((g) => (
            <section key={g.id} className="mb-3">
              <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">{g.label}</h3>
              <div className="grid grid-cols-3 gap-1.5">
                {g.tools.map((t) => (
                  <button
                    key={t}
                    onClick={() => pick(t)}
                    aria-pressed={tool === t}
                    className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[11px] leading-tight ${tool === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--hover)]/60 active:bg-[var(--hover)]'}`}
                  >
                    <ToolIcon name={t} />
                    <span className="text-center">{TOOLS[t].label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <div className="grid grid-cols-5 gap-1.5 border-t border-[var(--border)] pt-3">
            <Action label="Magnet" active={st.magnet} onClick={() => dm.setMagnet(!st.magnet)} icon="magnet" />
            <Action label={st.hidden ? 'Show' : 'Hide'} active={st.hidden} onClick={() => dm.setHidden(!st.hidden)} icon={st.hidden ? 'eyeOff' : 'eye'} />
            <Action label="Undo" disabled={!st.canUndo} onClick={() => dm.undo()} icon="undo" />
            <Action label="Redo" disabled={!st.canRedo} onClick={() => dm.redo()} icon="redo" />
            <Action label="Clear" disabled={!st.count} onClick={() => dm.removeAll()} icon="trash" />
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(!open)}
        aria-label="Drawing tools"
        aria-expanded={open}
        className={`absolute bottom-10 left-3 z-30 flex h-11 w-11 items-center justify-center rounded-full border shadow-lg ${tool || open ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] bg-[var(--panel)] text-[var(--text)]'}`}
      >
        {tool ? (
          <ToolIcon name={tool} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
          </svg>
        )}
      </button>
    </div>
  );
}

function Action({ label, icon, onClick, active, disabled }: { label: string; icon: Parameters<typeof ToolIcon>[0]['name']; onClick(): void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex flex-col items-center gap-1 rounded-lg py-1.5 text-[10.5px] disabled:opacity-35 ${active ? 'text-[var(--accent)]' : ''}`}
    >
      <ToolIcon name={icon} />
      {label}
    </button>
  );
}
