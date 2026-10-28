import { SOURCES, type IndicatorImpl } from './core.ts';
import * as L from './library.ts';
import type { IndicatorContext } from './library.ts';

export type InputDef =
  | { key: string; label: string; type: 'int'; default: number; min: number; max: number }
  | { key: string; label: string; type: 'float'; default: number; min: number; max: number; step: number }
  | { key: string; label: string; type: 'select'; default: string; options: readonly string[] };

export interface PlotDef {
  key: string;
  label: string;
  kind: 'line' | 'histogram' | 'columns-signed' | 'steps' | 'dots';
  color: string;
  width?: number;
  /** Bars to shift the plot by (Ichimoku cloud: +, lagging span: −). */
  offset?: (inputs: Record<string, number | string>) => number;
  /** Hidden by default, toggleable in settings. */
  hidden?: boolean;
}

export interface IndicatorMeta {
  id: string;
  name: string;
  short: string;
  description: string;
  category: 'Moving averages' | 'Bands & channels' | 'Oscillators' | 'Volume' | 'Trend & volatility' | 'Levels';
  pane: 'overlay' | 'separate';
  inputs: InputDef[];
  plots: PlotDef[];
  /** Fill between two plots; `colors` picks [above, below] when the first plot is above/below the second. */
  fills?: Array<{ from: string; to: string; color: string; colorBelow?: string }>;
  /** Horizontal reference lines in the indicator pane. */
  levels?: Array<{ value: number; color?: string }>;
  /** Band shaded between two levels (e.g. RSI 30–70). */
  levelFill?: { from: number; to: number; color: string };
  /** Rendered by the host from visible bars instead of per bar (volume profile). */
  special?: 'volume-profile';
  create?(inputs: Record<string, any>, ctx: IndicatorContext): IndicatorImpl<any>;
}

const src = (def = 'close'): InputDef => ({ key: 'source', label: 'Source', type: 'select', default: def, options: SOURCES });
const len = (def: number, label = 'Length', key = 'length'): InputDef => ({ key, label, type: 'int', default: def, min: 1, max: 1000 });
const float = (key: string, label: string, def: number, step = 0.1, max = 100): InputDef => ({ key, label, type: 'float', default: def, min: 0, max, step });
const line = (key: string, label: string, color: string, width = 2): PlotDef => ({ key, label, kind: 'line', color, width });

export const INDICATORS: IndicatorMeta[] = [
  // ---- moving averages
  { id: 'sma', name: 'Moving Average Simple', short: 'SMA', description: 'Arithmetic mean of the last N values', category: 'Moving averages', pane: 'overlay',
    inputs: [len(20), src()], plots: [line('ma', 'MA', '#2962ff')], create: (i) => L.sma(i as any) },
  { id: 'ema', name: 'Moving Average Exponential', short: 'EMA', description: 'Exponentially weighted, reacts faster than SMA', category: 'Moving averages', pane: 'overlay',
    inputs: [len(20), src()], plots: [line('ma', 'EMA', '#ff9800')], create: (i) => L.emaInd(i as any) },
  { id: 'wma', name: 'Moving Average Weighted', short: 'WMA', description: 'Linearly weighted towards recent bars', category: 'Moving averages', pane: 'overlay',
    inputs: [len(20), src()], plots: [line('ma', 'WMA', '#9c27b0')], create: (i) => L.wma(i as any) },
  { id: 'hma', name: 'Hull Moving Average', short: 'HMA', description: 'Low-lag MA from weighted averages', category: 'Moving averages', pane: 'overlay',
    inputs: [len(9), src()], plots: [line('ma', 'HMA', '#00bcd4')], create: (i) => L.hma(i as any) },
  { id: 'vwma', name: 'Volume Weighted Moving Average', short: 'VWMA', description: 'MA weighted by each bar’s volume', category: 'Moving averages', pane: 'overlay',
    inputs: [len(20), src()], plots: [line('ma', 'VWMA', '#e91e63')], create: (i) => L.vwma(i as any) },
  { id: 'vwap', name: 'Volume Weighted Average Price', short: 'VWAP', description: 'Anchored VWAP with standard-deviation bands', category: 'Moving averages', pane: 'overlay',
    inputs: [{ key: 'anchor', label: 'Anchor period', type: 'select', default: 'session', options: ['session', 'week', 'month'] }, src('hlc3'), float('mult', 'Band multiplier', 1)],
    plots: [line('vwap', 'VWAP', '#2962ff'), { ...line('upper', 'Upper band', '#4caf50', 1) }, { ...line('lower', 'Lower band', '#4caf50', 1) }],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(76, 175, 80, 0.06)' }], create: (i) => L.vwap(i as any) },

  // ---- bands & channels
  { id: 'bb', name: 'Bollinger Bands', short: 'BB', description: 'SMA ± N standard deviations', category: 'Bands & channels', pane: 'overlay',
    inputs: [len(20), src(), float('mult', 'StdDev', 2)],
    plots: [line('basis', 'Basis', '#ff6d00', 1), line('upper', 'Upper', '#2962ff', 1), line('lower', 'Lower', '#2962ff', 1)],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.08)' }], create: (i) => L.bollinger(i as any) },
  { id: 'kc', name: 'Keltner Channels', short: 'KC', description: 'EMA ± multiple of average true range', category: 'Bands & channels', pane: 'overlay',
    inputs: [len(20), float('mult', 'Multiplier', 2), len(10, 'ATR length', 'atrLength')],
    plots: [line('basis', 'Basis', '#2962ff', 1), line('upper', 'Upper', '#2962ff', 1), line('lower', 'Lower', '#2962ff', 1)],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.06)' }], create: (i) => L.keltner(i as any) },
  { id: 'dc', name: 'Donchian Channels', short: 'DC', description: 'Highest high and lowest low of N bars', category: 'Bands & channels', pane: 'overlay',
    inputs: [len(20)],
    plots: [line('basis', 'Basis', '#ff6d00', 1), line('upper', 'Upper', '#2962ff', 1), line('lower', 'Lower', '#2962ff', 1)],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.06)' }], create: (i) => L.donchian(i as any) },
  { id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', description: 'Conversion/base lines, leading spans and lagging span', category: 'Trend & volatility', pane: 'overlay',
    inputs: [len(9, 'Conversion line', 'conversion'), len(26, 'Base line', 'base'), len(52, 'Leading span B', 'spanB'), len(26, 'Displacement', 'displacement')],
    plots: [
      line('conversion', 'Conversion', '#2962ff', 1), line('base', 'Base', '#b71c1c', 1),
      { ...line('lagging', 'Lagging span', '#43a047', 1), offset: (i) => -(Number(i.displacement) - 1) },
      { ...line('spanA', 'Leading span A', '#a5d6a7', 1), offset: (i) => Number(i.displacement) - 1 },
      { ...line('spanB', 'Leading span B', '#ef9a9a', 1), offset: (i) => Number(i.displacement) - 1 },
    ],
    fills: [{ from: 'spanA', to: 'spanB', color: 'rgba(67, 160, 71, 0.12)', colorBelow: 'rgba(244, 67, 54, 0.12)' }],
    create: (i) => L.ichimoku(i as any) },
  { id: 'supertrend', name: 'Supertrend', short: 'Supertrend', description: 'ATR-based trailing stop that flips with trend', category: 'Trend & volatility', pane: 'overlay',
    inputs: [len(10, 'ATR length', 'atrLength'), float('factor', 'Factor', 3)],
    plots: [line('up', 'Up trend', '#089981'), line('down', 'Down trend', '#f23645')], create: (i) => L.supertrend(i as any) },
  { id: 'psar', name: 'Parabolic SAR', short: 'SAR', description: 'Stop-and-reverse trailing points', category: 'Trend & volatility', pane: 'overlay',
    inputs: [float('start', 'Start', 0.02, 0.01, 1), float('increment', 'Increment', 0.02, 0.01, 1), float('max', 'Maximum', 0.2, 0.01, 1)],
    plots: [{ key: 'sar', label: 'SAR', kind: 'dots', color: '#2962ff', width: 2 }], create: (i) => L.psar(i as any) },
  { id: 'pivots', name: 'Pivot Points Standard', short: 'Pivots', description: 'Support/resistance from the previous period', category: 'Levels', pane: 'overlay',
    inputs: [{ key: 'kind', label: 'Type', type: 'select', default: 'traditional', options: ['traditional', 'fibonacci', 'camarilla'] },
      { key: 'anchor', label: 'Pivots timeframe', type: 'select', default: 'auto', options: ['auto', 'day', 'week', 'month'] }],
    plots: [
      { key: 'r3', label: 'R3', kind: 'steps', color: '#f23645', width: 1 }, { key: 'r2', label: 'R2', kind: 'steps', color: '#f23645', width: 1 },
      { key: 'r1', label: 'R1', kind: 'steps', color: '#f23645', width: 1 }, { key: 'p', label: 'P', kind: 'steps', color: '#ff9800', width: 1 },
      { key: 's1', label: 'S1', kind: 'steps', color: '#089981', width: 1 }, { key: 's2', label: 'S2', kind: 'steps', color: '#089981', width: 1 },
      { key: 's3', label: 'S3', kind: 'steps', color: '#089981', width: 1 },
    ],
    create: (i, ctx) => L.pivots(i as any, ctx) },
  { id: 'vpvr', name: 'Volume Profile Visible Range', short: 'VPVR', description: 'Volume traded at each price over the visible bars', category: 'Volume', pane: 'overlay',
    inputs: [len(24, 'Row count', 'rows'), { key: 'valueArea', label: 'Value area %', type: 'int', default: 70, min: 1, max: 100 }],
    plots: [], special: 'volume-profile' },

  // ---- oscillators
  { id: 'rsi', name: 'Relative Strength Index', short: 'RSI', description: 'Momentum on a 0–100 scale (Wilder)', category: 'Oscillators', pane: 'separate',
    inputs: [len(14), src()], plots: [line('rsi', 'RSI', '#7e57c2')],
    levels: [{ value: 70 }, { value: 50 }, { value: 30 }], levelFill: { from: 30, to: 70, color: 'rgba(126, 87, 194, 0.08)' }, create: (i) => L.rsi(i as any) },
  { id: 'macd', name: 'MACD', short: 'MACD', description: 'Difference of fast and slow EMAs with signal line', category: 'Oscillators', pane: 'separate',
    inputs: [len(12, 'Fast length', 'fast'), len(26, 'Slow length', 'slow'), len(9, 'Signal smoothing', 'signal'), src()],
    plots: [{ key: 'hist', label: 'Histogram', kind: 'columns-signed', color: '#26a69a' }, line('macd', 'MACD', '#2962ff', 1.5), line('signal', 'Signal', '#ff6d00', 1.5)],
    levels: [{ value: 0 }], create: (i) => L.macd(i as any) },
  { id: 'stoch', name: 'Stochastic', short: 'Stoch', description: 'Close relative to the recent high-low range', category: 'Oscillators', pane: 'separate',
    inputs: [len(14, '%K length', 'kLength'), len(1, '%K smoothing', 'kSmooth'), len(3, '%D smoothing', 'dSmooth')],
    plots: [line('k', '%K', '#2962ff', 1.5), line('d', '%D', '#ff6d00', 1.5)],
    levels: [{ value: 80 }, { value: 20 }], levelFill: { from: 20, to: 80, color: 'rgba(33, 150, 243, 0.06)' }, create: (i) => L.stochastic(i as any) },
  { id: 'stochrsi', name: 'Stochastic RSI', short: 'Stoch RSI', description: 'Stochastic applied to RSI', category: 'Oscillators', pane: 'separate',
    inputs: [len(14, 'RSI length', 'rsiLength'), len(14, 'Stochastic length', 'stochLength'), len(3, 'K', 'kSmooth'), len(3, 'D', 'dSmooth'), src()],
    plots: [line('k', 'K', '#2962ff', 1.5), line('d', 'D', '#ff6d00', 1.5)],
    levels: [{ value: 80 }, { value: 20 }], levelFill: { from: 20, to: 80, color: 'rgba(33, 150, 243, 0.06)' }, create: (i) => L.stochRsi(i as any) },
  { id: 'cci', name: 'Commodity Channel Index', short: 'CCI', description: 'Deviation from the mean in units of mean deviation', category: 'Oscillators', pane: 'separate',
    inputs: [len(20), src('hlc3')], plots: [line('cci', 'CCI', '#2962ff', 1.5)],
    levels: [{ value: 100 }, { value: 0 }, { value: -100 }], levelFill: { from: -100, to: 100, color: 'rgba(33, 150, 243, 0.06)' }, create: (i) => L.cci(i as any) },
  { id: 'willr', name: 'Williams %R', short: '%R', description: 'Close relative to the high of the range, 0 to −100', category: 'Oscillators', pane: 'separate',
    inputs: [len(14)], plots: [line('r', '%R', '#7e57c2', 1.5)],
    levels: [{ value: -20 }, { value: -50 }, { value: -80 }], levelFill: { from: -80, to: -20, color: 'rgba(126, 87, 194, 0.08)' }, create: (i) => L.williamsR(i as any) },
  { id: 'roc', name: 'Rate Of Change', short: 'ROC', description: 'Percent change over N bars', category: 'Oscillators', pane: 'separate',
    inputs: [len(9), src()], plots: [line('roc', 'ROC', '#2962ff', 1.5)], levels: [{ value: 0 }], create: (i) => L.roc(i as any) },
  { id: 'mom', name: 'Momentum', short: 'Mom', description: 'Price change over N bars', category: 'Oscillators', pane: 'separate',
    inputs: [len(10), src()], plots: [line('mom', 'Momentum', '#2962ff', 1.5)], levels: [{ value: 0 }], create: (i) => L.momentum(i as any) },
  { id: 'aroon', name: 'Aroon', short: 'Aroon', description: 'Bars since the highest high / lowest low', category: 'Oscillators', pane: 'separate',
    inputs: [len(14)], plots: [line('up', 'Aroon Up', '#ff6d00', 1.5), line('down', 'Aroon Down', '#2962ff', 1.5)], create: (i) => L.aroon(i as any) },

  // ---- volume
  { id: 'obv', name: 'On Balance Volume', short: 'OBV', description: 'Cumulative volume signed by close direction', category: 'Volume', pane: 'separate',
    inputs: [], plots: [line('obv', 'OBV', '#2962ff', 1.5)], create: () => L.obv() },
  { id: 'mfi', name: 'Money Flow Index', short: 'MFI', description: 'Volume-weighted RSI of typical price', category: 'Volume', pane: 'separate',
    inputs: [len(14)], plots: [line('mfi', 'MF', '#7e57c2', 1.5)],
    levels: [{ value: 80 }, { value: 20 }], levelFill: { from: 20, to: 80, color: 'rgba(126, 87, 194, 0.08)' }, create: (i) => L.mfi(i as any) },
  { id: 'cmf', name: 'Chaikin Money Flow', short: 'CMF', description: 'Accumulation/distribution over N bars', category: 'Volume', pane: 'separate',
    inputs: [len(20)], plots: [{ key: 'cmf', label: 'CMF', kind: 'columns-signed', color: '#43a047' }], levels: [{ value: 0 }], create: (i) => L.cmf(i as any) },

  // ---- volatility
  { id: 'atr', name: 'Average True Range', short: 'ATR', description: 'Wilder-smoothed true range', category: 'Trend & volatility', pane: 'separate',
    inputs: [len(14)], plots: [line('atr', 'ATR', '#b71c1c', 1.5)], create: (i) => L.atr(i as any) },
  { id: 'adx', name: 'Directional Movement Index', short: 'DMI', description: 'ADX trend strength with +DI / −DI', category: 'Trend & volatility', pane: 'separate',
    inputs: [len(14, 'DI length', 'diLength'), len(14, 'ADX smoothing', 'adxSmoothing')],
    plots: [line('adx', 'ADX', '#f23645', 1.5), line('plusDI', '+DI', '#2962ff', 1), line('minusDI', '−DI', '#ff6d00', 1)],
    levels: [{ value: 25 }], create: (i) => L.adx(i as any) },
];

export const INDICATOR_BY_ID = new Map(INDICATORS.map((m) => [m.id, m]));

export function defaultInputs(meta: IndicatorMeta): Record<string, number | string> {
  return Object.fromEntries(meta.inputs.map((i) => [i.key, i.default]));
}

/** Clamp and coerce user-supplied inputs to the declared types and ranges. */
export function sanitizeInputs(meta: IndicatorMeta, raw: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const def of meta.inputs) {
    const v = raw[def.key];
    if (def.type === 'select') {
      out[def.key] = typeof v === 'string' && def.options.includes(v) ? v : def.default;
    } else {
      const num = Number(v);
      const x = Number.isFinite(num) ? Math.min(def.max, Math.max(def.min, num)) : def.default;
      out[def.key] = def.type === 'int' ? Math.round(x) : x;
    }
  }
  return out;
}
