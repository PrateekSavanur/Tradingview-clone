import { useCallback, useEffect, useState } from 'react';
import type { ChartController } from './chart/ChartController.ts';
import { ChartView } from './components/ChartView.tsx';
import { DebugPanel } from './components/DebugPanel.tsx';
import { DrawingToolbar } from './components/DrawingToolbar.tsx';
import { IndicatorPicker } from './components/IndicatorPicker.tsx';
import { IndicatorSettings } from './components/IndicatorSettings.tsx';
import { SymbolSearch } from './components/SymbolSearch.tsx';
import { TopBar } from './components/TopBar.tsx';
import { importLocalDrawings } from './drawings/persistence.ts';
import { useAuth } from './lib/auth.ts';
import { useUi } from './store/ui.ts';

export function App() {
  const theme = useUi((s) => s.theme);
  const symbol = useUi((s) => s.symbol);
  const [controller, setController] = useState<ChartController | null>(null);
  const onController = useCallback((c: ChartController | null) => setController(c), []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    document.title = `${symbol.ticker} · ChartDeck`;
  }, [symbol.ticker]);

  // Drawings changed on another device show up when this tab regains focus, and every 30 s while visible.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && useAuth.getState().user) void controller?.drawings.refreshRemote();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    const t = window.setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.clearInterval(t);
    };
  }, [controller]);

  // Signing in moves signed-out drawings into the account; any sign-in/out switches the drawing source.
  useEffect(
    () =>
      useAuth.subscribe((s, prev) => {
        if (!prev.ready || s.user?.id === prev.user?.id) return;
        const reload = () => controller?.drawings.reload();
        if (s.user) importLocalDrawings().catch((err) => console.warn('[drawings] import failed', err)).finally(reload);
        else void reload();
      }),
    [controller],
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar controller={controller} />
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar controller={controller} />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ChartView onController={onController} />
          <DebugPanel controller={controller} />
        </main>
      </div>
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] text-[var(--muted)]">
        <span>{symbol.description} · {symbol.exchange}</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="hover:underline">
          Charts by TradingView Lightweight Charts™
        </a>
      </footer>
      <SymbolSearch />
      <IndicatorPicker />
      <IndicatorSettings />
    </div>
  );
}
