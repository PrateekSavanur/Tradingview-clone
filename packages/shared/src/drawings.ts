import { z } from 'zod';

export const DRAWING_TYPES = [
  'trendline', 'ray', 'arrow', 'hline', 'vline', 'channel', 'rect', 'fib', 'fibext', 'text', 'measure', 'long', 'short',
] as const;
export type DrawingType = (typeof DRAWING_TYPES)[number];

/** Anchor points each drawing type stores. */
export const DRAWING_POINTS: Record<DrawingType, number> = {
  trendline: 2, ray: 2, arrow: 2, hline: 1, vline: 1, channel: 3, rect: 2,
  fib: 2, fibext: 3, text: 1, measure: 2, long: 3, short: 3,
};

export const MAX_DRAWINGS_PER_SYMBOL = 500;

/** `time` is epoch ms (timeframe-independent), `price` is in the symbol's quote units. */
export const DrawingPoint = z.object({ time: z.number().finite(), price: z.number().finite() });
export type DrawingPoint = z.infer<typeof DrawingPoint>;

export const LINE_DASHES = ['solid', 'dashed', 'dotted'] as const;

export const DrawingStyle = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().int().min(1).max(4),
  dash: z.enum(LINE_DASHES),
  fill: z.boolean().optional(),
  fontSize: z.number().int().min(8).max(48).optional(),
});
export type DrawingStyle = z.infer<typeof DrawingStyle>;

/** One line of a Fibonacci tool. A band between two visible levels takes the colour of the one farther from 0. */
export const FibLevel = z.object({
  value: z.number().finite().min(-10).max(10),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  visible: z.boolean(),
});
export type FibLevel = z.infer<typeof FibLevel>;
export const MAX_FIB_LEVELS = 24;

export const Drawing = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/),
    type: z.enum(DRAWING_TYPES),
    points: z.array(DrawingPoint).min(1).max(3),
    style: DrawingStyle,
    text: z.string().max(500).optional(),
    /** fib / fibext only; absent means the built-in levels. */
    levels: z.array(FibLevel).max(MAX_FIB_LEVELS).optional(),
    locked: z.boolean().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .refine((d) => d.points.length === DRAWING_POINTS[d.type], { message: 'wrong number of points for drawing type' });
export type Drawing = z.infer<typeof Drawing>;

export const DrawingSet = z.array(Drawing).max(MAX_DRAWINGS_PER_SYMBOL);
