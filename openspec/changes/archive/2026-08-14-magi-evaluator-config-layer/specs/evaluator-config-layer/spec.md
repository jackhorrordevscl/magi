# Evaluator Config Layer Specification

## Purpose

Extends `magi.config.json` with an optional `evaluators` section so `melchior`, `balthasar`, and `casper` (`src/gating/melchior.ts`, `balthasar.ts`, `casper.ts`) can have their backend (`anthropic`/`groq`/`gemini`), `model`, `timeoutMs`, and `maxTokens` set by an operator without a code change or rebuild. Today each evaluator's `create*` factory hardcodes a `GroqEvaluator` construction with a fixed model; the only override seam is manual dependency injection at the two call sites (`RunHookOptions.evaluators`, `MainDeps.evaluators`). This capability adds a second, lower-precedence seam — file-based config, read once at process start by a new shared loader module (`src/gating/evaluator-config.ts`) — while leaving `EvaluatorPort`, `AnthropicEvaluator`, `GroqEvaluator`, `GeminiEvaluator`, and the DI seams themselves completely unchanged.

## Requirements

### Requirement: Evaluators Config Section Shape

`magi.config.json` MAY contain a top-level `evaluators` key, a sibling of the existing `tiers` and `paths` keys. When present, `evaluators` MUST be an object keyed by evaluator name (`melchior`, `balthasar`, `casper`); any subset of the three keys MAY be present, and each MAY be omitted entirely. Each evaluator's value, when present, MUST be an object that MAY independently specify `backend` (one of `"anthropic"`, `"groq"`, `"gemini"`), `model` (a non-empty string), `timeoutMs` (a positive number), and `maxTokens` (a positive number) — every field is independently optional.

#### Scenario: Full evaluators section for all three evaluators

- GIVEN a `magi.config.json` containing `evaluators: { melchior: { backend: "anthropic", model: "claude-3-5-haiku-latest", timeoutMs: 3000, maxTokens: 600 }, balthasar: { backend: "gemini", model: "gemini-2.5-flash-lite" }, casper: { backend: "groq", model: "llama-3.1-70b-versatile" } }`
- WHEN the loader reads this config
- THEN each evaluator resolves the exact backend/model/timeoutMs/maxTokens given, falling back to defaults only for fields left unspecified (e.g. `balthasar.timeoutMs` and `balthasar.maxTokens`)

#### Scenario: Partial evaluators section covering only one evaluator

- GIVEN a `magi.config.json` with `evaluators: { casper: { model: "llama-3.1-70b-versatile" } }` and no `melchior` or `balthasar` keys
- WHEN the loader reads this config
- THEN `casper` resolves the overridden `model` with all other fields defaulted
- AND `melchior` and `balthasar` resolve entirely from their hardcoded defaults, unaffected by `casper`'s entry

### Requirement: Field-by-Field Fallback When Config File Is Absent

When `magi.config.json` does not exist at the resolved config path, every one of `melchior`, `balthasar`, and `casper` MUST construct using today's hardcoded backend, model, `timeoutMs`, and `maxTokens` — identical behavior to before this capability existed.

#### Scenario: No config file present

- GIVEN no `magi.config.json` exists at the resolved config path
- WHEN `melchior`, `balthasar`, and `casper` are constructed
- THEN each uses its current hardcoded Groq backend, model, `timeoutMs: 2500`, and `maxTokens: 512`, exactly as before this capability

### Requirement: Field-by-Field Fallback When the `evaluators` Section Is Absent

When `magi.config.json` exists but contains no `evaluators` key, every evaluator MUST construct using its hardcoded defaults, identically to the file-absent case. The presence of other top-level keys (`tiers`, `paths`) MUST NOT affect this fallback.

#### Scenario: Config file exists without an evaluators section

- GIVEN a `magi.config.json` containing only `tiers` and `paths` keys
- WHEN `melchior`, `balthasar`, and `casper` are constructed
- THEN each uses its current hardcoded backend, model, `timeoutMs`, and `maxTokens`

### Requirement: Field-by-Field Fallback for an Individual Missing or Invalid Field

Within one evaluator's config entry, each of `backend`, `model`, `timeoutMs`, and `maxTokens` MUST fall back to its own default independently of the other three fields on the same entry: an omitted or invalid field never invalidates the sibling fields, and a valid sibling field is never discarded because another field on the same entry is missing or invalid.

#### Scenario: Only timeoutMs overridden

- GIVEN `evaluators.melchior: { timeoutMs: 5000 }`
- WHEN `melchior` is constructed
- THEN `timeoutMs` is `5000`
- AND `backend`, `model`, and `maxTokens` all resolve to melchior's hardcoded defaults

#### Scenario: maxTokens is the wrong type

- GIVEN `evaluators.balthasar: { maxTokens: "a lot", timeoutMs: 4000 }`
- WHEN `balthasar` is constructed
- THEN `maxTokens` falls back to balthasar's hardcoded default (the invalid field is ignored, not the whole entry)
- AND `timeoutMs` resolves to `4000` as configured

#### Scenario: timeoutMs is zero or negative

- GIVEN `evaluators.casper: { timeoutMs: -1 }`
- WHEN `casper` is constructed
- THEN `timeoutMs` falls back to casper's hardcoded default, since a non-positive timeout is invalid

### Requirement: Backend Selection Resolves to the Corresponding EvaluatorPort Implementation

A `backend` value of `"anthropic"`, `"groq"`, or `"gemini"` MUST resolve to constructing `AnthropicEvaluator`, `GroqEvaluator`, or `GeminiEvaluator` respectively, with no change to those classes' own construction contracts, `EvaluatorPort` conformance, or fail-closed behavior.

#### Scenario: anthropic backend constructs AnthropicEvaluator

- GIVEN `evaluators.melchior: { backend: "anthropic" }`
- WHEN `melchior` is constructed
- THEN the resulting instance is an `AnthropicEvaluator` satisfying `EvaluatorPort` with `name: 'melchior'`

#### Scenario: gemini backend constructs GeminiEvaluator

- GIVEN `evaluators.balthasar: { backend: "gemini" }`
- WHEN `balthasar` is constructed
- THEN the resulting instance is a `GeminiEvaluator` satisfying `EvaluatorPort` with `name: 'balthasar'`

#### Scenario: groq backend (or omitted backend) constructs GroqEvaluator

- GIVEN `evaluators.casper` has no `backend` field
- WHEN `casper` is constructed
- THEN the resulting instance is a `GroqEvaluator`, matching today's hardcoded default backend

### Requirement: Model Default Follows the Resolved Backend, Not a Stale Cross-Backend Literal

When `backend` is configured to a value different from an evaluator's hardcoded default backend (`groq`) and `model` is left unspecified, the evaluator MUST NOT apply the other backend's Groq-specific hardcoded model string; it MUST leave `model` unset so the target concrete evaluator's own built-in default model applies (e.g. `AnthropicEvaluator`'s `claude-3-5-haiku-latest`, `GeminiEvaluator`'s `gemini-2.5-flash-lite`). When `backend` is omitted or explicitly `"groq"` and `model` is unspecified, the evaluator's existing hardcoded Groq model string (e.g. melchior's `openai/gpt-oss-120b`) MUST be used, unchanged from today.

#### Scenario: Backend switched to anthropic without a model override

- GIVEN `evaluators.melchior: { backend: "anthropic" }` with no `model` field
- WHEN `melchior` is constructed
- THEN the resulting `AnthropicEvaluator` uses its own default model (`claude-3-5-haiku-latest`), not melchior's Groq-specific `openai/gpt-oss-120b` string

#### Scenario: Backend left as groq without a model override

- GIVEN `evaluators.melchior: { timeoutMs: 3000 }` with no `backend` or `model` field
- WHEN `melchior` is constructed
- THEN the resulting `GroqEvaluator` uses melchior's existing hardcoded model (`openai/gpt-oss-120b`), unchanged from today

### Requirement: `apiKey` Is Never a Valid Config Field

The config schema MUST NOT define `apiKey` as an accepted field on any evaluator entry. If a config entry contains an `apiKey` key regardless of its value, the loader MUST NOT read it into any evaluator's constructed instance, MUST emit a clear warning identifying the evaluator and the fact that `apiKey` is config-file-ineligible, and MUST continue processing every other field on that same entry normally (this is not a whole-entry validation failure). Every evaluator's actual API key resolution continues to come exclusively from its backend's environment variable (`ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY`), unchanged.

#### Scenario: apiKey present alongside valid fields

- GIVEN `evaluators.casper: { model: "llama-3.1-70b-versatile", apiKey: "sk-example-not-a-real-key" }`
- WHEN `casper` is constructed
- THEN `model` resolves to the configured `llama-3.1-70b-versatile`
- AND the constructed evaluator's API key comes only from `GROQ_API_KEY` (or whichever env var its resolved backend reads) — the `apiKey` config value is never passed to the constructor
- AND a warning is emitted naming `casper` and `apiKey` as a rejected config field

#### Scenario: apiKey is the only field present

- GIVEN `evaluators.melchior: { apiKey: "sk-example-not-a-real-key" }`
- WHEN `melchior` is constructed
- THEN every field (`backend`, `model`, `timeoutMs`, `maxTokens`) falls back to melchior's hardcoded default, identical to an empty `{}` entry
- AND a warning is emitted; construction does not throw

### Requirement: Malformed Config File Fails Safe to All Defaults

When `magi.config.json` exists but is not parseable as JSON, or its `evaluators` value is not an object (e.g. an array, string, or number), the loader MUST NOT throw and MUST NOT crash the CLI or the Claude Code hook. It MUST emit a warning and fall back to hardcoded defaults for all three evaluators, exactly as if `evaluators` were absent.

#### Scenario: magi.config.json contains invalid JSON

- GIVEN a `magi.config.json` file whose contents are not valid JSON (e.g. a truncated file)
- WHEN the loader reads this config
- THEN a warning is emitted describing the parse failure
- AND `melchior`, `balthasar`, and `casper` all construct using their hardcoded defaults
- AND no exception propagates out of the loader

#### Scenario: evaluators key is not an object

- GIVEN `magi.config.json` containing `"evaluators": "melchior-only"` (a string, not an object)
- WHEN the loader reads this config
- THEN a warning is emitted
- AND all three evaluators fall back to their hardcoded defaults

### Requirement: Invalid Backend Value Falls Back Per-Field, Never Biases Toward Allow

A `backend` value outside `"anthropic"` / `"groq"` / `"gemini"` (including an empty string, a number, or an unrecognized backend name) MUST be treated as an invalid field on that evaluator's entry: it falls back to that evaluator's hardcoded default backend per the field-by-field fallback rule, with a warning emitted. This failure MUST NOT change any vote outcome or otherwise bias evaluation toward `allow` — an unrecognized backend simply results in construction against the default (already-working) backend.

#### Scenario: Unrecognized backend string

- GIVEN `evaluators.balthasar: { backend: "openai" }`
- WHEN `balthasar` is constructed
- THEN `backend` falls back to balthasar's hardcoded default (`groq`)
- AND a warning is emitted naming the rejected value
- AND `balthasar` still participates in voting as a working `GroqEvaluator`, never silently disabled or defaulted to `allow`

### Requirement: No Model ID Validation at Config-Load Time

The loader MUST NOT validate a configured `model` string against any known-model list; a non-empty string is accepted as-is and passed through to the resolved backend's constructor. An invalid or deprecated model ID surfaces only later as the resolved evaluator's own transport-error fail-closed-to-`deny` path (per each concrete evaluator's existing spec), consistent with `AnthropicEvaluator`, `GroqEvaluator`, and `GeminiEvaluator`'s existing "no model ID validation at construction" contracts.

#### Scenario: Config specifies a non-existent model

- GIVEN `evaluators.casper: { model: "not-a-real-model" }`
- WHEN `casper` is constructed
- THEN construction succeeds without throwing and without any config-layer validation error
- AND the invalid model only surfaces later as a non-2xx transport failure at vote time, which the resolved evaluator's existing fail-closed path turns into a `deny` vote

### Requirement: DI Overrides Take Precedence Over Config, Unconditionally

`RunHookOptions.evaluators` (`claude-code-hook/index.ts`) and `MainDeps.evaluators` (`src/cli/main.ts`) MUST continue to fully substitute the evaluator triple with no involvement of `magi.config.json`'s `evaluators` section whatsoever, exactly as today. Config only changes what the module-level `melchior`, `balthasar`, and `casper` exports resolve to when nothing overrides them; it never participates when a caller supplies its own evaluators via DI.

#### Scenario: RunHookOptions.evaluators supplied alongside a populated evaluators config section

- GIVEN a `magi.config.json` with `evaluators.melchior.backend: "anthropic"`
- AND `runHook` is called with `options.evaluators` set to a fake triple of `EvaluatorPort` implementations
- WHEN the hook pipeline runs
- THEN the fake triple is used for voting, completely bypassing both the config section and the module-level `melchior`/`balthasar`/`casper` exports

#### Scenario: MainDeps.evaluators supplied alongside a populated evaluators config section

- GIVEN a `magi.config.json` with `evaluators.casper.model: "llama-3.1-70b-versatile"`
- AND `runMain` is called with `deps.evaluators` set to a fake triple
- WHEN the CLI command that consumes evaluators runs
- THEN the fake triple is used, and the config-driven `casper` construction never occurs for that invocation

### Requirement: Public Export Shape Is Unchanged

`melchior`, `balthasar`, and `casper` MUST continue to be exported by name from `src/gating/melchior.ts`, `balthasar.ts`, and `casper.ts` respectively, each satisfying `EvaluatorPort`. `createMelchior`/`createBalthasar`/`createCasper` MUST continue to exist as factory functions accepting an options object for test/DI overrides. No import site (`src/cli/main.ts`, `claude-code-hook/index.ts`, or any test) changes what it imports or how it names these exports as a result of this capability; only how the module-level instances are constructed internally changes.

#### Scenario: Existing import sites are unaffected

- GIVEN `claude-code-hook/index.ts` imports `{ melchior, balthasar, casper }` from `../src/gating/melchior.ts` etc., unchanged
- WHEN this capability is implemented
- THEN those import statements require no edits, and `DEFAULT_EVALUATORS` in `claude-code-hook/index.ts` continues to type-check as `readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort]`

#### Scenario: create* factories still accept DI overrides

- GIVEN a test calls `createMelchior({ client: fakeClient })` to inject a fake transport, as tests do today
- WHEN this capability is implemented
- THEN the factory still accepts and honors an injected `client` (or other per-backend override), regardless of what `magi.config.json` contains

### Requirement: Config Is Read Once, Synchronously, at Module Load

The new loader (`src/gating/evaluator-config.ts`) MUST read and resolve `magi.config.json` synchronously, mirroring the existing synchronous `fs.existsSync`/`fs.readFileSync` pattern already used by `src/cli/main.ts`'s `loadConfig`. Config MUST NOT be re-read during a single process's lifetime after the module-level `melchior`/`balthasar`/`casper` instances are constructed; no hot-reload or watch behavior is introduced.

#### Scenario: Config changes after process start have no effect

- GIVEN a process has already imported `melchior` (triggering module-level construction)
- WHEN `magi.config.json` is subsequently modified on disk within the same process lifetime
- THEN the already-constructed `melchior` instance's backend/model/timeoutMs/maxTokens are unaffected until the process restarts

### Requirement: Single Shared Loader, No Duplicated Config-Reading Logic

`src/cli/main.ts` and `claude-code-hook/index.ts` MUST both obtain evaluator config exclusively by importing `src/gating/evaluator-config.ts`; neither entrypoint MUST implement its own copy of the `evaluators`-section parsing, validation, or backend-resolution logic. `claude-code-hook/index.ts` MUST NOT import from `src/cli/` to obtain this behavior.

#### Scenario: claude-code-hook/index.ts does not depend on src/cli

- GIVEN `claude-code-hook/index.ts` needs evaluator config to construct `melchior`/`balthasar`/`casper`
- WHEN this capability is implemented
- THEN `claude-code-hook/index.ts` imports the config/resolution logic only from `src/gating/evaluator-config.ts` (directly or transitively via `melchior.ts`/`balthasar.ts`/`casper.ts`), never from `src/cli/main.ts` or any other `src/cli/` module

## Non-Scope

The following are explicitly out of scope for this capability and MUST NOT be implemented as part of it:

- The interactive TUI (`magi-evaluator-config-tui`, blessed-based) — this capability only produces the config surface a future TUI would read/write.
- Any change to `AnthropicEvaluator`, `GroqEvaluator`, or `GeminiEvaluator` internals — their constructors, wire formats, and fail-closed contracts are untouched.
- A `baseUrl` config field for any backend — `baseUrl` remains code/DI-only, unreachable from `magi.config.json`.
- Runtime hot-reload or file-watching of `magi.config.json`; config is read once per process invocation.
- Any change to `MagiConfig.mode`'s exclusion rule (`sdd/magi-p3-enforcing-override/spec` Requirement: Single Mode Source) — the `evaluators` section MUST NOT carry a `mode` key and MUST NOT become a second place `mode` can leak in from.
- API key management beyond existing per-backend environment variables — no new secret-handling mechanism.

## Result Contract

- `status`: `done`
- `executive_summary`: Delta spec adding an `evaluator-config-layer` capability (13 requirements, 24 scenarios) that lets `magi.config.json` carry an optional `evaluators` section controlling `melchior`/`balthasar`/`casper`'s backend/model/timeoutMs/maxTokens, with field-by-field fail-safe fallback to today's hardcoded defaults, `apiKey` explicitly rejected as a config field, and existing DI seams (`RunHookOptions.evaluators`/`MainDeps.evaluators`) preserved with full precedence.
- `artifacts`: `openspec/changes/magi-evaluator-config-layer/specs/evaluator-config-layer/spec.md`, Engram `sdd/magi-evaluator-config-layer/spec`
- `next_recommended`: `sdd-design`
- `risks`: (1) The proposal leaves "exact schema shape" and "precedence/error-reporting behavior for unknown/invalid backend or model" open for design; this spec makes two concrete resolving decisions not verbatim in the proposal — see Key Learnings #1 and #2 — flagged here for design to confirm or override. (2) The "apiKey present" behavior (warn-and-ignore-that-field rather than invalidate-the-whole-entry or hard validation error) is this spec's own reasonable resolution of the proposal's explicit either/or ("rejected... or ignored with a clear warning"); design should confirm this choice before `sdd-tasks`.

## Key Learnings

1. When `backend` is overridden away from an evaluator's default `groq` and no `model` override is given, the spec resolves the model to the *new* backend's own built-in default (e.g. `AnthropicEvaluator`'s `claude-3-5-haiku-latest`) rather than the stale Groq-specific model string hardcoded in `melchior.ts`/`balthasar.ts`/`casper.ts` — applying a Groq model ID to a different provider's API would be nonsensical, and the proposal's "fall back to defaults" language is read as "that backend's own working default," not a literal cross-provider string copy.
2. `apiKey` presence in a config entry is resolved as warn-and-ignore-that-single-field (construction still succeeds, every other valid field on the entry still applies) rather than invalidating the whole evaluator entry — this is the more fail-safe reading of the proposal's explicit "never crashing the CLI/hook on a bad config" and "never silently falling back to allow-biased behavior" constraints, and is symmetric with how every other invalid individual field is already handled.
3. `src/cli/main.ts`'s existing `loadConfig`/`MagiConfig` has no zod validation today (a bare `JSON.parse(...) as MagiConfig` cast) — the "reuse the project's zod convention" language in the proposal refers to zod's established use elsewhere in `src/gating/` (e.g. `VoteDecisionSchema`), not to an existing validated config loader; the new `evaluator-config.ts` module introduces the first actual schema-validated config reading in this project.
4. `melchior`, `balthasar`, and `casper` are constructed once at module import time (top-level `export const melchior = createMelchior()`), so the new config loader must resolve synchronously before that top-level assignment runs, mirroring `main.ts`'s existing synchronous `fs.existsSync`/`fs.readFileSync` pattern rather than introducing any async config path.
5. All three evaluator backends (`AnthropicEvaluator`, `GroqEvaluator`, `GeminiEvaluator`) already share identical `DEFAULT_TIMEOUT_MS: 2500` and `DEFAULT_MAX_TOKENS: 512`, which simplifies field-level fallback for those two fields across a backend switch — only `model` genuinely depends on which backend is selected.
