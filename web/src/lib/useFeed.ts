import { useSyncExternalStore } from 'react';
import { feed } from './feed.ts';

let version = 0;
const subscribe = (cb: () => void) =>
  feed.onChange(() => {
    version++;
    cb();
  });

/** Re-renders on connection-state and provider-status changes. */
export function useFeed() {
  useSyncExternalStore(subscribe, () => version);
  return feed;
}
