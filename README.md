# ChartDeck

Real-time market charting. Raw exchange trades are streamed in, folded into OHLCV candles for
every timeframe on the server, and pushed to the browser over a single WebSocket. Nothing on the
live path polls.

**Status: Phase 1 (live chart).** Indicators, drawing tools, workspaces, alerts, scripting and
paper trading are later phases.

## Architecture

```mermaid
flowchart LR
  subgraph Exchange
    BWS[Binance WS<br/>aggTrade]
    BREST[Binance REST<br/>klines, exchangeInfo]
  end
  subgraph ingest["ingest (1 replica)"]
    DP[data-providers] --> AGG[candle-aggregator<br/>12 TFs per symbol]
  end
  subgraph Redis
    CH[(pub/sub<br/>cd:c:&lt;symbol&gt;)]
    HOT[(hot candle cache<br/>cd:hot:&lt;symbol&gt;)]
    DEM[(demand sets<br/>cd:demand:&lt;gw&gt;)]
  end
  subgraph gw["ws-gateway (N replicas)"]
    HUB[fan-out hub<br/>backpressure, heartbeats]
  end
  subgraph api["api (N replicas)"]
    HIST[history + search]
  end
  TS[(TimescaleDB<br/>closed candles)]
  WEB[web<br/>React + Lightweight Charts]

  BWS --> DP
  BREST -- seed open candles --> DP
  AGG -- coalesced batch ≤25 ms --> CH
  AGG --> HOT
  CH --> HUB
  HOT -- prime new subscriber --> HUB
  HUB -- which symbols are watched --> DEM
  DEM -- union --> DP
  HUB <== one WebSocket ==> WEB
  WEB -- /api/history, /api/symbols --> HIST
  HIST <--> TS
  HIST --> BREST
```

**Live path.** `ingest` keeps one combined-stream WebSocket per provider and subscribes to
`<symbol>@aggTrade` only for symbols some gateway is watching. Each trade updates the open candle
of all 12 timeframes. Updates are coalesced (leading-edge throttle, `INGEST_FLUSH_MS`, default
25 ms) and published as one batch per symbol. Each gateway subscribes to a Redis channel once per
symbol, regardless of client count. It serialises each `(symbol, timeframe)` frame once per batch
and writes it to every interested socket.

**Seeding.** When a symbol is first streamed, or after an upstream reconnect, ingest fetches the
exchange's current kline for every timeframe over REST. Live trades are buffered meanwhile, then
replayed past the snapshot time, so the 1D/1W/1M candles open with the exchange's true O/H/L/V.

**Empty intervals.** Binance emits flat, zero-volume klines for seconds with no trades. The
aggregator rolls candles over on a 100 ms timer the same way, so live candles match history.

**History.** `api` serves `/api/history`. The newest page always comes from the provider because
it contains the open candle. Older pages come from TimescaleDB when the cached run is complete
and gap-free; otherwise the provider is queried and the closed candles are written back.
Identical concurrent requests share one upstream call. Binance's request-weight budget is tracked
from its response headers.

**Resilience.**
| Failure | Handling |
|---|---|
| Upstream socket drops | Exponential backoff with jitter; resubscribe; bump the provider *epoch*; re-seed every symbol. Proactive reconnect before Binance's 24 h cut-off. |
| Upstream silently dead | Ping every 15 s, terminate if no pong in 10 s. |
| Browser socket drops | Client backoff (0.5 s → 10 s with jitter), resubscribe, then backfill the gap from REST. |
| Ingest restarts | Epoch changes on every frame; charts see it and backfill. Gateways mark the provider `down` if status goes quiet for 25 s. |
| Slow browser | Above 256 KB buffered, frames are conflated (newest per stream only). Above 4 MB, or after 10 s stalled, the client is disconnected (1013) and reconnects. |
| Half-open TCP | Server pings every 15 s; client app-pings every 5 s and reconnects after 10 s without a pong. |

**Latency measurement.** Every frame carries `et` (exchange event time), `ri` (ingest receive),
`pi` (ingest publish), `xo` (exchange-minus-ingest clock offset) and `sg` (gateway send). The
browser estimates the gateway clock offset from its min-RTT ping. The debug panel (pulse icon in
the top bar) shows p50/p90/p99 per stage, including browser paint.

### Modules

```
packages/
  shared/             wire protocol, timeframes + bucket math, symbol ids (used by server and browser)
  data-providers/     MarketDataProvider interface; binance (REST + WS) and mock adapters
  candle-aggregator/  trades -> open candle for every timeframe; seeding; empty-interval roll-over
  service-kit/        logging (pino), env parsing, /healthz /readyz /metrics
services/
  ingest/             upstream streams -> aggregator -> Redis
  ws-gateway/         client WebSockets, fan-out, backpressure, rate limits, demand registry
  api/                history (read-through TimescaleDB cache) and symbol search
web/                  React + Vite + Zustand + Tailwind; ChartController owns Lightweight Charts
deploy/               Dockerfiles, nginx, k8s (kustomize), Prometheus, Grafana dashboard
test/integration/     end-to-end WebSocket flow against real processes + Redis
scripts/              build, dev runner, latency probe
```

## Running

### Everything in Docker

```sh
cp .env.example .env        # optional
docker compose up --build
open http://localhost:3000
```

Add the monitoring stack with `docker compose --profile monitoring up --build`. Grafana runs at
http://localhost:3001 and the *ChartDeck · Live data pipeline* dashboard is provisioned.

### Local development (hot reload)

```sh
npm install
docker compose up -d redis timescale   # Redis on 127.0.0.1:56379, Postgres on 127.0.0.1:55432
npm run dev                            # ingest, ws-gateway, api and Vite on http://localhost:5173
```

If Binance is blocked on your network, set `BINANCE_REST_URL=https://data-api.binance.vision`
and `BINANCE_WS_URL=wss://data-stream.binance.vision`. To work fully offline, set
`PROVIDERS=binance,mock` (or `mock`) and search for `TEST1`.

### Tests

```sh
npm test                    # unit: aggregation, bucket math, history cache, HA/hollow, backpressure, Binance mapping
npm run test:integration    # spawns ingest + ws-gateway with the mock provider; needs Redis (compose) on :56379
npm run typecheck
```

### Measuring latency

In the browser, open the debug panel with the pulse icon. From the command line:

```sh
node scripts/latency-probe.mjs ws://localhost:8080/ws binance:BTCUSDT 1s 30   # dev
node scripts/latency-probe.mjs ws://localhost:3000/ws binance:BTCUSDT 1s 30   # docker (through nginx)
```

### Kubernetes (k3s)

```sh
for s in ingest ws-gateway api; do
  docker build -f deploy/docker/service.Dockerfile --build-arg SERVICE=$s -t <registry>/chartdeck/$s:0.1.0 .
done
docker build -f deploy/docker/web.Dockerfile -t <registry>/chartdeck/web:0.1.0 .
# push, then point the `images:` entries in deploy/k8s/kustomization.yaml at <registry>

kubectl create namespace chartdeck
kubectl -n chartdeck create secret generic chartdeck-db --from-literal=password="$(openssl rand -base64 24)"
# edit ALLOWED_ORIGINS in deploy/k8s/config.yaml and the host in deploy/k8s/ingress.yaml
kubectl apply -k deploy/k8s
```

`ingest` must stay at exactly one replica, since two would publish every candle twice. Gateways
and the API scale horizontally. Pods carry `prometheus.io/*` scrape annotations.

## Adding a data provider

1. Implement `MarketDataProvider` (`packages/data-providers/src/types.ts`) in
   `packages/data-providers/src/<id>/`:
   - `getCandles(ticker, tf, { startTime?, endTime?, limit })` returns ascending candles.
     `endTime` is inclusive on open time.
   - `searchSymbols` / `getSymbol` return `SymbolInfo` with id `<provider>:<ticker>`.
   - `serverTime()` returns the provider clock, used for latency and seeding cut-offs.
   - `openStream(handlers)` returns a `TradeStream`. Call `onTrade` for every trade, `onState` on
     connection changes, and `onReconnected` after any gap, which triggers a re-seed.
     `setTickers` receives the full desired set; diff it and respect upstream rate limits.
   - Set `timeframes` to what the provider can serve history for.
2. Register it in `packages/data-providers/src/registry.ts` and add its env vars to `.env.example`.
   Provider API keys stay server-side; only `ingest` and `api` read them.
3. Add a mapping test like `packages/data-providers/test/binance-search.test.ts`, then enable it with `PROVIDERS=binance,<id>`.

Bucket boundaries come from `packages/shared/src/timeframes.ts`: UTC, with weeks opening on
Monday (the Binance convention). A provider whose sessions differ, such as NSE's 09:15 IST daily
open, needs session-aware bucketing there. That's planned with the NSE adapter.

## Known limitations (Phase 1)

- **Only Binance is implemented.** The NSE/BSE (Upstox / Angel One SmartAPI) and US-equity
  (Finnhub / Alpaca) adapters need API keys to build and test against, so they come once keys are
  available. The interface is ready for them.
- **Exchange → ingest dominates latency** and depends on where ingest runs relative to Binance's
  matching engine (AWS Tokyo). The stage also includes ±RTT/2 error from estimating the exchange
  clock over REST.
- **Seeding volume** can double-count trades from the ~RTT/2 window around the REST snapshot,
  and only in the candle that is open when a symbol starts streaming. Binance klines expose no
  trade ids to dedupe against.
- **Local-time axis** uses one UTC offset for the session, so intraday bars on the far side of a
  DST change are labelled one hour off. Daily and longer bars are always on UTC dates.
- **Scroll-back to listing date**: the deepest page is shorter than the page size, so it is never
  served from cache and always goes to the provider.
- **No auth yet.** JWT auth arrives with the first user-scoped feature (drawings, Phase 3). The
  gateway and API are already rate-limited and validate every input.
