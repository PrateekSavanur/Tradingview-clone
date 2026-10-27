// Runs every service plus the web dev server with prefixed output. Needs Redis (and optionally
// TimescaleDB) reachable at REDIS_URL / DATABASE_URL; `docker compose up -d redis timescale` provides both.
import { spawn } from 'node:child_process';

const env = {
  REDIS_URL: 'redis://localhost:56379',
  DATABASE_URL: 'postgres://chartdeck:chartdeck@localhost:55432/chartdeck',
  LOG_LEVEL: 'info',
  ...process.env,
};
const procs = [
  ['ingest', ['run', 'dev', '-w', 'services/ingest']],
  ['gateway', ['run', 'dev', '-w', 'services/ws-gateway']],
  ['api', ['run', 'dev', '-w', 'services/api']],
  ['web', ['run', 'dev', '-w', 'web']],
];
const colors = [36, 35, 33, 32];
const children = procs.map(([name, args], i) => {
  const child = spawn('npm', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colors[i]}m${name.padEnd(8)}\x1b[0m| `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with ${code}\n`));
  return child;
});
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
