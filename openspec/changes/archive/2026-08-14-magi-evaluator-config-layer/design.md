# Design: Evaluator Config Layer

## Technical Approach

One new flat module, `src/gating/evaluator-config.ts`, owning three things: a zod schema for an optional `evaluators` section of `magi.config.json`, a memoized never-throwing loader, and a backend-name-to-constructor resolver returning `EvaluatorPort`. `melchior.ts`/`balthasar.ts`/`casper.ts` each change by ~5 lines: their **module-level default export** is built by the resolver; their `create*` factory keeps its exact current signature and hardcoded Groq default so every existing test compiles and passes unchanged. `src/cli/main.ts` and `claude-code-hook/index.ts` are **both unchanged** — they already consume the default exports (`main.ts:157`, `index.ts:127`), so config reaches them transitively with zero new imports and zero coupling between entrypoints. `MagiConfig`/`loadConfig()` in `main.ts` are not extended.

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Schema shape | Flat, per-name nested object: `evaluators: { melchior?, balthasar?, casper? }`, each `{ backend?, model?, timeoutMs?, maxTokens? }`, every field optional | Array of `{name, ...}` entries; flat dotted keys (`evaluators.melchior.backend` as literal key); a single shared block applied to all three | The three evaluators are a fixed, named, non-extensible triple (`Evaluator` union in `consensus.ts`, `readonly [P,P,P]` everywhere). An array admits duplicates, omissions, and ordering bugs the type system already forbids. The nested object maps 1:1 to `zod`'s `z.object` and to a future TUI's three-panel edit surface. |
| 2 | Config applies to the **default export only**, not to `create*` | `createMelchior(options: GroqEvaluatorOptions = {})` stays byte-identical in behavior; `export const melchior` becomes resolver-built | Make `create*` read config and widen its parameter to a union of the three `*EvaluatorOptions` | `tests/gating/named-evaluators.test.ts` calls `createMelchior({ client })` with a `GroqChatClient` and asserts the hardcoded default models. A union parameter breaks that `client` type and an operator's local `magi.config.json` would break those assertions — violating the proposal's "every existing test passes unchanged". The factory stays the pure DI/test seam; config is a construction-time input to the *default instance* only, exactly as proposal decision 2 requires. |
| 3 | Fallback granularity | Per **field**, via `z.<T>().optional().catch(undefined)` on every field — an invalid field is dropped, its siblings survive | Per-file (`safeParse` the whole section, discard everything on any error) or fail-loud at startup | An operator fixing a model typo must not silently lose their valid `timeoutMs`. `.catch()` is zod's native per-field recovery — no hand-rolled validator, no new dependency. Fail-loud is rejected because an evaluator-config problem is operator input, not a gating-safety event (proposal, In Scope). |
| 4 | Model default is **backend-aware** | `model = cfg.model ?? (effectiveBackend === 'groq' ? NAMED_DEFAULT.model : undefined)`; `undefined` lets the target backend apply its own `DEFAULT_MODEL` | Naive `cfg.model ?? NAMED_DEFAULT.model` | The hardcoded defaults are **Groq model IDs** (`openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`). Setting only `backend: "anthropic"` under the naive rule sends a Groq model ID to Anthropic — a guaranteed non-2xx, i.e. a permanent `deny` on that evaluator. This is the single most likely real misconfiguration and the rule above eliminates it. |
| 5 | `apiKey` handling | Not declared in the schema (zod strips unknown keys) **plus** an explicit own-property check emitting one `process.stderr` warning per offending entry | `.strict()` (whole entry rejected) or silent strip | `.strict()` would discard a valid `model` because of an adjacent `apiKey`, and would also reject the file's existing `_note` documentation convention (see `magi.config.json` `tiers._note`). Strip-plus-warn makes the key structurally unable to reach any constructor while still telling the operator. `stderr` is safe: the hook adapter's protocol payload goes to `stdout`. |
| 6 | `baseUrl` is **not** configurable | Omitted from the schema entirely | Add `baseUrl` alongside `model` | `GroqEvaluatorOptions.baseUrl` is a complete endpoint; `GeminiEvaluatorOptions.baseUrl` is a base path the client appends to (documented divergence, `gemini-evaluator.ts:97-102`). One config field with two incompatible meanings is a footgun. Out of the proposal's four-field scope anyway. |
| 7 | Load caching | Module-level `Map<path, EvaluatorsConfig>`, populated on first call | Read the file three times (once per named evaluator) | Three modules resolve at import time. One read per process matches the proposal's no-hot-reload rule and `loadConfig()`'s once-per-invocation shape. |
| 8 | Repo's own `magi.config.json` stays **unpopulated** | Ship no `evaluators` key; document the shape in `MANUAL.md` | Ship a populated or `_note`-annotated `evaluators` block | Any value committed there becomes the project's real default and can perturb integration tests that import the default exports. The absent-key path is the one the fallback contract must prove. |

## Backend Resolution Table

`apiKey` and `client` are **never** set from config — always `undefined` in the options object, so each evaluator's constructor applies its own env-var default unchanged.

| `backend` | Constructor | Options passed | `apiKey` source (unchanged) |
|---|---|---|---|
| `"groq"` (default) | `new GroqEvaluator(name, facet, opts)` | `{ model?, timeoutMs?, maxTokens? }` | `GROQ_API_KEY` |
| `"anthropic"` | `new AnthropicEvaluator(name, facet, opts)` | `{ model?, timeoutMs?, maxTokens? }` | `ANTHROPIC_API_KEY` (SDK default via `new Anthropic({ apiKey: undefined })`, `anthropic-evaluator.ts:120`) |
| `"gemini"` | `new GeminiEvaluator(name, facet, opts)` | `{ model?, timeoutMs?, maxTokens? }` | `GEMINI_API_KEY` |

All three `*EvaluatorOptions` already share the identical `{ client?, apiKey?, model?, timeoutMs?, maxTokens? }` prefix, so one structural `ResolvedSettings` type satisfies all three constructors with no adapter.

## Interfaces / Contracts

```ts
// src/gating/evaluator-config.ts
export const EvaluatorBackendSchema = z.enum(['anthropic', 'groq', 'gemini']);
export type EvaluatorBackend = z.infer<typeof EvaluatorBackendSchema>;

// Every field independently recoverable. `apiKey`/`baseUrl`/`client` are absent
// by design: unknown keys are stripped by zod and can never reach a constructor.
const EvaluatorSettingsSchema = z.object({
  backend:   EvaluatorBackendSchema.optional().catch(undefined),
  model:     z.string().min(1).optional().catch(undefined),
  timeoutMs: z.number().int().positive().optional().catch(undefined),
  maxTokens: z.number().int().positive().optional().catch(undefined),
}).catch({});

export const EvaluatorsConfigSchema = z.object({
  melchior:  EvaluatorSettingsSchema.optional().catch(undefined),
  balthasar: EvaluatorSettingsSchema.optional().catch(undefined),
  casper:    EvaluatorSettingsSchema.optional().catch(undefined),
}).catch({});

export type EvaluatorsConfig = z.infer<typeof EvaluatorsConfigSchema>;

/** Named-evaluator baseline: today's hardcoded construction, as data. */
export interface NamedEvaluatorDefaults { backend: EvaluatorBackend; model: string }

/** NEVER throws. Missing file / unreadable / invalid JSON / wrong shape -> {}. */
export function loadEvaluatorConfig(configPath?: string): EvaluatorsConfig;

/** Builds the configured instance, or the hardcoded default when unconfigured. */
export function resolveNamedEvaluator(
  name: EvaluatorName,
  facet: CalibrationFacet,
  defaults: NamedEvaluatorDefaults,
  settings?: EvaluatorSettings,   // test seam; defaults to loadEvaluatorConfig()[name]
): EvaluatorPort;
```

`magi.config.json` addition (optional, all fields optional):

```jsonc
"evaluators": {
  "casper": { "backend": "gemini", "model": "gemini-2.5-flash-lite", "timeoutMs": 3000 }
}
```

## Consumer Change (before / after)

```ts
// melchior.ts — BEFORE
export function createMelchior(options: GroqEvaluatorOptions = {}): GroqEvaluator {
  return new GroqEvaluator('melchior', MELCHIOR_FACET, { model: 'openai/gpt-oss-120b', ...options });
}
export const melchior: GroqEvaluator = createMelchior();

// melchior.ts — AFTER
export const MELCHIOR_DEFAULTS: NamedEvaluatorDefaults = { backend: 'groq', model: 'openai/gpt-oss-120b' };

export function createMelchior(options: GroqEvaluatorOptions = {}): GroqEvaluator {   // UNCHANGED behavior
  return new GroqEvaluator('melchior', MELCHIOR_FACET, { model: MELCHIOR_DEFAULTS.model, ...options });
}
export const melchior: EvaluatorPort = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS);
```

The only widening is `GroqEvaluator` → `EvaluatorPort` on the default export. Both consumers already type it as `EvaluatorPort` (`main.ts:80/157`, `index.ts:127`), so no call site changes. `balthasar.ts`/`casper.ts` are identical modulo name/facet/model.

## Data Flow

```
import melchior.ts ─→ resolveNamedEvaluator('melchior', FACET, MELCHIOR_DEFAULTS)
                          └→ loadEvaluatorConfig()          [memoized, 1 read/process]
                               fs.existsSync → readFileSync → JSON.parse → EvaluatorsConfigSchema
                               any failure ──────────────────────→ {}  (+ stderr warning)
                          └→ backend = cfg.backend ?? 'groq'
                             model   = cfg.model ?? (backend === defaults.backend ? defaults.model : undefined)
                          └→ BACKEND_TABLE[backend](name, facet, { model, timeoutMs, maxTokens })
                                                                     apiKey/client NEVER set
                                    │
main.ts:157   deps.evaluators   ?? [melchior, balthasar, casper] ──┤  DI still wins
hook  :175    options.evaluators ?? DEFAULT_EVALUATORS ────────────┘
                                    └→ collectVotes → resolveConsensus → assembleVerdict → audit
```

## Fail-Safe Matrix

| Condition | Behavior | Warning |
|---|---|---|
| `magi.config.json` absent | `{}` → all three hardcoded defaults | none |
| File unreadable / invalid JSON | `{}` → all three hardcoded defaults (**must not** adopt `loadConfig()`'s current throwing `JSON.parse`) | yes |
| `evaluators` key absent | `{}` → hardcoded defaults | none |
| `evaluators` not an object | `.catch({})` → hardcoded defaults | yes |
| `evaluators.melchior` not an object | entry → `{}` → melchior default; siblings unaffected | yes |
| `backend: "openrouter"` | field dropped → `groq` + that evaluator's hardcoded Groq model | yes |
| `backend` valid, `model: 42` / `""` | `model` dropped → backend-aware default (decision 4) | yes |
| `model` valid, `timeoutMs: -1` / `"2s"` | `timeoutMs` dropped → backend `DEFAULT_TIMEOUT_MS`; `model` kept | yes |
| `apiKey: "sk-…"` present | stripped by schema, never constructed with | yes (explicit own-property check) |
| Unknown key (`_note`, `baseUrl`) | stripped | none |
| Valid backend, nonexistent model ID | constructed; the call fails closed to `deny` (existing contract, unchanged) | none |

No path throws, and no path can produce an `allow`-biased instance: every degradation is either "today's default" or "a backend that denies on error".

## File Changes

| File | Action | Est. lines | Description |
|---|---|---|---|
| `src/gating/evaluator-config.ts` | Create | ~120 | Schema, memoized loader, backend table, `resolveNamedEvaluator` |
| `src/gating/melchior.ts` | Modify | ~6 | `MELCHIOR_DEFAULTS` + resolver-built default export |
| `src/gating/balthasar.ts` | Modify | ~6 | Same |
| `src/gating/casper.ts` | Modify | ~6 | Same |
| `tests/gating/evaluator-config.test.ts` | Create | ~200 | Loader + fail-safe matrix + backend table + apiKey rejection |
| `MANUAL.md` | Modify | ~35 | Config surface, precedence vs. DI, env-var-only keys |
| `src/cli/main.ts` | **Unchanged** | 0 | Consumes default exports at :157; `MagiConfig`/`loadConfig` untouched |
| `claude-code-hook/index.ts` | **Unchanged** | 0 | `DEFAULT_EVALUATORS` at :127 resolves transitively |
| `magi.config.json` | **Unchanged** | 0 | Decision 8 — documented, not populated |
| `package.json` | Unchanged | 0 | Asserted, not edited |

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit — loader | Every Fail-Safe Matrix row | `loadEvaluatorConfig(tmpPath)` over `fs.mkdtempSync` fixtures; never re-import modules |
| Unit — resolver | Each backend string → correct class; backend-aware model default (decision 4); `timeoutMs`/`maxTokens` forwarded | `resolveNamedEvaluator(name, facet, defaults, settings)` with explicit `settings`, `instanceof` + injected client capturing `body.model` |
| Unit — secrets | `apiKey` in config never reaches a constructed instance; warning emitted | Fixture with `apiKey`, assert stripped result and captured stderr |
| Unit — identity | Resolved instance keeps `name` and facet for all three backends | Direct assertion |
| Integration | `RunHookOptions.evaluators` / `MainDeps.evaluators` still override config | Existing hook/main suites, unchanged |
| Regression | Full `node --test`; `createMelchior/Balthasar/Casper` default models unchanged | `tests/gating/named-evaluators.test.ts` passes byte-unchanged |

No test may require a network, a real key, or mutate the repo's `magi.config.json`.

## Threat Matrix

N/A — no routing, shell parsing, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is added or altered. `severity.ts`, `allowlist.ts`, `consensus.ts`, and the audit chain are untouched; the hook's stdin/stdout protocol is unchanged. The one security-relevant invariant is preserved explicitly by the Fail-Safe Matrix: no config state can produce an `allow`-biased evaluator, and no config value can carry a secret into a constructor (decision 5).

## Migration / Rollout

No migration. Purely additive: an absent `evaluators` key reproduces today's behavior exactly. Rollback is `git revert`; a leftover `evaluators` key becomes an ignored, non-breaking JSON key.

**Review budget**: ~373 authored lines (`additions + deletions`) against the 400-line budget → **Medium** risk, single PR is feasible and recommended, unlike the Gemini change (which needed a split at ~460). The whole change is one new file plus three ~6-line edits; splitting would separate the loader from its only consumers and ship a dead module in PR #1. If `sdd-tasks` forecasts the test file above ~230 lines, the split point is: slice 1 = `evaluator-config.ts` + its tests; slice 2 = the three wirings + `MANUAL.md`.

## Open Questions

- [ ] Should `loadEvaluatorConfig()`'s default path honor a `MAGI_CONFIG` env var so a non-repo-root cwd still finds the file? `main.ts`'s `loadConfig()` has the same cwd-relative limitation today; matching it is the conservative choice, deferring the fix to a separate change.
- [ ] `MANUAL.md` is written in Spanish; the new section follows that register (documentation-language convention, not an artifact-language exception).
