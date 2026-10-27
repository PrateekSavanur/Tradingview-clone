import type { DrawingType } from '@chartdeck/shared';

type IconName = DrawingType | 'cursor' | 'magnet' | 'eye' | 'eyeOff' | 'trash' | 'undo' | 'redo' | 'lock' | 'unlock' | 'edit' | 'fill';

const P: Record<IconName, React.ReactNode> = {
  cursor: <path d="M6 3l12 9-5.5 1L9.5 19 6 3z" />,
  trendline: <><path d="M5 19L19 5" /><circle cx="5" cy="19" r="1.8" /><circle cx="19" cy="5" r="1.8" /></>,
  ray: <><path d="M5 19L21 3" /><circle cx="5" cy="19" r="1.8" /><circle cx="12" cy="12" r="1.8" /></>,
  arrow: <><path d="M5 19L18 6" /><path d="M10 5.5h8.5V14" /></>,
  hline: <><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></>,
  vline: <><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,
  channel: <><path d="M3 15L15 4M9 20L21 9" /><path d="M6 17.5L18 6.5" strokeDasharray="2 2" /></>,
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  fib: <><path d="M3 5h18M3 9.5h18M3 13h18M3 19h18" /><path d="M5 19L19 5" strokeDasharray="2 2" /></>,
  fibext: <><path d="M3 4l6 10 4-6" strokeDasharray="2 2" /><path d="M12 6h9M12 11h9M12 16h9M12 20h9" /></>,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  measure: <><path d="M4 20L20 4" /><path d="M4 12v8h8" /><path d="M7 13v1M10 16v1M13 19v1" /></>,
  long: <><rect x="4" y="4" width="16" height="9" fill="currentColor" fillOpacity="0.2" /><rect x="4" y="13" width="16" height="7" /><path d="M4 13h16" /></>,
  short: <><rect x="4" y="4" width="16" height="7" /><rect x="4" y="11" width="16" height="9" fill="currentColor" fillOpacity="0.2" /><path d="M4 11h16" /></>,
  magnet: <path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4H6zM6 8h4M14 8h4" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.1 3.9M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.8 9.8 0 005.4-1.6" /><path d="M9.9 9.9a3 3 0 004.2 4.2" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" />,
  undo: <path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>,
  unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 017.5-2" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  fill: <><path d="M5 12l7-7 7 7-7 7-7-7z" fill="currentColor" fillOpacity="0.3" /><path d="M20 16s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z" /></>,
};

export function ToolIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {P[name]}
    </svg>
  );
}
