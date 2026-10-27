import { useEffect, useRef } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useDrawings } from '../lib/useDrawings.ts';

/** Inline editor for text drawings, placed exactly over the label. */
export function TextEditor({ controller }: { controller: ChartController | null }) {
  const st = useDrawings(controller);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const e = st?.editing;

  useEffect(() => {
    if (!e) return;
    done.current = false;
    ref.current?.focus();
    ref.current?.select();
  }, [e?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!controller || !e) return null;
  const commit = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    controller.drawings.commitText(e.id, text);
  };

  return (
    <textarea
      ref={ref}
      defaultValue={e.text}
      placeholder="Text"
      rows={Math.max(1, e.text.split('\n').length)}
      maxLength={500}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          commit(ev.currentTarget.value);
        } else if (ev.key === 'Escape') {
          commit(e.text ? null : '');
        }
      }}
      onBlur={(ev) => commit(ev.currentTarget.value)}
      className="absolute z-30 min-w-24 resize-none rounded-sm border border-[var(--accent)] bg-[var(--panel)]/90 px-1 py-0 leading-tight outline-none"
      style={{ left: e.x - 5, top: e.y - 4, color: e.color, fontSize: e.fontSize }}
      aria-label="Drawing text"
    />
  );
}
