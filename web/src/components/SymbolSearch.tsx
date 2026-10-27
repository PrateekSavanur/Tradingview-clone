import type { SymbolInfo } from '@chartdeck/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { searchSymbols } from '../lib/api.ts';
import { useUi } from '../store/ui.ts';

export function SymbolSearch() {
  const { searchOpen, searchSeed, closeSearch, setSymbol } = useUi();
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
      searchSymbols(q.trim(), ctrl.signal)
        .then((r) => {
          setResults(r);
          setActive(0);
          setError(null);
        })
        .catch((e: Error) => e.name !== 'AbortError' && setError(e.message));
    }, 120);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [q, searchOpen]);

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
            placeholder="Search symbol, e.g. BTC, ETHUSDT"
            className="h-12 flex-1 bg-transparent text-base uppercase outline-none placeholder:normal-case placeholder:text-[var(--muted)]"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--muted)]">Esc</kbd>
        </div>
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
              <span className="w-32 shrink-0 font-semibold">{s.ticker}</span>
              <span className="flex-1 truncate text-[var(--muted)]">{s.description}</span>
              <span className="text-xs text-[var(--muted)]">{s.type}</span>
              <span className="w-16 text-right text-xs text-[var(--muted)]">{s.exchange}</span>
            </li>
          ))}
          {!results.length && !error && <li className="px-4 py-6 text-center text-sm text-[var(--muted)]">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--muted)]">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
