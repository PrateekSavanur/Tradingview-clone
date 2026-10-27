import type { SymbolInfo, Timeframe } from '@chartdeck/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const CHART_TYPES = ['candles', 'hollow', 'heikin', 'bars', 'line', 'area'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  candles: 'Candles',
  hollow: 'Hollow candles',
  heikin: 'Heikin Ashi',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
};

export type Theme = 'dark' | 'light';

const DEFAULT_SYMBOL: SymbolInfo = {
  id: 'binance:BTCUSDT', provider: 'binance', ticker: 'BTCUSDT', description: 'BTC / USDT',
  exchange: 'Binance', type: 'crypto', tickSize: 0.01,
};

interface UiState {
  symbol: SymbolInfo;
  tf: Timeframe;
  chartType: ChartType;
  theme: Theme;
  debugOpen: boolean;
  searchOpen: boolean;
  /** Prefill for the search box when opened by typing on the chart. */
  searchSeed: string;
  setSymbol(s: SymbolInfo): void;
  setTf(tf: Timeframe): void;
  setChartType(t: ChartType): void;
  toggleTheme(): void;
  toggleDebug(): void;
  openSearch(seed?: string): void;
  closeSearch(): void;
}

const systemTheme: Theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      symbol: DEFAULT_SYMBOL,
      tf: '1m',
      chartType: 'candles',
      theme: systemTheme,
      debugOpen: false,
      searchOpen: false,
      searchSeed: '',
      setSymbol: (symbol) => set({ symbol, searchOpen: false }),
      setTf: (tf) => set({ tf }),
      setChartType: (chartType) => set({ chartType }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
      openSearch: (seed = '') => set({ searchOpen: true, searchSeed: seed }),
      closeSearch: () => set({ searchOpen: false, searchSeed: '' }),
    }),
    {
      name: 'chartdeck-ui',
      partialize: (s) => ({ symbol: s.symbol, tf: s.tf, chartType: s.chartType, theme: s.theme, debugOpen: s.debugOpen }),
    },
  ),
);
