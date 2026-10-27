// Bundles a service (run from its directory) into dist/index.js. Workspace packages
// (@chartdeck/*) are always inlined because they ship TypeScript sources. npm deps stay
// external for local builds; with BUNDLE_DEPS=1 (container images) they are inlined too, so the
// runtime image needs no node_modules. Optional native addons are never bundled.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const workspaceDeps = (name) => {
  const dir = name.replace('@chartdeck/', '');
  for (const root of ['packages', 'services']) {
    try {
      return JSON.parse(readFileSync(new URL(`../${root}/${dir}/package.json`, import.meta.url), 'utf8')).dependencies ?? {};
    } catch {}
  }
  return {};
};

const external = new Set();
const visit = (deps) => {
  for (const name of Object.keys(deps ?? {})) {
    if (name.startsWith('@chartdeck/')) visit(workspaceDeps(name));
    else external.add(name);
  }
};
visit(pkg.dependencies);

const OPTIONAL_NATIVE = ['pg-native', 'bufferutil', 'utf-8-validate'];
const bundleDeps = process.env.BUNDLE_DEPS === '1';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: bundleDeps ? OPTIONAL_NATIVE : [...external, ...OPTIONAL_NATIVE],
  // CommonJS deps inside an ESM bundle still call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
