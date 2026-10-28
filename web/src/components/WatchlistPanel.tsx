import type { Candle, SymbolInfo } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import { getHistory } from '../lib/api.ts';
import { feed } from '../lib/feed.ts';
import { decimalsFor, formatPercent, formatPrice } from '../lib/format.ts';
import { useUi } from '../store/ui.ts';
import { useWatchlists } from '../store/watchlists.ts';
import { useActiveChart, useWorkspace } from '../store/workspace.ts';

/** If the stream hasn't delivered a first frame by then, fetch the day's bar over REST. */
const REST_FALLBACK_MS = 2000;

/** Symbol lists with live last price and change on the day; click a row to show it on the active chart. */
export function WatchlistPanel() {
  const { doc, select, remove, move, create, rename, delete: del } = useWatchlists();
  const activeId = useActiveChart().symbol.id;
  const list = doc.lists[doc.active]!;
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)] text-[13px]" aria-label="Watchlist">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
        {editing ? (
          <NameInput
            initial={editing === 'rename' ? list.name : ''}
            placeholder={editing === 'new' ? 'New list name' : 'List name'}
            onDone={(name) => {
              if (name) (editing === 'new' ? create(name) : rename(doc.active, name));
              setEditing(null);
            }}
          />
        ) : (
          <select
            value={doc.active}
            onChange={(e) => select(Number(e.target.value))}
            aria-label="Watchlist"
            className="h-7 min-w-0 flex-1 rounded bg-transparent px-1 font-semibold outline-none hover:bg-[var(--hover)]"
          >
            {doc.lists.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
          </select>
        )}
        <SmallBtn title="Add symbol" onClick={() => useUi.getState().openSearch('', 'watchlist')}>
          <path d="M12 5v14M5 12h14" />
        </SmallBtn>
        <ListMenu
          canDelete={doc.lists.length > 1}
          onNew={() => setEditing('new')}
          onRename={() => setEditing('rename')}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>
      {confirmDelete && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs">
          <span className="flex-1">Delete “{list.name}”?</span>
          <button className="rounded px-1.5 py-0.5 text-[#f23645] hover:bg-[var(--hover)]" onClick={() => { del(doc.active); setConfirmDelete(false); }}>Delete</button>
          <button className="rounded px-1.5 py-0.5 text-[var(--muted)] hover:bg-[var(--hover)]" onClick={() => setConfirmDelete(false)}>Keep</button>
        </div>
      )}
      <div className="grid shrink-0 grid-cols-[1fr_5.5rem_4rem] gap-x-2 px-3 py-1 text-[11px] text-[var(--muted)]">
        <span>Symbol</span>
        <span className="text-right">Last</span>
        <span className="text-right" title="Change since the daily bar opened (00:00 UTC for crypto)">Chg%</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {list.symbols.map((s, i) => (
          <Row
            key={s.id}
            symbol={s}
            current={s.id === activeId}
            dragging={dragFrom === i}
            onDragStart={() => setDragFrom(i)}
            onDragEnter={() => {
              if (dragFrom === null || dragFrom === i) return;
              move(dragFrom, i);
              setDragFrom(i);
            }}
            onDragEnd={() => setDragFrom(null)}
            onRemove={() => remove(s.id)}
          />
        ))}
        {!list.symbols.length && (
          <li className="px-3 py-6 text-center text-xs text-[var(--muted)]">
            Empty list.{' '}
            <button className="text-[var(--accent)] hover:underline" onClick={() => useUi.getState().openSearch('', 'watchlist')}>Add a symbol</button>
          </li>
        )}
      </ul>
    </aside>
  );
}

interface RowProps {
  symbol: SymbolInfo;
  current: boolean;
  dragging: boolean;
  onDragStart(): void;
  onDragEnter(): void;
  onDragEnd(): void;
  onRemove(): void;
}

function Row({ symbol, current, dragging, onDragStart, onDragEnter, onDragEnd, onRemove }: RowProps) {
  const ref = useRef<HTMLLIElement>(null);
  const bar = useDailyBar(symbol.id, ref);
  const d = decimalsFor(symbol.tickSize);
  const change = bar && bar.open ? ((bar.close - bar.open) / bar.open) * 100 : null;
  const up = change !== null && change >= 0;

  return (
    <li
      ref={ref}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      onClick={() => useWorkspace.getState().setSymbol(symbol)}
      title={`${symbol.description} · ${symbol.exchange}`}
      className={`group relative grid cursor-pointer grid-cols-[1fr_5.5rem_4rem] items-center gap-x-2 px-3 py-1.5 hover:bg-[var(--hover)] ${current ? 'bg-[var(--accent)]/10' : ''} ${dragging ? 'opacity-50' : ''}`}
    >
      <span className="truncate font-medium">{symbol.ticker}</span>
      <span className="tabular truncate text-right">{bar ? formatPrice(bar.close, d) : '–'}</span>
      <span className={`tabular text-right ${change === null ? 'text-[var(--muted)]' : up ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {change === null ? '–' : formatPercent(change)}
      </span>
      <button
        aria-label={`Remove ${symbol.ticker}`}
        title="Remove from list"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded bg-[var(--panel)] text-[var(--muted)] opacity-0 hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </li>
  );
}

/**
 * The current daily bar, streamed while the row is on screen. The gateway caps subscriptions per
 * connection, so off-screen rows of a long list don't subscribe.
 */
function useDailyBar(symbolId: string, ref: React.RefObject<HTMLElement | null>): Candle | null {
  const [bar, setBar] = useState<Candle | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  useEffect(() => {
    if (!visible) return;
    let got = false;
    const ctrl = new AbortController();
    const off = feed.subscribe(symbolId, '1D', (e) => {
      got = true;
      setBar(e.candle);
    });
    const t = window.setTimeout(() => {
      if (got) return;
      getHistory(symbolId, '1D', { limit: 1 }, ctrl.signal)
        .then((c) => !got && c.length && setBar(c[c.length - 1]!))
        .catch(() => {});
    }, REST_FALLBACK_MS);
    return () => {
      off();
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [symbolId, visible]);

  return bar;
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone(name: string | null): void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      value={v}
      maxLength={64}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() || null);
        else if (e.key === 'Escape') onDone(null);
      }}
      className="h-7 min-w-0 flex-1 rounded border border-[var(--accent)] bg-transparent px-1.5 outline-none"
    />
  );
}

function ListMenu({ canDelete, onNew, onRename, onDelete }: { canDelete: boolean; onNew(): void; onRename(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        fn();
      }}
      className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)] disabled:opacity-40"
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <SmallBtn title="List options" onClick={() => setOpen(!open)} expanded={open}>
        <circle cx="12" cy="5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="19" r="1" fill="currentColor" />
      </SmallBtn>
      {open && (
        <div role="menu" className="absolute right-0 top-8 z-40 w-40 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 shadow-xl">
          {item('New list…', onNew)}
          {item('Rename…', onRename)}
          {item('Delete list', onDelete, !canDelete)}
        </div>
      )}
    </div>
  );
}

function SmallBtn(props: { title: string; onClick(): void; expanded?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      aria-label={props.title}
      aria-expanded={props.expanded}
      onClick={props.onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{props.children}</svg>
    </button>
  );
}
