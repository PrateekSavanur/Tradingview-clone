import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { Client, type ClientLimits } from '../src/client.ts';

const limits: ClientLimits = {
  softBufferBytes: 100, hardBufferBytes: 1000, maxStallMs: 10_000, maxSubscriptions: 2, msgRatePerSec: 10, msgBurst: 3,
};

function fakeSocket() {
  const sent: string[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (d: string) => sent.push(d) };
  return { ws, sent };
}

describe('Client backpressure', () => {
  it('writes directly while the socket is draining normally', () => {
    const { ws, sent } = fakeSocket();
    const c = new Client(ws as unknown as WebSocket, 'ip', limits);
    expect(c.sendCandle('A|1s', 'f1')).toBe(true);
    expect(sent).toEqual(['f1']);
  });

  it('conflates to the newest frame per stream while backed up, then flushes on drain', () => {
    const { ws, sent } = fakeSocket();
    const c = new Client(ws as unknown as WebSocket, 'ip', limits);
    ws.bufferedAmount = 500;
    c.sendCandle('A|1s', 'a1');
    c.sendCandle('A|1s', 'a2');
    c.sendCandle('B|1m', 'b1');
    expect(sent).toEqual([]);
    expect(c.stalledSince).not.toBeNull();

    expect(c.drain()).toBe(0); // still backed up
    ws.bufferedAmount = 0;
    expect(c.drain()).toBe(2);
    expect(sent).toEqual(['a2', 'b1']);
    expect(c.stalledSince).toBeNull();
  });

  it('keeps ordering: new frames queue behind pending ones even after the buffer drains', () => {
    const { ws, sent } = fakeSocket();
    const c = new Client(ws as unknown as WebSocket, 'ip', limits);
    ws.bufferedAmount = 500;
    c.sendCandle('A|1s', 'a1');
    ws.bufferedAmount = 0;
    c.sendCandle('A|1s', 'a2'); // must not jump ahead of the pending queue
    expect(sent).toEqual([]);
    c.drain();
    expect(sent).toEqual(['a2']);
  });

  it('rate-limits inbound messages with a token bucket', () => {
    const { ws } = fakeSocket();
    const c = new Client(ws as unknown as WebSocket, 'ip', limits);
    expect([c.takeToken(), c.takeToken(), c.takeToken(), c.takeToken()]).toEqual([true, true, true, false]);
  });
});
