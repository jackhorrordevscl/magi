# Proposal: Evaluator Config Layer

## Intent

`melchior`/`balthasar`/`casper` (`src/gating/melchior.ts`, `balthasar.ts`, `casper.ts`) each export a zero-arg `create*` function that hardcodes its `GroqEvaluator` backend, model, timeout, and max-tokens as source-level defaults. The only override seam today is manual DI at call sites (`RunHookOptions.evaluators` in `claude-code-hook/index.ts:175`, `MainDeps.evaluators` in `src/cli/main.ts:80`) — an operator who wants Casper on `llama-3.1-70b` instead of `-8b-instant`, or wants to fail over an evaluator from Groq to Anthropic/Gemini without a code change and rebuild, cannot do it. This blocks a planned interactive TUI (`sdd/magi-evaluator-config-tui`, exploration closed under observation #1036) from having anything to read or write, and blocks any operator-level tuning today. This change externalizes backend/model/timeout/maxTokens per named evaluator into project config, with no behavior change for anyone who doesn't touch the new config.

## Scope

### In Scope

- A configurable surface for each of the three named evaluators (`melchior`, `balthasar`, `casper|casper`) covering: backend selection (`anthropic` / `groq` / `gemini`), `model`, `timeoutMs`, `maxTokens`.
- Wiring `melchior`/`balthasar`/`casper`'s default exports (and/or their `create*` factories) to read this config and construct the corresponding `EvaluatorPort` implementation (`AnthropicEvaluator` / `GroqEvaluator` / `GeminiEvaluator`), falling back to today's hardcoded defaults when config is absent or a field is omitted.
- Validation of the config shape (reusing this project's existing `zod` convention) with fail-safe behavior on a malformed file — never silently falling back to `allow`-biased behavior, and never crashing the CLI/hook on a bad config (an evaluator config problem is an operator-input error, not a gating-safety event).
- Documentation (`MANUAL.md`) of the new config surface and its precedence versus DI overrides.

### Out of Scope

- **The TUI itself** (`magi-evaluator-config-tui`, next change; blessed-based per observation #1036). This change only produces the config surface the TUI will read and write — no interactive editor, no `blessed` dependency, no terminal UI code.
- Any change to `AnthropicEvaluator`, `GroqEvaluator`, or `GeminiEvaluator` internals — their constructors, wire formats, and fail-closed-to-deny contracts are untouched. Only *how they get instantiated* for the three named evaluators changes.
- API key management beyond what already exists (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`/equivalent, `GEMINI_API_KEY` read from `process.env` by each evaluator's own constructor). **Decided**: `apiKey` is environment-variables-only and is never a permitted field in the config file — matches the existing per-backend env-var pattern and avoids a plaintext-secret-in-JSON footgun, especially once a TUI reads/writes this file.
- Changing `MagiConfig`'s existing `mode`-exclusion rule (`sdd/magi-p3-enforcing-override/spec` Requirement: Single Mode Source) — evaluator config must not become a second place `mode` can leak in from.
- Runtime hot-reload of evaluator config while a process is running. Config is read once per process invocation, same as `magi.config.json` today.
- Calibration corpus or divergence-harness changes.

## Capabilities

### New Capabilities

- `evaluator-config-layer`: file-based, per-evaluator backend/model/timeout/maxTokens configuration that `melchior`/`balthasar`/`casper` consume at construction time, with validated fallback to current hardcoded defaults.

### Modified Capabilities

- None functionally. `EvaluatorPort`, `AnthropicEvaluator`, `GroqEvaluator`, `GeminiEvaluator`, `collectVotes`, and the consensus/verdict pipeline are all unchanged. `melchior.ts`/`balthasar.ts`/`casper.ts` change only in *how* their exported instances are constructed, not their exported shape or names.

## Approach

**Four decisions this proposal is confident enough to fix; the rest is left to `sdd-design`.**

1. **Extend `magi.config.json`, don't introduce a new file or format.** The project already has exactly one config file, in plain JSON, loaded by `src/cli/main.ts`'s `loadConfig()` with a documented fallback-to-defaults pattern when the file is absent (`MagiConfig` / `DEFAULT_CONFIG`). This matches the project's minimalism convention (no new parser dependency — `JSON.parse` is already used, no YAML/TOML library exists in `package.json`, and adding one contradicts the zero-non-essential-runtime-deps pattern set by `zod`/`@anthropic-ai/sdk` being the only two). A new top-level `evaluators` key (sibling to `tiers`/`paths`) is the natural extension point; the exact key/field names are a design-phase decision, not fixed here.
2. **Config is a construction-time input, not a replacement for DI.** `RunHookOptions.evaluators` and `MainDeps.evaluators` stay exactly as they are — config only changes what `melchior`/`balthasar`/`casper`'s default exports resolve to when nothing overrides them. This preserves the existing test seam (tests already inject fakes via those options) and keeps the config layer purely additive.
3. **`apiKey` is environment-variables-only — never a config file field.** Matches the existing `GROQ_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY` pattern, avoids a plaintext-secret-in-JSON footgun, and removes an entire class of risk (secret committed to version control, or exposed to a future TUI's read/write surface) without giving up anything — env vars already work today for every backend.
4. **The loader lives in a new shared module, not inside `src/cli/main.ts`.** Confirmed by direct inspection that `claude-code-hook/index.ts` imports nothing from `src/cli/` today; putting the loader in `main.ts` would force the hook adapter to depend on CLI internals, the wrong dependency direction. A new module — `src/gating/evaluator-config.ts` (exact filename confirmed at design time) — sits next to `melchior.ts`/`balthasar.ts`/`casper.ts`, its actual consumers, and both `main.ts` and `claude-code-hook/index.ts` import it independently with no coupling between the two entrypoints.

**Left open for `sdd-design`:**

- Exact schema shape and field names for the new config section (flat vs. nested per evaluator, singular `evaluators.melchior.backend` vs. an array, etc.).
- Whether backend selection is a plain string enum (`"anthropic" | "groq" | "gemini"`) mapped to a constructor lookup table, or something more structural.
- Precedence and error-reporting behavior when config specifies an unknown/invalid backend or model string — deny gracefully to hardcoded default vs. fail loud at startup.

This change intentionally does not reference or depend on `blessed` or any TUI-specific concern — it only needs to produce a config surface any future consumer (TUI, another CLI subcommand, a human editing JSON by hand) can read and write.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `magi.config.json` | Modified (schema addition) | New `evaluators` section, additive, optional |
| `src/gating/melchior.ts` | Modified | `createMelchior`/default export reads config instead of hardcoding backend+model |
| `src/gating/balthasar.ts` | Modified | Same pattern as Melchior |
| `src/gating/casper.ts` | Modified | Same pattern as Melchior |
| `src/gating/evaluator-config.ts` (exact filename confirmed at design time) | New | Config schema (zod) + loader + backend-name-to-constructor resolution; imported independently by both entrypoints below |
| `src/cli/main.ts` | Modified | Imports the new shared loader; `loadConfig`/`MagiConfig` itself is not extended (loader lives outside `main.ts` per decision 4) |
| `claude-code-hook/index.ts` | Unchanged | `DEFAULT_EVALUATORS` keeps importing `melchior`/`balthasar`/`casper`; only what those imports resolve to changes |
| `MANUAL.md` | Modified | New section documenting the config surface |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Malformed/partial config silently changes evaluator behavior in a way an operator doesn't notice | Med | Zod validation with explicit fallback-to-default per missing/invalid field, not per whole file; documented in `MANUAL.md` |
| A config-selected backend/model that doesn't exist or lacks a valid API key degrades gating silently | Med | Backends already fail-closed to `deny` on any transport/auth error (existing contract, unchanged) — a bad config choice degrades to more denies, never more allows |
| `apiKey` in a config file gets committed to version control | Eliminated | `apiKey` is environment-variables-only by decision (see Approach, decision 3) — never a valid config file field, so this risk does not apply |
| Config loader duplicated/diverges between `main.ts` and `claude-code-hook/index.ts` (two entrypoints both construct evaluators) | Med | Single shared loader module is a design-phase requirement, not optional |
| Scope creep toward TUI concerns during design/implementation | Low | This proposal explicitly excludes TUI code and the `blessed` dependency; enforced at spec/design review |

## Rollback Plan

Additive to `magi.config.json` (new optional key) and to three evaluator files (fallback path preserves current hardcoded behavior when config is absent). `git revert` removes the new config-reading code path; `melchior`/`balthasar`/`casper` return to their current unconditional hardcoded construction. No data migration — an operator who added an `evaluators` section to their `magi.config.json` simply has an unused/ignored key after rollback, not a breaking one.

## Dependencies

- None new. Reuses `zod` (already a runtime dependency) for schema validation. No new npm package.
- Unblocked by, and does not block, `sdd/magi-evaluator-config-tui`'s locked library decision (`blessed`, observation #1036) — that decision is orthogonal to this change and was reconfirmed unchanged across 4 exploration passes specifically because this split doesn't depend on it.

## Open Questions

None remaining — both prior open questions (`apiKey` field, loader module location) are resolved above (Approach, decisions 3 and 4).

## Success Criteria

- [ ] `melchior`, `balthasar`, `casper` each read backend/model/timeoutMs/maxTokens from `magi.config.json` when present, falling back to today's hardcoded values field-by-field when config is absent or a field is omitted.
- [ ] Backend selection supports `anthropic` / `groq` / `gemini`, resolving to the corresponding existing `EvaluatorPort` implementation with no changes to those implementations.
- [ ] Malformed config fails safe (validated, defaults used or a clear startup error — never a silent `allow`-biased misconfiguration).
- [ ] `RunHookOptions.evaluators` and `MainDeps.evaluators` DI overrides continue to work unchanged and take precedence over config.
- [ ] An `apiKey` field in the config file is rejected (or ignored with a clear warning) — never read into an evaluator's constructed instance; API keys remain environment-variable-only.
- [ ] No new runtime npm dependency; `package.json` dependencies list is unchanged.
- [ ] `MANUAL.md` documents the new config surface and its precedence versus DI.
- [ ] Every existing test in `tests/` still passes unchanged (config layer is purely additive).
