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
  // `blessed` (the TUI's terminal library, loaded lazily via `await
  // import('blessed')` inside `runTui()` — src/cli/tui/app.ts) resolves its
  // widgets with a dynamic `require('./widgets/' + name)` that esbuild
  // cannot statically walk. `external` keeps it out of the bundle entirely
  // (never inlined, never loaded until `magi tui` actually runs) rather than
  // `packages: 'external'`, which would also eject `zod`/`@anthropic-ai/sdk`.
  external: ['blessed'],
});

console.log(`[esbuild.config] Bundled ${entry} -> ${outfile}`);
