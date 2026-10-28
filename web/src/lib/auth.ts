import { create } from 'zustand';

export interface User {
  id: string;
  email: string;
  /** Alert emails only go to confirmed addresses. */
  emailVerified: boolean;
}

interface AuthState {
  user: User | null;
  /** First refresh attempt finished; until then we don't know if there's a session. */
  ready: boolean;
  /** False when the server has no database configured. */
  available: boolean;
}

export const useAuth = create<AuthState>(() => ({ user: null, ready: false, available: true }));

/** Access token lives only in memory; the refresh token is an httpOnly cookie. */
let accessToken: string | null = null;
let markReady: () => void;
/** Resolves once we know whether there is a session, so callers don't load the wrong data first. */
export const authReady = new Promise<void>((r) => (markReady = r));
let refreshing: Promise<boolean> | null = null;
let refreshTimer: number | undefined;

interface Session {
  user: User;
  accessToken: string;
  expiresIn: number;
}

function startSession(s: Session): void {
  accessToken = s.accessToken;
  useAuth.setState({ user: s.user });
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), Math.max(10, s.expiresIn - 60) * 1000);
}

function endSession(): void {
  accessToken = null;
  window.clearTimeout(refreshTimer);
  useAuth.setState({ user: null });
}

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 503) {
        useAuth.setState({ available: false });
        return false;
      }
      if (!res.ok) {
        if (res.status === 401) endSession();
        return false;
      }
      startSession((await res.json()) as Session);
      return true;
    } catch {
      return false; // network error: keep current state, try again later
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function initAuth(): Promise<void> {
  try {
    await refresh();
  } finally {
    useAuth.setState({ ready: true });
    markReady();
  }
}

/** fetch with the bearer token, refreshing once on 401. */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = () =>
    fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { ...(init.headers ?? {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    });
  let res = await go();
  if (res.status === 401 && (await refresh())) res = await go();
  return res;
}

export class AuthError extends Error {}

export async function signIn(mode: 'login' | 'register', email: string, password: string): Promise<void> {
  const res = await fetch(`/api/auth/${mode}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as Session & { message?: string; issues?: Array<{ message: string }> };
  if (!res.ok) {
    throw new AuthError(body.issues?.[0]?.message ?? body.message ?? (res.status === 429 ? 'Too many attempts, try again in a minute' : 'Sign-in failed'));
  }
  startSession(body);
}

async function postJson(path: string, body: unknown, auth = false): Promise<void> {
  const init: RequestInit = { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await (auth ? authFetch(path, init) : fetch(path, init));
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { message?: string; issues?: Array<{ message: string }> };
    throw new AuthError(b.issues?.[0]?.message ?? b.message ?? (res.status === 429 ? 'Too many attempts, try again later' : 'Something went wrong'));
  }
}

/** Re-read the user, e.g. after confirming the email in another tab. */
export async function reloadUser(): Promise<void> {
  if (!useAuth.getState().user) return;
  const res = await authFetch('/api/auth/me');
  if (res.ok) useAuth.setState({ user: ((await res.json()) as { user: User }).user });
}

export const sendVerification = () => postJson('/api/auth/verify/send', {}, true);

export async function verifyEmail(token: string): Promise<void> {
  await postJson('/api/auth/verify', { token });
  await reloadUser();
}

export const requestPasswordReset = (email: string) => postJson('/api/auth/password/forgot', { email });

/** Every session is signed out by a reset, this one included. */
export async function resetPassword(token: string, password: string): Promise<void> {
  await postJson('/api/auth/password/reset', { token, password });
  endSession();
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  endSession();
}
