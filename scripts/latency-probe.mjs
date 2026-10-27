// Measures exchange-event -> client-receive latency through the full pipeline.
// Usage: node scripts/latency-probe.mjs [ws://localhost:8080/ws] [binance:BTCUSDT] [1s] [seconds]
import WebSocket from 'ws';

const [url = 'ws://localhost:8080/ws', symbol = 'binance:BTCUSDT', tf = '1s', secs = '20'] = process.argv.slice(2);
const ws = new WebSocket(url, { headers: { origin: 'http://localhost:5173' } });
let offset = 0; // gateway clock - local clock
let bestRtt = Infinity;
let lastEt = 0;
const samples = { total: [], upstream: [], ingest: [], fanout: [], toClient: [] };
let updates = 0;

ws.on('open', () => {
  const ping = () => ws.send(JSON.stringify({ op: 'ping', ct: Date.now() }));
  for (let i = 0; i < 5; i++) setTimeout(ping, i * 100);
  setInterval(ping, 2000);
  setTimeout(() => ws.send(JSON.stringify({ op: 'sub', symbol, tf })), 600);
  setTimeout(report, 600 + Number(secs) * 1000);
});

ws.on('message', (raw) => {
  const now = Date.now();
  const m = JSON.parse(raw.toString());
  if (m.t === 'pong') {
    const rtt = now - m.ct;
    if (rtt < bestRtt) {
      bestRtt = rtt;
      offset = m.st - (m.ct + rtt / 2);
    }
  } else if (m.t === 'c') {
    updates++;
    const { et, ri, pi, xo, sg } = m.lat;
    if (!et || et === lastEt) return; // roll-over without a new trade
    lastEt = et;
    const etLocal = et - xo; // exchange time on the server clock
    samples.upstream.push(ri - etLocal);
    samples.ingest.push(pi - ri);
    samples.fanout.push(sg - pi);
    samples.toClient.push(now + offset - sg);
    samples.total.push(now + offset - etLocal);
  } else if (m.t === 'error') {
    console.error('server error', m);
  }
});

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1) : '-';
}

function report() {
  console.log(`${symbol} ${tf}: ${updates} updates, ${samples.total.length} with new trades, clock-sync rtt ${bestRtt}ms`);
  console.log('stage                 p50     p90     p99     max');
  for (const [k, a] of Object.entries(samples)) {
    console.log(`${k.padEnd(18)} ${pct(a, 50).padStart(7)} ${pct(a, 90).padStart(7)} ${pct(a, 99).padStart(7)} ${pct(a, 100).padStart(7)}`);
  }
  process.exit(0);
}
