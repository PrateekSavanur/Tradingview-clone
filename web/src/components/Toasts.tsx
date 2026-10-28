import { useToasts, type Toast } from '../store/toasts.ts';

const ICONS: Record<Toast['tone'], React.ReactNode> = {
  info: <path d="M12 8h.01M11 12h1v5h1" />,
  success: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  error: <path d="M12 7v6M12 17h.01" />,
  alert: <path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0" />,
};
const TONE: Record<Toast['tone'], string> = {
  info: 'text-[var(--accent)]',
  success: 'text-[var(--color-up)]',
  error: 'text-[var(--color-down)]',
  alert: 'text-amber-500',
};

/** Bottom-right notifications: alert fires, account messages. Announced to screen readers. */
export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-8 right-3 z-[60] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
          className="pointer-events-auto flex gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-[13px] shadow-xl">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`mt-px shrink-0 ${TONE[t.tone]}`} aria-hidden>
            {t.tone === 'info' || t.tone === 'error' ? <circle cx="12" cy="12" r="9" /> : null}
            {ICONS[t.tone]}
          </svg>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.title}</div>
            {t.body && <div className="mt-0.5 break-words text-xs text-[var(--muted)]">{t.body}</div>}
            {t.action && (
              <button className="mt-1.5 text-xs font-medium text-[var(--accent)] hover:underline" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--hover)]">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
