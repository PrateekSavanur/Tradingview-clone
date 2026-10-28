import { useEffect, useRef, useState } from 'react';
import { AuthError, signIn, signOut, useAuth } from '../lib/auth.ts';

export function AuthMenu() {
  const { user, ready, available } = useAuth();
  const [dialog, setDialog] = useState(false);
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
      <>
        <button onClick={() => setDialog(true)} className="h-7 rounded bg-[var(--accent)] px-2.5 text-xs font-medium text-white hover:opacity-90" title="Sign in to sync drawings, layouts and watchlists across devices">
          Sign in
        </button>
        {dialog && <AuthDialog onClose={() => setDialog(false)} />}
      </>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setMenu(!menu)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold uppercase text-white"
        aria-label="Account"
        aria-expanded={menu}
      >
        {user.email[0]}
      </button>
      {menu && (
        <div className="absolute right-0 top-9 z-40 w-60 rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-sm shadow-xl">
          <div className="truncate px-3 py-1.5 font-medium">{user.email}</div>
          <div className="px-3 pb-2 text-xs text-[var(--muted)]">Drawings are saved to your account.</div>
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

function AuthDialog({ onClose }: { onClose(): void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(mode, email, password);
      onClose();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]" onMouseDown={onClose}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
        aria-label={mode === 'login' ? 'Sign in' : 'Create account'}
      >
        <h2 className="mb-1 text-lg font-semibold">{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <p className="mb-4 text-xs text-[var(--muted)]">Your drawings sync across devices. Drawings made while signed out are moved into your account.</p>
        <label className="mb-3 block text-xs">
          <span className="mb-1 block text-[var(--muted)]">Email</span>
          <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="h-9 w-full rounded border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]" />
        </label>
        <label className="mb-4 block text-xs">
          <span className="mb-1 block text-[var(--muted)]">Password {mode === 'register' && '(8+ characters)'}</span>
          <input type="password" required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-9 w-full rounded border border-[var(--border)] bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]" />
        </label>
        {error && <p className="mb-3 text-xs text-[#f23645]" role="alert">{error}</p>}
        <button disabled={busy} className="h-9 w-full rounded bg-[var(--accent)] text-sm font-medium text-white disabled:opacity-60">
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--muted)]">
          {mode === 'login' ? 'No account?' : 'Already have one?'}{' '}
          <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  );
}
