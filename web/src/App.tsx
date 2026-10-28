import { useCallback, useEffect, useState } from 'react';
import type { ChartController } from './chart/ChartController.ts';
import { AlertDialog } from './components/AlertDialog.tsx';
import { AuthDialog, ResetPasswordDialog } from './components/AuthMenu.tsx';
import { ChartGrid } from './components/ChartGrid.tsx';
import { DebugPanel } from './components/DebugPanel.tsx';
import { DrawingToolbar } from './components/DrawingToolbar.tsx';
import { IndicatorPicker } from './components/IndicatorPicker.tsx';
import { IndicatorSettings } from './components/IndicatorSettings.tsx';
import { SymbolSearch } from './components/SymbolSearch.tsx';
import { SidePanel } from './components/SidePanel.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { importLocalDrawings } from './drawings/persistence.ts';
import { AuthError, useAuth, verifyEmail } from './lib/auth.ts';
import { useAlerts } from './store/alerts.ts';
import { toast } from './store/toasts.ts';
import { useUi } from './store/ui.ts';
import { useActiveChart, useWorkspace } from './store/workspace.ts';

export function App() {
  const theme = useUi((s) => s.theme);
  const sidePanel = useUi((s) => s.sidePanel);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const { symbol } = useActiveChart();
  const active = useWorkspace((s) => s.ws.active);
  const [controllers, setControllers] = useState<ReadonlyArray<ChartController | null>>([]);
  const onControllers = useCallback((cs: ReadonlyArray<ChartController | null>) => setControllers(cs), []);
  const controller = controllers[active] ?? null;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    document.title = `${symbol.ticker} · ChartDeck`;
  }, [symbol.ticker]);

  // Links from emails: /?verify=<token> confirms the address, /?reset=<token> opens the new-password dialog.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const verify = params.get('verify');
    const reset = params.get('reset');
    if (!verify && !reset) return;
    history.replaceState(null, '', location.pathname); // keep tokens out of history and later copies of the URL
    if (reset) setResetToken(reset);
    if (verify) {
      verifyEmail(verify)
        .then(() => toast({ tone: 'success', title: 'Email confirmed', body: 'Alerts can now notify you by email.' }))
        .catch((err) => toast({ tone: 'error', title: 'Could not confirm your email', body: err instanceof AuthError ? err.message : 'Could not reach the server' }));
    }
  }, []);

  // Typing a letter or digit anywhere outside a field opens symbol search for the active chart, prefilled.
  // Alt+A creates an alert for the active chart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyA') {
        e.preventDefault();
        useAlerts.getState().openCreate();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[a-z0-9]$/i.test(e.key)) {
        e.preventDefault();
        // Keys can land here before the dialog's input takes focus; keep them rather than restarting.
        const { searchOpen, searchSeed, searchTarget, openSearch } = useUi.getState();
        openSearch((searchOpen ? searchSeed : '') + e.key.toUpperCase(), searchOpen ? searchTarget : 'chart');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drawings changed on another device show up when this tab regains focus, and every 30 s while visible.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !useAuth.getState().user) return;
      for (const c of controllers) void c?.drawings.refreshRemote();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    const t = window.setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.clearInterval(t);
    };
  }, [controllers]);

  // Signing in moves signed-out drawings into the account; any sign-in/out switches the drawing source.
  useEffect(
    () =>
      useAuth.subscribe((s, prev) => {
        if (!prev.ready || s.user?.id === prev.user?.id) return;
        const reload = () => controllers.forEach((c) => void c?.drawings.reload());
        if (s.user) importLocalDrawings().catch((err) => console.warn('[drawings] import failed', err)).finally(reload);
        else reload();
      }),
    [controllers],
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar controller={controller} />
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar controller={controller} />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ChartGrid onControllers={onControllers} />
          <DebugPanel controller={controller} />
        </main>
        {sidePanel && <SidePanel panel={sidePanel} />}
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
      <AlertDialog controller={controller} />
      <AuthDialog />
      {resetToken && <ResetPasswordDialog token={resetToken} onClose={() => setResetToken(null)} />}
      <Toasts />
    </div>
  );
}
