import { syncWatchlistsWithAccount } from '../store/watchlists.ts';
import { syncWorkspaceWithAccount } from '../store/workspace.ts';
import { useAuth } from './auth.ts';
import { importLocalDocs } from './docs.ts';

/**
 * Keep the workspace and watchlists in step with the account. Starting up signed in, or signing
 * in, the account's copies replace this browser's (or receive them if it has none); saved layouts
 * and templates made while signed out move into the account. Signing out keeps what's on screen.
 * Drawings are handled per chart (see App).
 */
export function wireAccountSync(): void {
  const sync = async (signedInNow: boolean) => {
    try {
      if (signedInNow) await importLocalDocs(['layouts', 'templates']);
      await Promise.all([syncWorkspaceWithAccount(), syncWatchlistsWithAccount()]);
    } catch (err) {
      console.warn('[account] sync failed', err);
    }
  };
  useAuth.subscribe((s, prev) => {
    if (!s.ready || !s.user) return;
    if (!prev.ready) void sync(false);
    else if (s.user.id !== prev.user?.id) void sync(true);
  });
}
