import { LINE_DASHES, type DrawingStyle } from '@chartdeck/shared';
import { useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { TOOLS, isFibTool } from '../drawings/tools.ts';
import { useDrawings } from '../lib/useDrawings.ts';
import { FibLevelsEditor } from './FibLevelsEditor.tsx';
import { ToolIcon } from './ToolIcon.tsx';

const COLORS = ['#2962ff', '#089981', '#f23645', '#ff9800', '#ffeb3b', '#9c27b0', '#00bcd4', '#e91e63', '#787b86', '#d1d4dc', '#131722', '#ffffff'];
const FONT_SIZES = [12, 14, 18, 24, 32];

/** Floating style bar for the selected drawing. */
export function SelectionToolbar({ controller }: { controller: ChartController | null }) {
  const st = useDrawings(controller);
  const [palette, setPalette] = useState(false);
  const [levels, setLevels] = useState(false);
  const d = st?.selected;
  // Popovers belong to one drawing; selecting another closes them.
  useEffect(() => {
    setPalette(false);
    setLevels(false);
  }, [d?.id]);
  if (!controller || !d || st.editing) return null;
  const dm = controller.drawings;
  const def = TOOLS[d.type];
  const setStyle = (patch: Partial<DrawingStyle>) => dm.updateSelected({ style: { ...d.style, ...patch } });
  const locked = !!d.locked;
  const nextDash = LINE_DASHES[(LINE_DASHES.indexOf(d.style.dash) + 1) % LINE_DASHES.length]!;

  return (
    <div
      className="absolute left-1/2 top-12 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 text-xs shadow-lg"
      role="toolbar"
      aria-label={`${def.label} style`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="px-2 font-medium text-[var(--muted)]">{def.label}</span>
      <div className="relative">
        <IconBtn title="Colour" disabled={locked} onClick={() => { setPalette(!palette); setLevels(false); }}>
          <span className="h-4 w-4 rounded-sm border border-black/20" style={{ background: d.style.color }} />
        </IconBtn>
        {palette && !locked && (
          <div className="absolute left-0 top-9 grid w-max grid-cols-6 gap-1 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 shadow-xl">
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={c}
                onClick={() => {
                  setStyle({ color: c });
                  setPalette(false);
                }}
                className={`h-5 w-5 rounded-sm border ${c === d.style.color ? 'ring-2 ring-[var(--accent)]' : 'border-black/20'}`}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
      </div>
      {d.type === 'text' ? (
        <IconBtn title="Font size" disabled={locked} onClick={() => setStyle({ fontSize: FONT_SIZES[(FONT_SIZES.indexOf(d.style.fontSize ?? 14) + 1) % FONT_SIZES.length] })}>
          <span className="tabular w-7 text-center">{d.style.fontSize ?? 14}px</span>
        </IconBtn>
      ) : (
        <>
          <IconBtn title="Line width" disabled={locked} onClick={() => setStyle({ width: (d.style.width % 4) + 1 })}>
            <span className="flex w-7 items-center gap-1">
              <span className="w-3 rounded bg-current" style={{ height: d.style.width }} />
              <span className="tabular">{d.style.width}</span>
            </span>
          </IconBtn>
          <IconBtn title={`Line style: ${d.style.dash}`} disabled={locked} onClick={() => setStyle({ dash: nextDash })}>
            <svg width="22" height="8" viewBox="0 0 22 8">
              <path d="M1 4h20" stroke="currentColor" strokeWidth="2" strokeDasharray={d.style.dash === 'dashed' ? '5 3' : d.style.dash === 'dotted' ? '1.5 3' : undefined} />
            </svg>
          </IconBtn>
        </>
      )}
      {def.fillable && (
        <IconBtn title={d.style.fill === false ? 'Show background' : 'Hide background'} active={d.style.fill !== false} disabled={locked} onClick={() => setStyle({ fill: d.style.fill === false })}>
          <ToolIcon name="fill" size={16} />
        </IconBtn>
      )}
      {isFibTool(d.type) && (
        <div className="relative">
          <IconBtn title="Levels and range colours" active={levels} disabled={locked} onClick={() => { setLevels(!levels); setPalette(false); }}>
            <span className="flex items-center gap-1 px-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5h18M3 10h18M3 15h18M3 20h18" /></svg>
              Levels
            </span>
          </IconBtn>
          {levels && !locked && (
            <div className="absolute left-1/2 top-9 -translate-x-1/2">
              <FibLevelsEditor drawing={d} onChange={(lv) => dm.updateSelected({ levels: lv })} />
            </div>
          )}
        </div>
      )}
      {d.type === 'text' && (
        <IconBtn title="Edit text" disabled={locked} onClick={() => dm.editText(d.id)}>
          <ToolIcon name="edit" size={16} />
        </IconBtn>
      )}
      <div className="mx-0.5 h-5 w-px bg-[var(--border)]" />
      <IconBtn title={locked ? 'Unlock' : 'Lock'} active={locked} onClick={() => dm.updateSelected({ locked: !locked })}>
        <ToolIcon name={locked ? 'lock' : 'unlock'} size={16} />
      </IconBtn>
      <IconBtn title="Delete (Del)" onClick={() => dm.deleteSelected()}>
        <ToolIcon name="trash" size={16} />
      </IconBtn>
    </div>
  );
}

function IconBtn(props: { title: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-7 min-w-7 items-center justify-center rounded px-1 hover:bg-[var(--hover)] disabled:opacity-40 ${props.active ? 'text-[var(--accent)]' : ''}`}
    >
      {props.children}
    </button>
  );
}
