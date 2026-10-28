import { CHART_TYPES, type ChartType } from '@chartdeck/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export { CHART_TYPES, type ChartType };
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  candles: 'Candles',
  hollow: 'Hollow candles',
  heikin: 'Heikin Ashi',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
};

export type Theme = 'dark' | 'light';
/** What a symbol picked in search is for. */
export type SearchTarget = 'chart' | 'watchlist';

/** App chrome only; what each chart shows lives in the workspace store. */
interface UiState {
  theme: Theme;
  debugOpen: boolean;
  watchlistOpen: boolean;
  searchOpen: boolean;
  /** Prefill for the search box when opened by typing on the chart. */
  searchSeed: string;
  searchTarget: SearchTarget;
  toggleTheme(): void;
  toggleDebug(): void;
  toggleWatchlist(): void;
  openSearch(seed?: string, target?: SearchTarget): void;
  closeSearch(): void;
}

const systemTheme: Theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: systemTheme,
      debugOpen: false,
      watchlistOpen: false,
      searchOpen: false,
      searchSeed: '',
      searchTarget: 'chart',
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
      toggleWatchlist: () => set((s) => ({ watchlistOpen: !s.watchlistOpen })),
      openSearch: (seed = '', target = 'chart') => set({ searchOpen: true, searchSeed: seed, searchTarget: target }),
      closeSearch: () => set({ searchOpen: false, searchSeed: '' }),
    }),
    {
      name: 'chartdeck-ui',
      partialize: (s) => ({ theme: s.theme, debugOpen: s.debugOpen, watchlistOpen: s.watchlistOpen }),
    },
  ),
);
