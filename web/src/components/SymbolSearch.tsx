import { MARKETS, MARKET_IDS, marketOfProvider, type MarketId, type SymbolInfo } from '@chartdeck/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { searchSymbols } from '../lib/api.ts';
import { displayTicker } from '../lib/format.ts';
import { useUi } from '../store/ui.ts';
import { useWatchlists } from '../store/watchlists.ts';
import { useWorkspace } from '../store/workspace.ts';

type Tab = MarketId | 'all';
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'all', label: 'All' }, ...MARKET_IDS.map((id) => ({ id, label: MARKETS[id].label }))];

const PLACEHOLDER: Record<Tab, string> = {
  all: 'Search symbol, e.g. BTC, RELIANCE, AAPL',
  crypto: 'Search crypto, e.g. BTC, ETHUSDT',
  india: 'Search NSE/BSE, e.g. RELIANCE, NIFTY, TCS',
  us: 'Search US stocks, e.g. AAPL, SPY, NVDA',
};

/** Short tag shown on results in the All tab. */
const MARKET_TAG: Record<MarketId, string> = { crypto: 'Crypto', india: 'IN', us: 'US' };

export function SymbolSearch() {
  const { searchOpen, searchSeed, searchTarget, closeSearch, searchMarket: tab, setSearchMarket: setTab } = useUi();
  const listName = useWatchlists((s) => s.doc.lists[s.doc.active]?.name);
  const setSymbol = (s: SymbolInfo) => {
    if (searchTarget === 'watchlist') useWatchlists.getState().add(s);
    else useWorkspace.getState().setSymbol(s);
    closeSearch();
  };
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    if (!searchOpen) return;
    setQ(searchSeed);
    setActive(0);
    input.current?.focus();
  }, [searchOpen, searchSeed]);

  useEffect(() => {
    if (!searchOpen) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      searchSymbols(q.trim(), tab, ctrl.signal)
        .then((r) => {
          setResults(r);
          setActive(0);
          setError(null);
        })
        .catch((e: Error) => e.name !== 'AbortError' && setError(e.message));
    }, tab === 'crypto' ? 120 : 350);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [q, searchOpen, tab]);

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!searchOpen) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && results[active]) {
      setSymbol(results[active]);
    } else if (e.key === 'Escape') {
      closeSearch();
    } else if (e.key === 'Tab') {
      // Tab / Shift+Tab cycle markets without leaving the box.
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab);
      setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh]" onMouseDown={closeSearch}>
      <div
        role="dialog"
        aria-label="Symbol search"
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4">
          <SearchIcon />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={searchTarget === 'watchlist' ? `Add to ${listName ?? 'watchlist'}` : PLACEHOLDER[tab]}
            className="h-12 flex-1 bg-transparent text-base uppercase outline-none placeholder:normal-case placeholder:text-[var(--muted)]"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted)] sm:inline">Esc</kbd>
          <button onClick={closeSearch} aria-label="Close search" className="flex h-8 w-8 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)] sm:hidden">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div role="tablist" aria-label="Market" className="flex shrink-0 gap-1 border-b border-[var(--border)] px-3 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => {
                setTab(t.id);
                input.current?.focus();
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${t.id === tab ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab !== 'all' && MARKETS[tab].dataNote && (
          <div className="border-b border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--muted)]">{MARKETS[tab].dataNote}</div>
        )}
        {error && <div className="px-4 py-3 text-sm text-[#f23645]">{error}</div>}
        <ul ref={list} className="overflow-y-auto py-1" role="listbox">
          {results.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => setSymbol(s)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm ${i === active ? 'bg-[var(--hover)]' : ''}`}
            >
              <span className="w-28 shrink-0 truncate font-semibold sm:w-32">{displayTicker(s)}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{s.description}</span>
              {tab === 'all' && <MarketTag market={marketOfProvider(s.provider)} />}
              <span className="hidden text-xs text-[var(--muted)] sm:inline">{s.type}</span>
              <span className="w-16 shrink-0 truncate text-right text-xs text-[var(--muted)]">{s.exchange}</span>
            </li>
          ))}
          {!results.length && !error && <li className="px-4 py-6 text-center text-sm text-[var(--muted)]">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

function MarketTag({ market }: { market: MarketId }) {
  return <span className="rounded bg-[var(--hover)] px-1.5 py-px text-[10px] font-medium text-[var(--muted)]">{MARKET_TAG[market]}</span>;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--muted)]">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
