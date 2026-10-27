import { DrawingSet, type Drawing } from '@chartdeck/shared';
import { authFetch, authReady, useAuth } from '../lib/auth.ts';

/**
 * Signed out: drawings live in this browser's localStorage. Signed in: they are stored per user
 * per symbol on the server. Saves are debounced and the latest set per symbol wins.
 */
const LOCAL_PREFIX = 'chartdeck-drawings:';
const SAVE_DEBOUNCE_MS = 400;

const pending = new Map<string, { drawings: Drawing[]; timer: number }>();

function readLocal(symbol: string): Drawing[] {
  try {
    const parsed = DrawingSet.safeParse(JSON.parse(localStorage.getItem(LOCAL_PREFIX + symbol) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function writeLocal(symbol: string, drawings: Drawing[]): void {
  try {
    if (drawings.length) localStorage.setItem(LOCAL_PREFIX + symbol, JSON.stringify(drawings));
    else localStorage.removeItem(LOCAL_PREFIX + symbol);
  } catch (err) {
    console.warn('[drawings] could not save locally', err);
  }
}

async function fetchRemote(symbol: string): Promise<Drawing[]> {
  const res = await authFetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`load drawings: ${res.status}`);
  const parsed = DrawingSet.safeParse(((await res.json()) as { drawings: unknown }).drawings);
  return parsed.success ? parsed.data : [];
}

async function putRemote(symbol: string, drawings: Drawing[], keepalive = false): Promise<void> {
  const res = await authFetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drawings }),
    keepalive,
  });
  if (!res.ok) throw new Error(`save drawings: ${res.status}`);
}

export async function loadDrawings(symbol: string): Promise<Drawing[]> {
  // A save still waiting on its debounce is newer than anything stored.
  const queued = pending.get(symbol);
  if (queued) return queued.drawings;
  await authReady;
  return useAuth.getState().user ? fetchRemote(symbol) : readLocal(symbol);
}

export function saveDrawings(symbol: string, drawings: Drawing[]): void {
  const prev = pending.get(symbol);
  if (prev) window.clearTimeout(prev.timer);
  const timer = window.setTimeout(() => void flush(symbol), SAVE_DEBOUNCE_MS);
  pending.set(symbol, { drawings, timer });
}

async function flush(symbol: string, keepalive = false, attempt = 0): Promise<void> {
  const item = pending.get(symbol);
  if (!item) return;
  pending.delete(symbol);
  if (!useAuth.getState().user) {
    writeLocal(symbol, item.drawings);
    return;
  }
  try {
    await putRemote(symbol, item.drawings, keepalive);
  } catch (err) {
    console.warn('[drawings] save failed', err);
    // Retry unless a newer save for this symbol has been queued meanwhile.
    if (attempt < 5 && !pending.has(symbol)) {
      pending.set(symbol, { drawings: item.drawings, timer: window.setTimeout(() => void flush(symbol, false, attempt + 1), 2000 * (attempt + 1)) });
    }
  }
}

export function flushAll(): void {
  for (const [symbol, item] of pending) {
    window.clearTimeout(item.timer);
    void flush(symbol, true);
  }
}

/** After signing in, move drawings made while signed out into the account (merged by id, newest wins). */
export async function importLocalDrawings(): Promise<number> {
  const symbols: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(LOCAL_PREFIX)) symbols.push(key.slice(LOCAL_PREFIX.length));
  }
  let imported = 0;
  for (const symbol of symbols) {
    const local = readLocal(symbol);
    if (!local.length) continue;
    const merged = new Map((await fetchRemote(symbol)).map((d) => [d.id, d]));
    for (const d of local) {
      const existing = merged.get(d.id);
      if (!existing || existing.updatedAt < d.updatedAt) merged.set(d.id, d);
    }
    await putRemote(symbol, [...merged.values()]);
    localStorage.removeItem(LOCAL_PREFIX + symbol);
    imported += local.length;
  }
  return imported;
}

window.addEventListener('pagehide', flushAll);
