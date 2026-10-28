import { DOC_NAME_RE, type DocKind } from '@chartdeck/shared';
import { useState } from 'react';
import type { DocData } from '../lib/docs.ts';
import { useNamedDocs } from '../lib/useNamedDocs.ts';

interface Props<K extends DocKind> {
  kind: K;
  open: boolean;
  /** Current state to save; null disables saving (with `cantSaveReason` shown). */
  current: DocData<K> | null;
  cantSaveReason?: string;
  placeholder: string;
  empty: string;
  onLoad(data: DocData<K>, name: string): void;
}

/** Saved documents of one kind: click to load, save the current state under a new or existing name. */
export function NamedDocList<K extends DocKind>({ kind, open, current, cantSaveReason, placeholder, empty, onLoad }: Props<K>) {
  const docs = useNamedDocs(kind, open);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const trimmed = name.trim();
  const valid = DOC_NAME_RE.test(trimmed);
  const exists = !!docs.entries?.some((e) => e.name === trimmed);

  const save = async () => {
    if (!current || !valid) return;
    await docs.save(trimmed, current);
    setName('');
  };

  return (
    <div className="text-[13px]">
      <ul className="max-h-56 overflow-y-auto">
        {docs.entries?.map((e) => (
          <li key={e.name} className="group flex items-center hover:bg-[var(--hover)]">
            <button
              className="flex-1 truncate px-3 py-1.5 text-left"
              title={`Open “${e.name}” (saved ${new Date(e.updatedAt).toLocaleString()})`}
              disabled={docs.busy}
              onClick={async () => {
                const data = await docs.load(e.name);
                if (data) onLoad(data, e.name);
              }}
            >
              {e.name}
            </button>
            {confirmDelete === e.name ? (
              <span className="flex items-center gap-1 pr-2 text-xs">
                <button className="rounded px-1.5 py-0.5 text-[#f23645] hover:bg-[var(--panel)]" onClick={() => void docs.remove(e.name).then(() => setConfirmDelete(null))}>Delete</button>
                <button className="rounded px-1.5 py-0.5 text-[var(--muted)] hover:bg-[var(--panel)]" onClick={() => setConfirmDelete(null)}>Keep</button>
              </span>
            ) : (
              <button
                aria-label={`Delete ${e.name}`}
                title="Delete"
                onClick={() => setConfirmDelete(e.name)}
                className="mr-1.5 flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] opacity-0 hover:bg-[var(--panel)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </li>
        ))}
        {docs.entries?.length === 0 && <li className="px-3 py-2 text-xs text-[var(--muted)]">{empty}</li>}
        {docs.entries === null && !docs.error && <li className="px-3 py-2 text-xs text-[var(--muted)]">Loading…</li>}
      </ul>
      <form
        className="flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          maxLength={64}
          disabled={!current}
          className="h-7 min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!current || !valid || docs.busy}
          className="h-7 shrink-0 rounded bg-[var(--accent)] px-2.5 text-xs font-medium text-white disabled:opacity-40"
          title={exists ? `Replace the saved “${trimmed}”` : undefined}
        >
          {exists ? 'Replace' : 'Save'}
        </button>
      </form>
      {!current && cantSaveReason && <p className="px-3 pb-2 text-xs text-[var(--muted)]">{cantSaveReason}</p>}
      {docs.error && <p className="px-3 pb-2 text-xs text-[#f23645]" role="alert">{docs.error}</p>}
    </div>
  );
}
