import { useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useFeed } from '../lib/useFeed.ts';
import { useUi } from '../store/ui.ts';

type Level = 'live' | 'delayed' | 'disconnected';

/** Above this median exchange→screen latency the feed is reported as delayed. */
const DELAYED_P50_MS = 1000;

export function StatusIndicator({ controller }: { controller: ChartController | null }) {
  const feed = useFeed();
  const provider = useUi((s) => s.symbol.provider);
  const [p50, setP50] = useState<number | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setP50(controller?.latency.stats()?.total.p50 ?? null), 1000);
    return () => window.clearInterval(t);
  }, [controller]);

  const upstream = feed.providers.get(provider)?.state;
  let level: Level;
  let reason: string;
  if (feed.state !== 'open') {
    level = 'disconnected';
    reason = feed.state === 'connecting' ? 'Connecting to server…' : `Reconnecting… ${feed.lastError ?? ''}`;
  } else if (upstream && upstream !== 'live') {
    level = 'delayed';
    reason = `Exchange feed ${upstream}`;
  } else if (p50 !== null && p50 > DELAYED_P50_MS) {
    level = 'delayed';
    reason = `Median latency ${Math.round(p50)} ms`;
  } else {
    level = 'live';
    reason = p50 !== null ? `Streaming · median ${Math.round(p50)} ms exchange → screen` : 'Streaming';
  }

  const dot = { live: 'bg-[var(--color-up)]', delayed: 'bg-amber-500', disconnected: 'bg-[var(--color-down)]' }[level];
  const label = { live: 'Live', delayed: 'Delayed', disconnected: 'Offline' }[level];

  return (
    <div className="flex items-center gap-1.5 rounded px-2 py-1 text-xs" title={reason} aria-live="polite">
      <span className="relative flex h-2 w-2">
        {level === 'live' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dot}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}
