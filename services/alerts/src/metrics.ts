import { prom } from '@chartdeck/service-kit';

export const metrics = {
  active: new prom.Gauge({ name: 'cd_alerts_active', help: 'Active alerts being evaluated' }),
  symbols: new prom.Gauge({ name: 'cd_alerts_symbols', help: 'Symbols with at least one active alert' }),
  fired: new prom.Counter({ name: 'cd_alerts_fired_total', help: 'Alerts fired', labelNames: ['frequency'] }),
  emails: new prom.Counter({ name: 'cd_alerts_emails_total', help: 'Alert emails', labelNames: ['result'] }),
  warmFailures: new prom.Counter({ name: 'cd_alerts_warm_failures_total', help: 'History fetches for indicator warm-up that failed' }),
  fireToPublish: new prom.Histogram({
    name: 'cd_alerts_trade_to_fire_ms', help: 'Exchange trade (ingest receive) to alert published',
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  }),
};
