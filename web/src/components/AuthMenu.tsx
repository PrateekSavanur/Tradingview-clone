import { useEffect, useRef, useState } from 'react';
import { AuthError, requestPasswordReset, resetPassword, sendVerification, signIn, signOut, useAuth } from '../lib/auth.ts';
import { toast } from '../store/toasts.ts';
import { useUi } from '../store/ui.ts';

export function AuthMenu() {
  const { user, ready, available } = useAuth();
  const setAuthOpen = useUi((s) => s.setAuthOpen);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  if (!ready || !available) return null;

  if (!user) {
    return (
      <button onClick={() => setAuthOpen(true)} className="h-7 rounded bg-[var(--accent)] px-2.5 text-xs font-medium text-white hover:opacity-90" title="Sign in to sync drawings, layouts and watchlists and to create alerts">
        Sign in
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setMenu(!menu)}
        className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold uppercase text-white"
        aria-label={user.emailVerified ? 'Account' : 'Account (email not confirmed)'}
        aria-expanded={menu}
      >
        {user.email[0]}
        {!user.emailVerified && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--panel)] bg-amber-500" aria-hidden />}
      </button>
      {menu && (
        <div className="absolute right-0 top-9 z-40 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-sm shadow-xl">
          <div className="truncate px-3 py-1.5 font-medium">{user.email}</div>
          <div className="px-3 pb-2 text-xs text-[var(--muted)]">Drawings, layouts, watchlists and alerts are saved to your account.</div>
          {!user.emailVerified && (
            <div className="mx-2 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs">
              <p>Confirm your email to get alerts by email.</p>
              <button
                className="mt-1 font-medium text-[var(--accent)] hover:underline"
                onClick={async () => {
                  setMenu(false);
                  try {
                    await sendVerification();
                    toast({ tone: 'success', title: 'Confirmation email sent', body: `Open the link we sent to ${user.email}.` });
                  } catch (err) {
                    toast({ tone: 'error', title: 'Could not send the email', body: (err as Error).message });
                  }
                }}
              >
                Send confirmation link
              </button>
            </div>
          )}
          <div className="h-px bg-[var(--border)]" />
          <button
            onClick={() => {
              setMenu(false);
              void signOut();
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

type Mode = 'login' | 'register' | 'forgot';
const TITLES: Record<Mode, string> = { login: 'Sign in', register: 'Create account', forgot: 'Reset password' };

/** Sign in, create an account, or ask for a password-reset link. Opened through `useUi.authOpen`. */
export function AuthDialog() {
  const { authOpen, setAuthOpen } = useUi();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setAuthOpen(false);
    setError(null);
    setSent(false);
    setMode('login');
  };

  if (!authOpen) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email);
        setSent(true);
      } else {
        await signIn(mode, email, password);
        if (mode === 'register') toast({ tone: 'info', title: 'Account created', body: `We sent a confirmation link to ${email.trim().toLowerCase()}.` });
        close();
      }
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onMouseDown={close}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
        aria-label={TITLES[mode]}
      >
        <h2 className="mb-1 text-lg font-semibold">{TITLES[mode]}</h2>
        <p className="mb-4 text-xs text-[var(--muted)]">
          {mode === 'forgot'
            ? 'We’ll email you a link to choose a new password.'
            : 'Your drawings, layouts and watchlists sync across devices, and alerts keep running on the server. What you made while signed out moves into your account.'}
        </p>
        {sent ? (
          <p className="mb-4 rounded border border-[var(--border)] px-3 py-2.5 text-sm" role="status">
            If an account exists for <b>{email}</b>, a reset link is on its way. It works once, for one hour.
          </p>
        ) : (
          <>
            <label className="mb-3 block text-xs">
              <span className="mb-1 block text-[var(--muted)]">Email</span>
              <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="h-9 w-full rounded border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]" />
            </label>
            {mode !== 'forgot' && (
              <label className="mb-4 block text-xs">
                <span className="mb-1 flex justify-between text-[var(--muted)]">
                  <span>Password {mode === 'register' && '(8+ characters)'}</span>
                  {mode === 'login' && (
                    <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => { setMode('forgot'); setError(null); }}>
                      Forgot password?
                    </button>
                  )}
                </span>
                <input type="password" required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-9 w-full rounded border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]" />
              </label>
            )}
            {error && <p className="mb-3 text-xs text-[#f23645]" role="alert">{error}</p>}
            <button disabled={busy} className="h-9 w-full rounded bg-[var(--accent)] text-sm font-medium text-white disabled:opacity-60">
              {busy ? 'Please wait…' : mode === 'forgot' ? 'Send reset link' : TITLES[mode]}
            </button>
          </>
        )}
        <p className="mt-3 text-center text-xs text-[var(--muted)]">
          {mode === 'forgot' ? (
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => { setMode('login'); setSent(false); }}>Back to sign in</button>
          ) : (
            <>
              {mode === 'login' ? 'No account?' : 'Already have one?'}{' '}
              <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Create one' : 'Sign in'}
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

/** Opened by the emailed reset link (`/?reset=<token>`). */
export function ResetPasswordDialog({ token, onClose }: { token: string; onClose(): void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords don’t match');
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      toast({ tone: 'success', title: 'Password changed', body: 'Every device was signed out. Sign in with the new password.' });
      onClose();
      useUi.getState().setAuthOpen(true);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-9 w-full rounded border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl" aria-label="Choose a new password">
        <h2 className="mb-4 text-lg font-semibold">Choose a new password</h2>
        <label className="mb-3 block text-xs">
          <span className="mb-1 block text-[var(--muted)]">New password (8+ characters)</span>
          <input type="password" required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <label className="mb-4 block text-xs">
          <span className="mb-1 block text-[var(--muted)]">Repeat it</span>
          <input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        </label>
        {error && <p className="mb-3 text-xs text-[#f23645]" role="alert">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="h-9 flex-1 rounded border border-[var(--border)] text-sm hover:bg-[var(--hover)]">Cancel</button>
          <button disabled={busy} className="h-9 flex-1 rounded bg-[var(--accent)] text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </div>
  );
}
