import type { LatencyStamps } from '@chartdeck/shared';

export const STAGES = ['upstream', 'ingest', 'fanout', 'network', 'render', 'total'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  upstream: 'Exchange → ingest',
  ingest: 'Ingest coalesce',
  fanout: 'Redis → gateway',
  network: 'Gateway → browser',
  render: 'Browser → paint',
  total: 'Exchange → screen',
};

export interface StageStats {
  p50: number;
  p90: number;
  p99: number;
  last: number;
}

const SIZE = 600;

/** Ring buffers of per-stage latency samples (ms). */
export class LatencyTracker {
  private readonly buf: Record<Stage, Float64Array> = Object.fromEntries(STAGES.map((s) => [s, new Float64Array(SIZE)])) as Record<Stage, Float64Array>;
  private n = 0;

  /**
   * @param receivedAt client-clock time the frame arrived
   * @param paintedAt client-clock time the frame was drawn
   * @param offset gateway clock minus client clock
   */
  record(lat: LatencyStamps, receivedAt: number, paintedAt: number, offset: number): void {
    const etServer = lat.et - lat.xo;
    const i = this.n++ % SIZE;
    this.buf.upstream[i] = lat.ri - etServer;
    this.buf.ingest[i] = lat.pi - lat.ri;
    this.buf.fanout[i] = lat.sg - lat.pi;
    this.buf.network[i] = receivedAt + offset - lat.sg;
    this.buf.render[i] = paintedAt - receivedAt;
    this.buf.total[i] = paintedAt + offset - etServer;
  }

  get count(): number {
    return this.n;
  }

  stats(): Record<Stage, StageStats> | null {
    const len = Math.min(this.n, SIZE);
    if (!len) return null;
    const last = (this.n - 1) % SIZE;
    const out = {} as Record<Stage, StageStats>;
    for (const s of STAGES) {
      const sorted = Array.from(this.buf[s].subarray(0, len)).sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(len - 1, Math.floor(p * len))]!;
      out[s] = { p50: q(0.5), p90: q(0.9), p99: q(0.99), last: this.buf[s][last]! };
    }
    return out;
  }

  reset(): void {
    this.n = 0;
  }
}
