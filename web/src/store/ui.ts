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
export type SidePanel = 'watchlist' | 'alerts';

/** App chrome only; what each chart shows lives in the workspace store. */
interface UiState {
  theme: Theme;
  debugOpen: boolean;
  sidePanel: SidePanel | null;
  searchOpen: boolean;
  /** Prefill for the search box when opened by typing on the chart. */
  searchSeed: string;
  searchTarget: SearchTarget;
  /** Sign-in dialog; anything that needs an account can open it. */
  authOpen: boolean;
  toggleTheme(): void;
  setAuthOpen(open: boolean): void;
  toggleDebug(): void;
  setSidePanel(p: SidePanel | null): void;
  /** Open `p`, or close the side panel if `p` is already showing. */
  toggleSidePanel(p: SidePanel): void;
  openSearch(seed?: string, target?: SearchTarget): void;
  closeSearch(): void;
}

const systemTheme: Theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: systemTheme,
      debugOpen: false,
      sidePanel: null,
      searchOpen: false,
      searchSeed: '',
      searchTarget: 'chart',
      authOpen: false,
      setAuthOpen: (authOpen) => set({ authOpen }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
      setSidePanel: (sidePanel) => set({ sidePanel }),
      toggleSidePanel: (p) => set((s) => ({ sidePanel: s.sidePanel === p ? null : p })),
      openSearch: (seed = '', target = 'chart') => set({ searchOpen: true, searchSeed: seed, searchTarget: target }),
      closeSearch: () => set({ searchOpen: false, searchSeed: '' }),
    }),
    {
      name: 'chartdeck-ui',
      partialize: (s) => ({ theme: s.theme, debugOpen: s.debugOpen, sidePanel: s.sidePanel }),
    },
  ),
);
