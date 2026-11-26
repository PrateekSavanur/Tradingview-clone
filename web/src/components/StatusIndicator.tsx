import { MARKETS, isSessionOpen, marketOfProvider } from '@chartdeck/shared';
import { useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useFeed } from '../lib/useFeed.ts';
import { useActiveChart } from '../store/workspace.ts';

type Level = 'live' | 'delayed' | 'disconnected' | 'closed';

/** Above this median exchange→screen latency the feed is reported as delayed. */
const DELAYED_P50_MS = 1000;

/** In session but no price this long: treat as closed (exchange holiday or halt). */
const QUIET_MIN = 20;
const isQuiet = (c: ChartController | null) => {
  const t = c?.lastPriceTime;
  return t != null && Date.now() - t > QUIET_MIN * 60_000;
};

export function StatusIndicator({ controller }: { controller: ChartController | null }) {
  const feed = useFeed();
  const provider = useActiveChart().symbol.provider;
  const [p50, setP50] = useState<number | null>(null);
  const [, setNow] = useState(0);
  const market = marketOfProvider(provider);

  useEffect(() => {
    // A median over a handful of samples is noise (e.g. a symbol's first frame after seeding).
    const t = window.setInterval(() => {
      setP50(controller && controller.latency.count >= 10 ? (controller.latency.stats()?.total.p50 ?? null) : null);
      setNow(Date.now()); // re-evaluate market hours
    }, 1000);
    return () => window.clearInterval(t);
  }, [controller]);

  const upstream = feed.providers.get(provider)?.state;
  let level: Level;
  let reason: string;
  let label: string | null = null;
  const info = MARKETS[market];
  if (feed.state !== 'open') {
    level = 'disconnected';
    reason = feed.state === 'connecting' ? 'Connecting to server…' : `Reconnecting… ${feed.lastError ?? ''}`;
  } else if (info.session) {
    // Stocks are polled about once a minute, so exchange→screen latency is not the signal here.
    const s = info.session;
    const hours = `${s.open}–${s.close} ${s.tz.split('/')[1]!.replace('_', ' ')} time, Mon–Fri`;
    if (upstream === 'down') {
      level = 'delayed';
      label = 'Stale';
      reason = 'Yahoo Finance is not answering right now; showing the last data received';
    } else if (isSessionOpen(market) && !isQuiet(controller)) {
      level = 'live';
      label = 'Open';
      reason = `Market open (${hours}). ${info.dataNote}.`;
    } else {
      level = 'closed';
      label = 'Closed';
      reason = isSessionOpen(market)
        ? `No new prices for over ${QUIET_MIN} minutes during regular hours: likely an exchange holiday. ${info.dataNote}.`
        : `Market closed (regular hours ${hours}). ${info.dataNote}.`;
    }
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

  const dot = { live: 'bg-[var(--color-up)]', delayed: 'bg-amber-500', disconnected: 'bg-[var(--color-down)]', closed: 'bg-[var(--muted)]' }[level];
  label ??= { live: 'Live', delayed: 'Delayed', disconnected: 'Offline', closed: 'Closed' }[level];
  const ping = level === 'live' && !info.session;

  return (
    <div className="flex items-center gap-1.5 rounded px-2 py-1 text-xs" title={reason} aria-live="polite">
      <span className="relative flex h-2 w-2">
        {ping && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dot}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}
