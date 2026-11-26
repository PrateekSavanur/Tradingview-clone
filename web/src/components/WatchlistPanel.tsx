import { MARKETS, MARKET_IDS, marketOfProvider, type Candle, type MarketId, type SymbolInfo } from '@chartdeck/shared';
import { useEffect, useRef, useState } from 'react';
import { getHistory } from '../lib/api.ts';
import { feed } from '../lib/feed.ts';
import { displayTicker, decimalsFor, formatPercent, formatPrice } from '../lib/format.ts';
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
    <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label="Watchlist">
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
        <span className="text-right" title="Change from the previous close for stocks, since 00:00 UTC for crypto">Chg%</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {grouped(list.symbols).map(({ s, i, header }) => [
          header && (
            <li key={`h-${header}`} className="sticky top-0 z-10 bg-[var(--panel)] px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {MARKETS[header].label}
            </li>
          ),
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
          />,
        ])}
        {!list.symbols.length && (
          <li className="px-3 py-6 text-center text-xs text-[var(--muted)]">
            Empty list.{' '}
            <button className="text-[var(--accent)] hover:underline" onClick={() => useUi.getState().openSearch('', 'watchlist')}>Add a symbol</button>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Rows in market order (crypto, India, US), keeping the user's order within each market, with a
 * header before each market when the list mixes them. `i` is the index in the stored list.
 */
function grouped(symbols: SymbolInfo[]): Array<{ s: SymbolInfo; i: number; header: MarketId | null }> {
  const rows = symbols.map((s, i) => ({ s, i, m: MARKET_IDS.indexOf(marketOfProvider(s.provider)) }));
  rows.sort((a, b) => a.m - b.m || a.i - b.i);
  const mixed = new Set(rows.map((r) => r.m)).size > 1;
  return rows.map((r, k) => ({ s: r.s, i: r.i, header: mixed && (k === 0 || rows[k - 1]!.m !== r.m) ? MARKET_IDS[r.m]! : null }));
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
  const { bar, prevClose } = useDailyBar(symbol, ref);
  const d = decimalsFor(symbol.tickSize);
  const base = prevClose ?? bar?.open;
  const change = bar && base ? ((bar.close - base) / base) * 100 : null;
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
      onClick={() => {
        useWorkspace.getState().setSymbol(symbol);
        // On phones the list covers the chart; get out of the way once a symbol is picked.
        if (matchMedia('(max-width: 767px)').matches) useUi.getState().setSidePanel(null);
      }}
      title={`${symbol.description} · ${symbol.exchange}`}
      className={`group relative grid cursor-pointer grid-cols-[1fr_5.5rem_4rem] items-center gap-x-2 py-2.5 pl-3 pr-8 hover:bg-[var(--hover)] md:py-1.5 md:pr-3 ${current ? 'bg-[var(--accent)]/10' : ''} ${dragging ? 'opacity-50' : ''}`}
    >
      <span className="truncate font-medium">{displayTicker(symbol)}</span>
      <span className="tabular truncate text-right">{bar ? formatPrice(bar.close, d) : '–'}</span>
      <span className={`tabular text-right ${change === null ? 'text-[var(--muted)]' : up ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
        {change === null ? '–' : formatPercent(change)}
      </span>
      <button
        aria-label={`Remove ${displayTicker(symbol)}`}
        title="Remove from list"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100 md:opacity-0"
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
function useDailyBar(symbol: SymbolInfo, ref: React.RefObject<HTMLElement | null>): { bar: Candle | null; prevClose: number | null } {
  const symbolId = symbol.id;
  const [bar, setBar] = useState<Candle | null>(null);
  const [recent, setRecent] = useState<Candle[]>([]);
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
    // Stocks quote change against the previous session's close, as brokers do. Crypto has no
    // session, so its daily candle's open (00:00 UTC) is the reference.
    if (marketOfProvider(symbol.provider) !== 'crypto') {
      getHistory(symbolId, '1D', { limit: 5 }, ctrl.signal).then(setRecent).catch(() => {});
    }
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
  }, [symbolId, symbol.provider, visible]);

  const cur = bar ?? recent[recent.length - 1] ?? null;
  const prev = cur ? recent.filter((c) => c.time < cur.time).pop() : undefined;
  return { bar: cur, prevClose: prev?.close ?? null };
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
