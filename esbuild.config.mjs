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
  // No `banner` shebang here: esbuild already preserves a `#!`-prefixed
  // first line straight from the entry point (src/cli/main.ts already has
  // one). Adding a banner shebang on top of that duplicated the line,
  // producing a second, syntactically invalid `#!` on line 2 that Node
  // refuses to parse — breaking every `node dist/magi.mjs <command>`
  // invocation. Never caught by tests because they call `runMain()`
  // in-process against the unbundled source, never the built dist file.
  sourcemap: true,
  minify: false,
  // `blessed` (the TUI's terminal library, loaded lazily via `await
  // import('blessed')` inside `runTui()` — src/cli/tui/app.ts) resolves its
  // widgets with a dynamic `require('./widgets/' + name)` that esbuild
  // cannot statically walk. `external` keeps it out of the bundle entirely
  // (never inlined, never loaded until `magi tui` actually runs) — named
  // explicitly here rather than via `packages: 'external'`, which would
  // eject every dependency (`zod` included) instead of just this one.
  //
  // `@anthropic-ai/sdk` is also external — not for the same "large,
  // load-on-demand" reason as `blessed`, but because its Node runtime shim
  // (`_shims/node-runtime.mjs`) statically imports several CJS
  // dependencies (`node-fetch`, `agentkeepalive`, ...) that each do their
  // own internal `require(...)` with a value esbuild can't resolve
  // statically. Bundled, every one of those becomes esbuild's runtime
  // `__require2` shim, which throws for any target that wasn't itself
  // bundled — including plain Node builtins like `stream`/`http` — breaking
  // every `magi` subcommand the moment `AnthropicEvaluator` is reachable
  // (since `evaluator-config.ts`'s backend table imports it
  // unconditionally). Externalizing one transitive dep at a time chases an
  // open-ended list (`node-fetch` today, `agentkeepalive` next, ...);
  // externalizing the SDK itself leaves its whole dependency tree to Node's
  // own, actually-working module resolution instead of esbuild's.
  external: ['blessed', '@anthropic-ai/sdk'],
});

console.log(`[esbuild.config] Bundled ${entry} -> ${outfile}`);
