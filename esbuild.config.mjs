// Bundles the magi CLI / Claude Code hook binary into a single executable
// file with esbuild.
//
// TODO(PR4): the real entrypoint (src/cli/main.ts) is introduced by the
// Phase 9 hook adapter work unit. Until that file exists, this script is a
// safe no-op so `npm run build` never hard-fails on a fresh checkout of
// this PR's scope (Phases 1-4 only: data contracts, shell parser, severity
// classification, trivial allowlist).
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';

const entry = path.resolve('src/cli/main.ts');
const outfile = path.resolve('dist/magi.mjs');

if (!existsSync(entry)) {
  console.log(
    `[esbuild.config] Entrypoint not found at ${entry} (added in PR4 hook adapter). Skipping bundle.`,
  );
  process.exit(0);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  minify: false,
});

console.log(`[esbuild.config] Bundled ${entry} -> ${outfile}`);
