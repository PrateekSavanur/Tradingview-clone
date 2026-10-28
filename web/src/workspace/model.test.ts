import { WorkspaceDoc, type SymbolInfo } from '@chartdeck/shared';
import { describe, expect, it } from 'vitest';
import * as M from './model.ts';

const eth: SymbolInfo = { ...M.DEFAULT_SYMBOL, id: 'binance:ETHUSDT', ticker: 'ETHUSDT', description: 'ETH / USDT' };
const sol: SymbolInfo = { ...M.DEFAULT_SYMBOL, id: 'binance:SOLUSDT', ticker: 'SOLUSDT', description: 'SOL / USDT' };
const rsi = { uid: 'rsi00001', type: 'rsi', inputs: { length: 14 }, plots: { rsi: { color: '#7e57c2', width: 2, visible: true } }, hidden: false };

const four = () => M.setLayout(M.defaultWorkspace(), '4');

describe('workspace model', () => {
  it('fills new cells with copies of the active chart, each with its own indicator uids', () => {
    let ws = M.patchChart(M.defaultWorkspace(), 0, { indicators: [rsi] });
    ws = M.setLayout(ws, '4');
    expect(ws.charts).toHaveLength(4);
    expect(ws.charts.every((c) => c.symbol.id === M.DEFAULT_SYMBOL.id && c.indicators[0]?.type === 'rsi')).toBe(true);
    expect(new Set(ws.charts.map((c) => c.indicators[0]!.uid)).size).toBe(4);
    expect(WorkspaceDoc.safeParse(ws).success).toBe(true);
  });

  it('keeps charts beyond a smaller layout so growing again restores them', () => {
    let ws = M.setSymbol(four(), 3, sol);
    ws = M.setActive(ws, 3);
    ws = M.setLayout(ws, '2');
    expect(ws.active).toBe(1);
    expect(M.visibleCount(ws)).toBe(2);
    expect(WorkspaceDoc.safeParse(ws).success).toBe(true);
    expect(M.setLayout(ws, '4').charts[3]!.symbol.id).toBe(sol.id);
  });

  it('only activates visible charts', () => {
    const ws = M.setLayout(four(), '2');
    expect(M.setActive(ws, 3)).toBe(ws);
    expect(M.setActive(ws, 1).active).toBe(1);
  });

  it('changes one chart unless symbol or interval sync is on, then every visible chart', () => {
    let ws = M.setSymbol(four(), 1, eth);
    expect(ws.charts.map((c) => c.symbol.ticker)).toEqual(['BTCUSDT', 'ETHUSDT', 'BTCUSDT', 'BTCUSDT']);
    ws = M.setTf(ws, 2, '1h');
    expect(ws.charts.map((c) => c.tf)).toEqual(['1m', '1m', '1h', '1m']);

    ws = M.setSync(ws, { symbol: true });
    // Turning the link on aligns everything with the active chart (0) right away.
    expect(ws.charts.every((c) => c.symbol.id === M.DEFAULT_SYMBOL.id)).toBe(true);
    ws = M.setSymbol(ws, 2, sol);
    expect(ws.charts.every((c) => c.symbol.id === sol.id)).toBe(true);
    expect(ws.charts.map((c) => c.tf)).toEqual(['1m', '1m', '1h', '1m']);

    ws = M.setSync(M.setActive(ws, 2), { interval: true });
    expect(ws.charts.every((c) => c.tf === '1h')).toBe(true);
  });

  it('leaves hidden charts alone when syncing', () => {
    let ws = M.setLayout(M.setSymbol(four(), 3, sol), '2');
    ws = M.setSymbol(M.setSync(ws, { symbol: true }), 0, eth);
    expect(ws.charts.map((c) => c.symbol.ticker)).toEqual(['ETHUSDT', 'ETHUSDT', 'BTCUSDT', 'SOLUSDT']);
  });

  it('returns the same object when nothing changes, so stores skip saving', () => {
    const ws = four();
    expect(M.setSymbol(ws, 0, M.DEFAULT_SYMBOL).charts[0]).toBe(ws.charts[0]);
    expect(M.setActive(ws, ws.active)).toBe(ws);
  });

  it('parses stored data defensively', () => {
    expect(M.parseWorkspace({ layout: '9' })).toBeNull();
    expect(M.parseWorkspace(null)).toBeNull();
    const ws = M.parseWorkspace({ ...M.defaultWorkspace(), layout: '1' });
    expect(ws?.charts).toHaveLength(1);
  });

  it('pads a saved layout that has fewer charts than cells and gives it fresh uids', () => {
    const saved = { ...M.defaultWorkspace(), layout: '3' as const, charts: [{ ...M.defaultChart(), indicators: [rsi] }] };
    const ws = M.loadLayout(saved);
    expect(ws.charts).toHaveLength(3);
    expect(ws.charts.some((c) => c.indicators[0]!.uid === rsi.uid)).toBe(false);
  });
});
