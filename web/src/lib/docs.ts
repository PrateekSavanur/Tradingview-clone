import { DOC_SCHEMAS, type DocKind } from '@chartdeck/shared';
import type { z } from 'zod';
import { authFetch, useAuth } from './auth.ts';

/**
 * User documents (`/api/docs/:kind/:name`): workspace, saved layouts, indicator templates and
 * watchlists. Signed in they live on the server; signed out, in this browser's localStorage.
 */

export type DocData<K extends DocKind> = z.infer<(typeof DOC_SCHEMAS)[K]>;
export interface DocEntry {
  name: string;
  updatedAt: number;
}

export class DocError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const LOCAL_PREFIX = 'chartdeck-doc:';
const localKey = (kind: DocKind, name: string) => `${LOCAL_PREFIX}${kind}:${name}`;
const docUrl = (kind: DocKind, name?: string) => `/api/docs/${kind}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
const signedIn = () => !!useAuth.getState().user;

function parse<K extends DocKind>(kind: K, data: unknown): DocData<K> | null {
  const r = DOC_SCHEMAS[kind].safeParse(data);
  return r.success ? (r.data as DocData<K>) : null;
}

function readLocal<K extends DocKind>(kind: K, name: string): { data: DocData<K>; updatedAt: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(localKey(kind, name)) ?? 'null') as { data?: unknown; updatedAt?: number } | null;
    const data = raw && parse(kind, raw.data);
    return data ? { data, updatedAt: raw.updatedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

function writeLocal(kind: DocKind, name: string, data: unknown): void {
  localStorage.setItem(localKey(kind, name), JSON.stringify({ data, updatedAt: Date.now() }));
}

function localNames(kind: DocKind): string[] {
  const prefix = `${LOCAL_PREFIX}${kind}:`;
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) names.push(key.slice(prefix.length));
  }
  return names;
}

async function failure(res: Response, what: string): Promise<DocError> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return new DocError(body.message ?? body.error ?? `${what}: ${res.status}`, res.status);
}

export async function listDocs(kind: DocKind): Promise<DocEntry[]> {
  if (!signedIn()) {
    return localNames(kind)
      .flatMap((name) => {
        const d = readLocal(kind, name);
        return d ? [{ name, updatedAt: d.updatedAt }] : [];
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  const res = await authFetch(docUrl(kind));
  if (!res.ok) throw await failure(res, `list ${kind}`);
  return (await res.json()) as DocEntry[];
}

export async function getDoc<K extends DocKind>(kind: K, name: string): Promise<DocData<K> | null> {
  if (!signedIn()) return readLocal(kind, name)?.data ?? null;
  const res = await authFetch(docUrl(kind, name));
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, `load ${kind}`);
  return parse(kind, ((await res.json()) as { data: unknown }).data);
}

export async function putDoc<K extends DocKind>(kind: K, name: string, data: DocData<K>, keepalive = false): Promise<void> {
  if (!signedIn()) {
    try {
      writeLocal(kind, name, data);
    } catch (err) {
      throw new DocError(`Could not save in this browser: ${(err as Error).message}`, 0);
    }
    return;
  }
  const res = await authFetch(docUrl(kind, name), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
    keepalive,
  });
  if (!res.ok) throw await failure(res, `save ${kind}`);
}

export async function deleteDoc(kind: DocKind, name: string): Promise<void> {
  if (!signedIn()) {
    localStorage.removeItem(localKey(kind, name));
    return;
  }
  const res = await authFetch(docUrl(kind, name), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await failure(res, `delete ${kind}`);
}

/**
 * After signing in, move named documents made while signed out into the account. A name that
 * is already taken there gets a " (local)" suffix rather than overwriting the account's copy.
 */
export async function importLocalDocs(kinds: DocKind[]): Promise<number> {
  let imported = 0;
  for (const kind of kinds) {
    const names = localNames(kind);
    if (!names.length) continue;
    const taken = new Set((await listDocs(kind)).map((d) => d.name));
    for (const name of names) {
      const local = readLocal(kind, name);
      if (local) {
        let target = name;
        if (taken.has(target)) target = `${name.slice(0, 56)} (local)`;
        if (taken.has(target)) continue; // already imported once; leave it in this browser
        await putDoc(kind, target, local.data);
        taken.add(target);
        imported++;
      }
      localStorage.removeItem(localKey(kind, name));
    }
  }
  return imported;
}

const SAVE_DEBOUNCE_MS = 600;

/**
 * A single document per user (`workspace`, `watchlists`). Every change is cached in localStorage
 * at once, which is also the whole store when signed out; signed in, it is also sent to the
 * server, debounced, with retries. On sign-in the account's copy wins if it has one.
 */
export class SingletonDoc<K extends DocKind> {
  private timer: number | undefined;
  private queued: DocData<K> | null = null;

  constructor(private readonly kind: K, private readonly cacheKey: string) {
    window.addEventListener('pagehide', () => this.flush(true));
  }

  /** Last state seen in this browser, signed in or not. */
  cached(): DocData<K> | null {
    try {
      return parse(this.kind, JSON.parse(localStorage.getItem(this.cacheKey) ?? 'null'));
    } catch {
      return null;
    }
  }

  private cache(data: DocData<K>): void {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(data));
    } catch (err) {
      console.warn(`[${this.kind}] could not cache locally`, err);
    }
  }

  save(data: DocData<K>): void {
    this.cache(data);
    if (!signedIn()) return;
    this.queued = data;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  /** True while a change is waiting to be sent. */
  get pending(): boolean {
    return this.queued !== null;
  }

  /** The account's copy, or null if it has none. Signed out, always null. */
  async loadRemote(): Promise<DocData<K> | null> {
    return signedIn() ? getDoc(this.kind, 'current') : null;
  }

  /**
   * Save `get()` whenever `subscribe` reports a change. Returns the sign-in step: adopt the
   * account's copy, unless there is none or the user edited while it was loading, in which case
   * the local state is uploaded instead.
   */
  bind(get: () => DocData<K>, set: (data: DocData<K>) => void, subscribe: (onChange: () => void) => () => void): () => Promise<void> {
    let applying = false;
    let edited = false;
    subscribe(() => {
      if (applying) return;
      edited = true;
      this.save(get());
    });
    return async () => {
      edited = false;
      const remote = await this.loadRemote();
      if (remote && !edited) {
        applying = true;
        try {
          set(remote);
        } finally {
          applying = false;
        }
        this.cache(remote);
      } else {
        this.save(get());
      }
    };
  }

  private flush(keepalive = false, attempt = 0): void {
    window.clearTimeout(this.timer);
    const data = this.queued;
    if (!data || !signedIn()) return;
    this.queued = null;
    putDoc(this.kind, 'current', data, keepalive).catch((err: unknown) => {
      console.warn(`[${this.kind}] save failed`, err);
      // Retry unless a newer change has been queued meanwhile; a 4xx won't get better.
      const status = err instanceof DocError ? err.status : 0;
      if (attempt < 5 && this.queued === null && (status === 0 || status >= 500)) {
        this.queued = data;
        this.timer = window.setTimeout(() => this.flush(false, attempt + 1), 2000 * (attempt + 1));
      }
    });
  }
}
