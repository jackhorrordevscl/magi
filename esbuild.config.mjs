// Bundles the `magi` CLI binary (src/cli/main.ts, added in PR4/Phase 9)
// into a single executable file with esbuild. The Claude Code
// `PreToolUse` hook adapter (claude-code-hook/index.ts) is a separate,
// unbundled entrypoint — Claude Code invokes it directly via `node
// claude-code-hook/index.ts`, so it is intentionally not part of this
// bundle.
//
// The existsSync guard below is kept as a defensive fallback (harmless
// no-op) in case this script is ever run against an older checkout that
// predates src/cli/main.ts.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';

const entry = path.resolve('src/cli/main.ts');
const outfile = path.resolve('dist/magi.mjs');

if (!existsSync(entry)) {
  console.log(`[esbuild.config] Entrypoint not found at ${entry}. Skipping bundle.`);
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
