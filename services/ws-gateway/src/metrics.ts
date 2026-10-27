import { prom } from '@chartdeck/service-kit';

export const metrics = {
  clients: new prom.Gauge({ name: 'cd_gateway_clients', help: 'Connected WebSocket clients' }),
  subscriptions: new prom.Gauge({ name: 'cd_gateway_subscriptions', help: 'Active (symbol, timeframe) subscriptions across clients' }),
  symbols: new prom.Gauge({ name: 'cd_gateway_symbols', help: 'Distinct symbols this gateway is subscribed to in Redis' }),
  framesSent: new prom.Counter({ name: 'cd_gateway_frames_sent_total', help: 'Frames written to client sockets' }),
  framesConflated: new prom.Counter({ name: 'cd_gateway_frames_conflated_total', help: 'Candle frames replaced by a newer one because the client was slow' }),
  slowDisconnects: new prom.Counter({ name: 'cd_gateway_slow_consumer_disconnects_total', help: 'Clients dropped for not draining their socket' }),
  rejected: new prom.Counter({ name: 'cd_gateway_rejected_total', help: 'Rejected connections or messages', labelNames: ['reason'] }),
  fanout: new prom.Histogram({
    name: 'cd_gateway_fanout_ms', help: 'Ingest publish to gateway socket write',
    buckets: [0.5, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000],
  }),
};
