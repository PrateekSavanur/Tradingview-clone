import { MAX_WATCHLISTS, MAX_WATCHLIST_SYMBOLS, type SymbolInfo, type WatchlistsDoc } from '@chartdeck/shared';
import { create } from 'zustand';
import { SingletonDoc } from '../lib/docs.ts';
import { DEFAULT_SYMBOL } from '../workspace/model.ts';

interface WatchlistState {
  doc: WatchlistsDoc;
  select(index: number): void;
  /** Add to the active list; a symbol already there is left in place. */
  add(symbol: SymbolInfo): void;
  remove(id: string): void;
  move(from: number, to: number): void;
  create(name: string): void;
  rename(index: number, name: string): void;
  /** The last list can't be deleted. */
  delete(index: number): void;
}

const defaults = (): WatchlistsDoc => ({
  active: 0,
  lists: [{
    name: 'Crypto',
    symbols: [
      DEFAULT_SYMBOL,
      { id: 'binance:ETHUSDT', provider: 'binance', ticker: 'ETHUSDT', description: 'ETH / USDT', exchange: 'Binance', type: 'crypto', tickSize: 0.01 },
    ],
  }],
});

const store = new SingletonDoc('watchlists', 'chartdeck-watchlists');

export const useWatchlists = create<WatchlistState>()((set) => {
  const update = (fn: (d: WatchlistsDoc) => WatchlistsDoc | null) => set((s) => {
    const doc = fn(s.doc);
    return doc && doc !== s.doc ? { doc } : s;
  });
  const editActive = (fn: (symbols: SymbolInfo[]) => SymbolInfo[] | null) =>
    update((d) => {
      const list = d.lists[d.active]!;
      const symbols = fn(list.symbols);
      return symbols && { ...d, lists: d.lists.map((l, i) => (i === d.active ? { ...l, symbols } : l)) };
    });

  return {
    doc: store.cached() ?? defaults(),
    select: (active) => update((d) => (active >= 0 && active < d.lists.length ? { ...d, active } : null)),
    add: (symbol) => editActive((syms) => (syms.some((s) => s.id === symbol.id) || syms.length >= MAX_WATCHLIST_SYMBOLS ? null : [...syms, symbol])),
    remove: (id) => editActive((syms) => syms.filter((s) => s.id !== id)),
    move: (from, to) =>
      editActive((syms) => {
        if (from === to || !syms[from] || to < 0 || to >= syms.length) return null;
        const next = syms.slice();
        next.splice(to, 0, ...next.splice(from, 1));
        return next;
      }),
    create: (name) =>
      update((d) => (d.lists.length >= MAX_WATCHLISTS ? null : { active: d.lists.length, lists: [...d.lists, { name: name.slice(0, 64), symbols: [] }] })),
    rename: (index, name) => update((d) => ({ ...d, lists: d.lists.map((l, i) => (i === index ? { ...l, name: name.slice(0, 64) } : l)) })),
    delete: (index) =>
      update((d) => {
        if (d.lists.length <= 1 || !d.lists[index]) return null;
        const lists = d.lists.filter((_, i) => i !== index);
        return { lists, active: Math.min(d.active > index ? d.active - 1 : d.active, lists.length - 1) };
      }),
  };
});

/** Call after sign-in: the account's watchlists replace this browser's, or receive them if it has none. */
export const syncWatchlistsWithAccount = store.bind(
  () => useWatchlists.getState().doc,
  (doc) => useWatchlists.setState({ doc }),
  (onChange) => useWatchlists.subscribe((s, prev) => s.doc !== prev.doc && onChange()),
);
