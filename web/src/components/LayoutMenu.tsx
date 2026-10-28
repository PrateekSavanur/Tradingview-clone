import { LAYOUTS, type LayoutKind, type WorkspaceDoc } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../store/workspace.ts';
import { NamedDocList } from './NamedDocList.tsx';

const LAYOUT_LABELS: Record<LayoutKind, string> = {
  '1': 'Single chart',
  '2': 'Two, side by side',
  '2v': 'Two, stacked',
  '3': 'Three: one large, two small',
  '4': 'Four (2 × 2)',
  '6': 'Six (3 × 2)',
};

const SYNC_LABELS: Array<{ key: keyof WorkspaceDoc['sync']; label: string; hint: string }> = [
  { key: 'symbol', label: 'Symbol', hint: 'Changing the symbol changes it on every chart' },
  { key: 'interval', label: 'Interval', hint: 'Changing the timeframe changes it on every chart' },
  { key: 'crosshair', label: 'Crosshair', hint: 'The crosshair follows the same time on every chart' },
  { key: 'time', label: 'Time', hint: 'Scrolling one chart scrolls the others to the same time' },
];

/** Grid choice, chart linking, and saved layouts. */
export function LayoutMenu() {
  const ws = useWorkspace((s) => s.ws);
  const { setLayout, setSync, load } = useWorkspace.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-[13px] hover:bg-[var(--hover)]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Layout and saved layouts"
      >
        <LayoutIcon layout={ws.layout} />
        <span className="hidden lg:inline">Layout</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Layout" className="absolute left-0 top-9 z-40 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-xl">
          <Heading>Layout</Heading>
          <div className="grid grid-cols-6 gap-1 px-3 pb-2">
            {LAYOUTS.map((l) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                aria-pressed={l === ws.layout}
                aria-label={LAYOUT_LABELS[l]}
                title={LAYOUT_LABELS[l]}
                className={`flex h-9 items-center justify-center rounded ${l === ws.layout ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'hover:bg-[var(--hover)]'}`}
              >
                <LayoutIcon layout={l} />
              </button>
            ))}
          </div>
          <Heading>Link charts</Heading>
          <div className="grid grid-cols-2 gap-x-2 px-3 pb-2 text-[13px]">
            {SYNC_LABELS.map(({ key, label, hint }) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-[var(--hover)]" title={hint}>
                <input type="checkbox" checked={ws.sync[key]} onChange={(e) => setSync({ [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <div className="border-t border-[var(--border)]">
            <Heading>Saved layouts</Heading>
            <NamedDocList
              kind="layouts"
              open={open}
              current={ws}
              placeholder="Save this layout as…"
              empty="No saved layouts yet. A saved layout keeps every chart’s symbol, timeframe, type and indicators."
              onLoad={(doc) => {
                load(doc);
                setOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted)]">{children}</div>;
}

/** Cell rectangles in a 16 × 12 box. */
const CELLS: Record<LayoutKind, Array<[number, number, number, number]>> = {
  '1': [[0, 0, 16, 12]],
  '2': [[0, 0, 8, 12], [8, 0, 8, 12]],
  '2v': [[0, 0, 16, 6], [0, 6, 16, 6]],
  '3': [[0, 0, 8, 12], [8, 0, 8, 6], [8, 6, 8, 6]],
  '4': [[0, 0, 8, 6], [8, 0, 8, 6], [0, 6, 8, 6], [8, 6, 8, 6]],
  '6': [[0, 0, 16 / 3, 6], [16 / 3, 0, 16 / 3, 6], [32 / 3, 0, 16 / 3, 6], [0, 6, 16 / 3, 6], [16 / 3, 6, 16 / 3, 6], [32 / 3, 6, 16 / 3, 6]],
};

function LayoutIcon({ layout }: { layout: LayoutKind }) {
  return (
    <svg width="18" height="14" viewBox="-1 -1 18 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      {CELLS[layout].map(([x, y, w, h], i) => <rect key={i} x={x} y={y} width={w} height={h} rx="1" />)}
    </svg>
  );
}
