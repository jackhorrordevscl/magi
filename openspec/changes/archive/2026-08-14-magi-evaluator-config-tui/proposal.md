# Proposal: Evaluator Config TUI

## Intent

`magi-evaluator-config-layer` (archived `2026-08-14`) made per-evaluator `backend`/`model`/`timeoutMs`/`maxTokens` configurable, but the only way to exercise it is hand-editing `magi.config.json`. An operator retuning Casper has to know the four field names, the three legal backend strings, that `apiKey` is env-var-only, and the backend-aware model-default rule (`MANUAL.md` §"Configurar evaluadores") — none of which the file itself tells them. Feedback for a bad value is a `stderr` warning on the *next* run, not at edit time. Separately, `magi audit stats` already computes the deny-rate proxy and override accounting (`src/cli/audit-stats.ts`) but prints five lines and exits, so "did my retune actually change the deny rate" is a manual before/after diff across two shell invocations.

This change adds an interactive terminal UI that makes the config surface discoverable and validated *at edit time*, with the existing audit stats visible in the same session so a tuning decision and its evidence are on one screen.

## Scope

### In Scope

- Interactive editing of exactly the surface `EvaluatorsConfigSchema` already defines: `backend` / `model` / `timeoutMs` / `maxTokens` for each of `melchior` / `balthasar` / `casper`.
- Safe write-back of the `evaluators` key into `magi.config.json`, preserving every sibling key (`tiers`, `paths`, `_note`) byte-for-byte in meaning.
- Edit-time validation reusing the existing schema, so what the TUI accepts and what `loadEvaluatorConfig()` accepts can never diverge.
- A read-only audit-stats panel over the existing `computeAuditStats()` output (`totalRecords`, `byDecision`, `bySeverity`, `denyRateProxy`, `overrideCount`, `overrideRate`).
- `blessed` added as a dependency; `MANUAL.md` section documenting the TUI.

### Out of Scope

- **Any new config field.** The TUI edits the four existing fields only. `apiKey` and `baseUrl` stay structurally impossible to set (`evaluator-config-layer` design decisions 5 and 6).
- **Editing `mode`, `tiers`, or `paths`.** `mode` in particular must not gain a second source (`enforcing-mode-gate` spec, Requirement: Single Mode Source).
- **Any audit mutation from the TUI** — no `magi audit override` equivalent, no calibration import. The audit panel reads; it never appends to the hash chain.
- Changing evaluator internals, `collectVotes`, consensus, severity, or the audit chain format.
- New aggregation metrics beyond what `AuditStats` already carries (e.g. per-day trends, per-actor breakdowns).
- Hot-reload: a running gating process still picks up config only at its next start.
- Re-opening the TUI library comparison — closed on `blessed` (observation #1036, 4 passes).

## Capabilities

### New Capabilities

- `evaluator-config-tui`: an interactive terminal editor for the `evaluators` config section plus a read-only audit-stats view, with edit-time validation and non-destructive write-back.

### Modified Capabilities

- `evaluator-config-layer`: **conditional.** `loadEvaluatorConfig()` is memoized per resolved path (design decision 7), which is correct for a one-shot CLI but wrong for a long-lived TUI that writes then re-reads. If the resolution is an uncached-read or cache-invalidation export, that is a spec-level addition to this capability and needs a delta spec. If the TUI instead reads the file directly and never calls the loader, this list is empty. Decided at design.

## Approach

**Fixed by this proposal:**

1. **`blessed` (plain, not `neo-blessed`), locked.** Zero runtime dependencies of its own, pure-JS rendering, no native bindings for the widget set needed here. Its dormant-maintenance risk was accepted over `terminal-kit`'s verified 8-package tree (including an irrelevant image-decoding stack). See observation #1036 — this is an input, not a question.
2. **The TUI is a presentation layer, never a second source of truth.** It writes the same JSON `loadEvaluatorConfig()` reads, validated by the same schema. A save followed by a reload must be a semantic no-op.
3. **Never write over a config file we could not parse.** `loadEvaluatorConfig()` deliberately never throws and returns `{}` on invalid JSON — a TUI that inherited that behavior and then saved would silently destroy the operator's `tiers`/`paths`. The TUI must read-modify-write a successfully parsed object, and refuse to save (with a clear message) when the file is present but unparseable.
4. **Write-back replaces only the `evaluators` key.** Every other top-level key round-trips.
5. **Audit stats are read-only and reuse existing code.** `computeAuditStats()` is imported as-is; no new aggregation logic ships in this change.

**Left to `sdd-design`:**

- The lazy-`import()`/`external` mechanics for the `magi tui` entrypoint against `esbuild.config.mjs` (see Decisions 1).
- The `readChainRecords`-backed denied-records list: pagination/scroll approach, how many records load at once (see Decisions 2).
- Widget layout, keybindings, and how validation errors surface per field.
- Atomicity of the write (tmp-file + rename vs. direct write) and formatting/indentation preservation.
- Whether an unset field is rendered as its effective default (and how the backend-aware model rule is shown) or left blank.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `src/cli/tui/` | New | `blessed` screen, evaluator form, audit-stats panel |
| config writer module (path TBD) | New | Parse → mutate `evaluators` → write; refuses on unparseable input |
| `src/cli/main.ts` | Modified (pending entrypoint decision) | Dispatch for a new command, if that shape is chosen |
| `src/gating/evaluator-config.ts` | Possibly modified | Uncached-read / cache-invalidation seam (see Modified Capabilities) |
| `src/cli/audit-stats.ts` | Unchanged | Reused as-is |
| `esbuild.config.mjs` | Likely modified | `blessed` uses dynamic `require`; bundling `main.ts` with a static TUI import risks breaking `dist/magi.mjs` |
| `package.json` | Modified | Adds `blessed` (first non-essential runtime dep since `zod`/`@anthropic-ai/sdk`) + a types package, confirmed at design |
| `MANUAL.md` | Modified | New TUI section (Spanish, per this file's convention) |
| `magi.config.json` | Unchanged by this change | Only written at runtime, by an operator using the TUI |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `blessed`'s dynamic `require` breaks the `esbuild` bundle of `dist/magi.mjs` | Med | Observation #1036 learning 4 already flagged this: keep the TUI out of the bundle (lazy `import()` + `external`, or a separate unbundled entrypoint like `claude-code-hook/index.ts`). Verified in design, not assumed |
| A TUI save clobbers `tiers`/`paths`/`_note` | Med | Approach decisions 3 and 4 — read-modify-write only, hard refusal on unparseable input, round-trip test |
| TUI validation drifts from the loader's, so the TUI accepts a value the loader silently drops | Med | Reuse `EvaluatorsConfigSchema` directly; no hand-rolled parallel validator |
| TUI displays stale config after its own save (loader memoization) | Med | Resolved explicitly at design (see Modified Capabilities), with a test asserting post-save state |
| `blessed` is unmaintained (last publish 2015) | Low (accepted) | Decision already made and documented (#1036): low-impact for a stable text-rendering feature set; not re-opened here |
| Adding a runtime dependency erodes the project's minimal-dependency pattern | Low | `blessed` has zero transitive dependencies — the tree grows by exactly one package. Weighed against `terminal-kit`'s 8 and accepted in #1036 |
| Scope creep from "view stats" into "act on stats" (override from the TUI) | Med | Explicitly out of scope; overrides stay on `magi audit override`, where the append-only, reason-required contract already lives |

## Rollback Plan

Purely additive. `git revert` removes the TUI modules, the `main.ts` dispatch (if any), and the `blessed` dependency; every existing entrypoint (`magi calibrate`, `magi audit`, the Claude Code hook) is untouched by this change and keeps working. Any `evaluators` block an operator wrote *via* the TUI stays valid — it is the same JSON they could have typed by hand, still read by `evaluator-config.ts`. No data migration, no config format change.

## Dependencies

- `blessed` (new runtime dependency; plain package, not `neo-blessed`) — decision locked in observation #1036.
- Requires the archived `magi-evaluator-config-layer` (`openspec/specs/evaluator-config-layer/spec.md`) to be in place — it is.
- No change to `zod` or `@anthropic-ai/sdk`.

## Decisions (closed)

1. **Entrypoint shape: `magi tui` subcommand, lazily loaded.** Added to `src/cli/main.ts`'s dispatch as a discoverable subcommand, but `blessed` is pulled in via a lazy `import()` at command-invocation time (never a static top-level import) and marked `external` in `esbuild.config.mjs`, so `dist/magi.mjs` keeps building without bundling `blessed`'s dynamic `require`. This is a design-phase implementation detail to get right, not a re-opened choice.
2. **Audit-stats view scope: individual denied records, not just the summary.** The panel shows both the existing `formatAuditStats()` summary (`totalRecords`/`byDecision`/`bySeverity`/`denyRateProxy`/`overrideCount`/`overrideRate`) AND a navigable list of individual denied records (hash, seq, timestamp, severity) pulled from `readChainRecords`, so an operator can see *which* denials drive the proxy — not just the aggregate. This is read-only in both forms; no write path is added to the audit chain. `sdd-design` scopes the read/pagination approach against `readChainRecords`' existing shape.
3. **Write-validation: strict.** The TUI refuses to save a field value the shared `EvaluatorsConfigSchema` would reject — it surfaces the rejection at edit time, in the field, rather than silently persisting a value the loader would later warn-and-drop on the next process start. This is deliberately stricter than the loader's own lenient runtime behavior (per-field `.catch()`, warn-and-drop stays exactly as designed for hand-edited/legacy config files); the TUI's job is to make a bad edit visible immediately, not to match the loader's leniency.
4. **`blessed` is a normal `dependency`.** It is the only new runtime dependency this change adds (current runtime deps: `@anthropic-ai/sdk`, `zod`); no conditional-install logic for a hook-only use case is introduced.

## Success Criteria

- [ ] An operator can view and edit `backend`/`model`/`timeoutMs`/`maxTokens` for all three evaluators interactively, without knowing the JSON shape.
- [ ] Saving writes a `magi.config.json` that `loadEvaluatorConfig()` reads back with identical values, and leaves `tiers`/`paths`/`_note` intact.
- [ ] A present-but-unparseable `magi.config.json` is never overwritten; the TUI reports it and refuses to save.
- [ ] `apiKey`, `baseUrl`, and `mode` are not editable and cannot be written by the TUI under any input.
- [ ] The audit panel renders current `computeAuditStats()` output and performs no writes to `.magi/audit/`.
- [ ] `dist/magi.mjs` still builds and every existing `magi` subcommand and the Claude Code hook behave unchanged.
- [ ] `MANUAL.md` documents the TUI, its entrypoint, and what it deliberately cannot edit.
- [ ] Every existing test in `tests/` passes unchanged.
