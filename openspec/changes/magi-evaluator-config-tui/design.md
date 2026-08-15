# Design: Evaluator Config TUI

## Technical Approach

Five modules under a new `src/cli/tui/`, split so that **every rule lives in a pure, `node --test`-able module and `blessed` touches only one thin wiring file**. `config-file.ts` owns read/parse/atomic-write of `magi.config.json`; `effective-settings.ts` computes the displayed effective value of every unset field; `field-edit.ts` turns a raw keystroke buffer into an accepted value or an in-field error, using `EvaluatorsConfigSchema` as the sole judge; `audit-view.ts` builds the read-only view model over `computeAuditStats()`/`readChainRecords`; `app.ts` builds the `blessed` screen from those four.

Per the spec's Result Contract, the TUI **never calls `loadEvaluatorConfig()`** — it reads and parses the file itself and validates with the same exported schema, so the memoized loader (`evaluator-config.ts` design decision 7) is neither called nor changed. Confirmed at this module structure: `config-file.ts` is the only read path, so `evaluator-config-layer` needs **no delta spec** and gains no new export.

`src/cli/main.ts` gains one dispatch branch that `await import()`s `./tui/app.ts`; `esbuild.config.mjs` gains `external: ['blessed']`.

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Lazy loading | `main.ts` does `await import('./tui/app.ts')` inside the `tui` branch; `app.ts` does `await import('blessed')` **inside `runTui()`**, never at module top | Static `import blessed from 'blessed'` in `app.ts` | With `bundle: true`/`outfile` (no `splitting`), esbuild inlines a static-specifier dynamic import into the bundle, so laziness alone does not keep `blessed` out. `external` alone with a top-level import would emit a hoisted `import "blessed"` and load a terminal library on every `magi audit stats`. Both mechanisms together are what produce a bundle that neither contains `blessed` nor loads it until `magi tui` runs. |
| 2 | esbuild seam | Add exactly `external: ['blessed']` | `packages: 'external'`; a second unbundled entrypoint like `claude-code-hook/index.ts` | `packages: 'external'` would also eject `zod` and `@anthropic-ai/sdk`, silently changing what `dist/magi.mjs` ships today. A second entrypoint would make `magi tui` undiscoverable from the one binary, contradicting proposal decision 1. With `external`, esbuild never walks `blessed`'s dynamic `require('./widgets/' + name)` — the bundle-breaking risk disappears rather than being worked around. |
| 3 | Write atomicity | `writeFileSync(dir/.magi.config.json.tmp-<pid>)` → `fs.renameSync` onto the target; `unlinkSync` the tmp on any failure | Direct `writeFileSync` over the target; write-to-backup-then-swap | The target is never opened for writing, so every refusal path (unparseable file, validation failure, EACCES) leaves it byte-identical — exactly what the spec's "file on disk is byte-for-byte unchanged" scenario asserts. Same-directory rename is atomic on POSIX and maps to `MoveFileExW(REPLACE_EXISTING)` on Windows; on Windows `EPERM`/`EBUSY` (file locked by an editor/AV) the save is reported as failed and the original survives untouched — a direct write would truncate it first. |
| 4 | Round-trip preservation | `JSON.parse` → replace only the `evaluators` key on the parsed object → `JSON.stringify(obj, null, detectIndent(text))` + trailing `\n` | `JSON.parse`/`stringify` with hardcoded 2-space indent; a JSONC-preserving editor dependency | `JSON.parse` preserves string-key insertion order and `stringify` re-emits it, so `tiers`/`paths`/`_note` keep their order, values, and nesting; `detectIndent` (first indented line of the original, default 2) keeps a tab- or 4-space-formatted file byte-stable too. A comment-preserving writer would add the very kind of dependency this project avoids, and `magi.config.json` is plain JSON (its documentation convention is `_note` **keys**, which round-trip like any other key). |
| 5 | Empty-state normalization | Per-evaluator entries with no set field are omitted; if all three are empty the `evaluators` key is **deleted** from the object | Always write `"evaluators": {}` | Clearing every field returns the file to its pristine committed bytes, which makes "unset means default" true on disk as well as in the UI. `exactOptionalPropertyTypes` is honored by omitting keys, not assigning `undefined`. |
| 6 | Strict validation without a parallel validator | Drop-detection: build the candidate entry, run `EvaluatorsConfigSchema.parse({ [name]: candidate })`, and **reject the edit if the field came back `undefined` while the input was non-empty** | Hand-rolled per-field checks in the TUI; exporting new strict schemas from `evaluator-config.ts` | `EvaluatorSettingsSchema` composes `.optional().catch(undefined)` per field and `.catch({})` at both levels, so `safeParse` **never fails** — it silently drops. Drop-detection is therefore the only way to be strict (proposal decision 3) while keeping the schema as the single source of the rules. Exporting a second strict schema would create the drift this change exists to prevent, and would force a delta spec on `evaluator-config-layer`. Error copy is UI text only, derived where possible (`EvaluatorBackendSchema.options` names the accepted backends). |
| 7 | Effective defaults, computed locally | `effective-settings.ts` imports `MELCHIOR_DEFAULTS`/`BALTHASAR_DEFAULTS`/`CASPER_DEFAULTS` and one new `*_BUILTIN_DEFAULTS` constant exported from each of `groq-`/`anthropic-`/`gemini-evaluator.ts`, then reimplements decision 4's rule as a **display** function | Duplicating the model/timeout/token literals in the TUI; calling `loadEvaluatorConfig()`/`resolveNamedEvaluator()` | Decision 4's backend-aware rule is exactly the operator-visible subtlety the TUI exists to expose (`backend: anthropic` + unset `model` ⇒ Anthropic's own default, **not** the Groq literal). Duplicated literals would silently drift; the new exports are one added line per file exposing an existing private constant, with no behavior change and therefore no delta spec. The three `*_DEFAULTS` modules are already imported by `main.ts`, so no new import-time side effect is introduced. |
| 8 | Missing config file is read-only, not created | If `magi.config.json` is absent, the TUI opens showing effective defaults with save **disabled** and a banner naming the expected path | Create the file with just an `evaluators` key; seed it from `main.ts`'s `DEFAULT_CONFIG` | A file containing only `evaluators` makes `main.ts`'s `loadConfig()` return an object without `paths`, and `config.paths.auditDir` then throws a `TypeError` for every other `magi` command — the TUI would break the CLI it ships in. Seeding from `DEFAULT_CONFIG` would either duplicate `tiers`/`paths` defaults (a second source of truth this change forbids) or force a `main.ts` ⇄ TUI import cycle. |
| 9 | Denied-records loading | Read the chain once on first open of the audit tab; filter to `'decision' in r && r.decision === 'deny'`; render newest-first into a `blessed.list`, capped at 500 rows with a `showing newest 500 of N` footer | Real pagination over `readChainRecords`; re-reading per keypress | `readChainRecords` has no cursor API — it already materializes the whole chain, which is precisely what `magi audit stats` does today, so a cap on *rendered rows* (not on records read) bounds render cost without inventing a paging layer or new aggregation. `blessed.list` owns scrolling. |
| 10 | Testability seam | `MainDeps` gains `tui?: (options: TuiOptions) => Promise<number>`; `runMain` dispatches through it | Testing `magi tui` by driving a real `blessed` screen | Matches the existing DI convention (`evaluators`, `calibrateIO`, `corpus`) and lets `tests/cli/main.test.ts` prove the dispatch branch — including that nothing loads `blessed` — with no tty. `app.ts` stays the only untested-by-unit-test file, which is why decisions 3–9 all live outside it. |

## Data Flow

```
magi tui ─→ runMain(argv)  [main.ts]
              └→ await import('./tui/app.ts')     ← nothing above loads blessed
                    └→ runTui({ configPath, auditDir })
                          └→ await import('blessed')   ← external: resolved from node_modules
                          │
       readConfigFile(path) ──→ { missing | unparseable(err) | ok(raw, text, indent) }
              │                        │                            │
              │                        └→ save DISABLED, banner ────┘ (decision 8 / spec: refuse)
              └→ EvaluatorsConfigSchema.safeParse(raw.evaluators) ─→ saved: EvaluatorsConfig
                                                                        │
   pending = structuredClone(saved) ←──────────────────────────────────┘
        │                                    ┌─ effectiveSettings(name, pending[name])
        │   edit keystrokes                  │     backend = cfg.backend ?? NAMED.backend
        └→ validateFieldEdit(name, field, raw)│     model   = cfg.model ?? (backend === NAMED.backend
              └→ EvaluatorsConfigSchema.parse │                ? NAMED.model : BUILTIN[backend].model)
                    dropped? ─→ in-field error│     timeoutMs/maxTokens ?? BUILTIN[backend].*
                    kept?    ─→ pending[name][field] = value        (display only — decision 7)
        │
   save (s) ─→ re-read + re-parse file  ──unparseable/changed?─→ refuse, report
              └→ obj.evaluators = normalize(pending)   (decision 5)
              └→ tmp file → renameSync                 (decision 3)
              └→ reload from disk into `saved`/`pending`  ← spec: save-then-reread freshness

audit tab ─→ computeAuditStats(auditDir) → formatAuditStats() lines      (read-only)
          └→ readChainRecords(auditDir) → filter deny → rows[]           (read-only)
```

## Widget Layout and Keybindings

```
┌ MAGI — magi.config.json ──────────────────────────[ Evaluators | Audit ]┐
│ ┌ Evaluators ─────┐ ┌ casper ─────────────────────────────────────────┐ │
│ │ melchior      * │ │ backend    groq                                 │ │
│ │ balthasar       │ │ model      (default: llama-3.1-8b-instant)      │ │
│ │ casper        > │ │ timeoutMs  3000                                 │ │
│ └─────────────────┘ │ maxTokens  (default: 512)                       │ │
│                     └─────────────────────────────────────────────────┘ │
│ status: unsaved changes (melchior.model)                                │
│ ↑↓ field  ⏎ edit  d clear  s save  r reload  ⇥ tab  ? help  q quit      │
└─────────────────────────────────────────────────────────────────────────┘
```

| Scope | Key | Action |
|---|---|---|
| Global | `Tab` / `1` / `2` | Switch Evaluators ⇄ Audit |
| Global | `s` | Save (refused + reported when file missing/unparseable) |
| Global | `r` | Discard pending, reload from disk |
| Global | `?` | Help overlay listing every binding |
| Global | `q` / `C-c` | Quit; confirm prompt when pending ≠ saved |
| Evaluators | `↑`/`↓`/`j`/`k` | Move field cursor; `←`/`→`/`h`/`l` switch evaluator |
| Evaluators | `Enter` | Edit — `backend` opens a 3-item list (`EvaluatorBackendSchema.options`); the other three open a textbox |
| Evaluators | `Esc` | Cancel edit, prior value retained |
| Evaluators | `d` | Clear field → unset → row re-renders as `(default: …)` |
| Audit | `↑`/`↓`/`PgUp`/`PgDn` | Scroll denied list (`seq · timestamp · severity · hash[0..11]`) |
| Audit | `Enter` | Read-only detail box (actor, action, votes) |

Set values render plain; unset values render dim as `(default: <effective>)`. A rejected edit keeps the textbox open, paints the row red, and writes the reason to the status line — no pending mutation occurs. `apiKey`/`baseUrl`/`mode`/`tiers`/`paths` exist in no widget, no key map, and no write path: `normalize()` only ever emits the four schema fields.

## File Changes

| File | Action | Est. lines | Description |
|---|---|---|---|
| `src/cli/tui/config-file.ts` | Create | ~120 | `readConfigFile`, `detectIndent`, `normalizeEvaluators`, atomic `writeEvaluatorsSection` |
| `src/cli/tui/effective-settings.ts` | Create | ~80 | Backend built-in table + decision-4 display rule |
| `src/cli/tui/field-edit.ts` | Create | ~70 | Drop-detection validation + error copy |
| `src/cli/tui/audit-view.ts` | Create | ~50 | Summary lines + denied-row view model |
| `src/cli/tui/app.ts` | Create | ~200 | `runTui`: lazy `blessed`, screen, panels, key map |
| `src/cli/main.ts` | Modify | ~14 | `tui` branch (lazy import), `MainDeps.tui` seam, usage string |
| `esbuild.config.mjs` | Modify | 1 | `external: ['blessed']` |
| `package.json` | Modify | 2 | `blessed` dependency, `@types/blessed` devDependency |
| `src/gating/groq-evaluator.ts` | Modify | 1 | `export const GROQ_BUILTIN_DEFAULTS` (existing private constants) |
| `src/gating/anthropic-evaluator.ts` | Modify | 1 | `export const ANTHROPIC_BUILTIN_DEFAULTS` |
| `src/gating/gemini-evaluator.ts` | Modify | 1 | `export const GEMINI_BUILTIN_DEFAULTS` |
| `tests/cli/tui/*.test.ts` | Create | ~300 | Four pure modules + `main.ts` dispatch |
| `MANUAL.md` | Modify | ~40 | Spanish TUI section: entrypoint, keys, what it cannot edit |
| `src/gating/evaluator-config.ts` | **Unchanged** | 0 | Confirmed: TUI never calls the memoized loader |
| `src/cli/audit-stats.ts`, `src/audit/read-chain.ts` | **Unchanged** | 0 | Imported as-is |
| `magi.config.json` | **Unchanged** | 0 | Only written at runtime by an operator |

## Interfaces / Contracts

```ts
// src/cli/tui/config-file.ts
export type ConfigFileRead =
  | { status: 'missing'; path: string }
  | { status: 'unparseable'; path: string; message: string }
  | { status: 'ok'; path: string; raw: Record<string, unknown>; indent: string | number };

export function readConfigFile(configPath: string): ConfigFileRead;

/** Atomic tmp+rename. Never opens the target for writing on a failure path. */
export function writeEvaluatorsSection(
  configPath: string,
  evaluators: EvaluatorsConfig,
): { ok: true } | { ok: false; message: string };

// src/cli/tui/field-edit.ts — the schema is the only judge (decision 6)
export type FieldName = 'backend' | 'model' | 'timeoutMs' | 'maxTokens';
export function validateFieldEdit(
  name: EvaluatorName, field: FieldName, rawInput: string, entry: EvaluatorSettings,
): { ok: true; entry: EvaluatorSettings } | { ok: false; message: string };

// src/cli/tui/effective-settings.ts — display only, never construction
export interface EffectiveField<T> { value: T; source: 'config' | 'default' }
export function effectiveSettings(name: EvaluatorName, entry: EvaluatorSettings): {
  backend: EffectiveField<EvaluatorBackend>; model: EffectiveField<string>;
  timeoutMs: EffectiveField<number>; maxTokens: EffectiveField<number>;
};

// src/cli/main.ts
export interface TuiOptions { configPath: string; auditDir: string }
// MainDeps gains: tui?: (options: TuiOptions) => Promise<number>
```

`blessed` ships no types; `@types/blessed` (DefinitelyTyped) is required for `tsc --noEmit` under `strict`. It declares `export = blessed`, so with `esModuleInterop`/NodeNext the call site is `const mod = await import('blessed'); const blessed = mod.default ?? mod;`.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit — round-trip | `tiers`/`paths`/`_note` survive a save; key order and indent preserved; empty state deletes `evaluators` | `fs.mkdtempSync` fixture, save, byte-compare the non-`evaluators` slices and re-parse |
| Unit — refusal | Unparseable file, missing file, unwritable dir: save refused, target bytes identical, tmp file removed | Truncated-JSON fixture; hash the file before/after |
| Unit — freshness | Save then `readConfigFile` in the same process returns the new value | Two reads around one write in one test process (proves no memoization) |
| Unit — validation | `timeoutMs: -500`, `backend: openai`, `model: ""`, `maxTokens: "600"`, `timeoutMs: 2.5`, valid edits | `validateFieldEdit` table test; assert the schema, not a copied rule list, drives each verdict |
| Unit — defaults | Unset `model` with `backend: anthropic` shows Anthropic's built-in; with the named backend shows the named literal | `effectiveSettings` against all 3 evaluators × 3 backends |
| Unit — audit view | Denies only, newest-first, override records excluded, 500-row cap footer | Fixture chain with allow/deny/override records; assert no file written (`mtime` + `readdir` before/after) |
| Integration — dispatch | `magi tui` routes to `deps.tui`; unknown/absent subcommand and every existing command unchanged | `tests/cli/main.test.ts`, injected `tui` stub — no tty, no `blessed` |
| Build | `npm run build` succeeds; `dist/magi.mjs` contains no `blessed` source and keeps a runtime `import("blessed")` | Build-then-grep assertion on the emitted bundle |
| Regression | Full `node --test`; `magi audit stats` output identical to the TUI panel | Existing suites unchanged |

No test may open a tty, require a network, or mutate the repo's `magi.config.json` or `.magi/audit/`.

## Threat Matrix

N/A — no shell command, subprocess, VCS/PR automation, or executable-file classification is added. Rows *Git repository selection*, *Commit state*, *Push state*, *PR commands*, and *Documentation-like paths* are all `N/A`: this change spawns nothing and touches no repository state. The two boundaries it does add are constrained by design rather than by matrix rows: (a) argv routing gains exactly one literal `tui` branch, and every other branch of `runMain` is byte-unchanged; (b) a new **write** path to `magi.config.json` whose destructive potential is bounded by decisions 3–5 and 8 (never open the target on a refusal path, replace only `evaluators`, never create a partial file). The audit chain stays append-only-by-`fs-append-sink` — the TUI opens it read-only, and `mode` gains no second source (`MAGI_MODE` remains the only one).

## Migration / Rollout

No migration. Purely additive: without `magi tui` nothing in the process ever loads `blessed`. Rollback is `git revert` plus `npm remove blessed`; any `evaluators` block written by the TUI is ordinary JSON that `evaluator-config.ts` keeps reading.

**Review budget**: ~880 authored lines (`additions + deletions`) → **High** risk against the 400-line budget; chained PRs recommended. Slice points, each independently verifiable:

1. **Config round-trip core** (~330) — `config-file.ts`, `effective-settings.ts`, the three `*_BUILTIN_DEFAULTS` exports, their tests. No UI, no dependency.
2. **Edit + audit view models** (~230) — `field-edit.ts`, `audit-view.ts`, their tests. Still no dependency.
3. **blessed shell + wiring** (~320) — `app.ts`, `main.ts` dispatch, `esbuild` external, `package.json`, `MANUAL.md`, the build assertion and dispatch test. This is the only slice that adds the dependency, so a `blessed`-related revert is confined to it.

## Open Questions

- [ ] Decision 8 leaves an absent `magi.config.json` uneditable. If operators hit this outside the repo root, the fix is to export `DEFAULT_CONFIG` from `main.ts` (or lift it into its own module) so the TUI can seed a *complete* file — deliberately deferred rather than duplicating `tiers`/`paths` defaults here.
- [ ] `readConfigFile` inherits `loadConfig()`'s cwd-relative path resolution (the same open question the archived `evaluator-config-layer` design left). `magi tui --config <path>` is a one-line extension if needed; not shipped by default.
- [ ] `@types/blessed` tracks blessed `0.1.x` but is community-maintained and may under-type a widget option; the fallback is a narrow local `.d.ts` augmentation in `src/cli/tui/`, never `any` at a call site.
