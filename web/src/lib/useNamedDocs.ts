import type { DocKind } from '@chartdeck/shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth.ts';
import { deleteDoc, getDoc, listDocs, putDoc, type DocData, type DocEntry } from './docs.ts';

/** Saved layouts or templates: listed while `open`, re-listed after every change or sign-in/out. */
export function useNamedDocs<K extends DocKind>(kind: K, open: boolean) {
  const userId = useAuth((s) => s.user?.id);
  const [entries, setEntries] = useState<DocEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listDocs(kind));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [kind]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, userId]);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      setError(null);
      return r;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return {
    entries,
    error,
    busy,
    save: (name: string, data: DocData<K>) => run(() => putDoc(kind, name, data)),
    remove: (name: string) => run(() => deleteDoc(kind, name)),
    load: (name: string) => run(() => getDoc(kind, name)),
  };
}
