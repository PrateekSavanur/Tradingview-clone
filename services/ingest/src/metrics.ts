import { prom } from '@chartdeck/service-kit';

const latencyBuckets = [1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 500, 1000, 2000];

export const metrics = {
  trades: new prom.Counter({ name: 'cd_ingest_trades_total', help: 'Raw trades received from upstream', labelNames: ['provider'] }),
  publishes: new prom.Counter({ name: 'cd_ingest_publishes_total', help: 'Candle batches published to Redis', labelNames: ['provider'] }),
  exchangeToIngest: new prom.Histogram({
    name: 'cd_ingest_exchange_to_ingest_ms', help: 'Exchange event time to ingest receive (clock-offset corrected)',
    labelNames: ['provider'], buckets: latencyBuckets,
  }),
  ingestToPublish: new prom.Histogram({
    name: 'cd_ingest_receive_to_publish_ms', help: 'Ingest receive to Redis publish (coalescing delay)',
    labelNames: ['provider'], buckets: latencyBuckets,
  }),
  reconnects: new prom.Counter({ name: 'cd_ingest_upstream_reconnects_total', help: 'Upstream stream reconnects', labelNames: ['provider'] }),
  upstreamUp: new prom.Gauge({ name: 'cd_ingest_upstream_live', help: '1 if the upstream stream is live', labelNames: ['provider'] }),
  symbols: new prom.Gauge({ name: 'cd_ingest_symbols', help: 'Symbols currently streamed', labelNames: ['provider'] }),
  seedSeconds: new prom.Histogram({
    name: 'cd_ingest_seed_seconds', help: 'Time to seed a symbol from REST', labelNames: ['provider'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  }),
  seedFailures: new prom.Counter({ name: 'cd_ingest_seed_failures_total', help: 'Timeframe seeds that failed', labelNames: ['provider'] }),
  clockOffset: new prom.Gauge({ name: 'cd_ingest_exchange_clock_offset_ms', help: 'Exchange clock minus local clock', labelNames: ['provider'] }),
};
