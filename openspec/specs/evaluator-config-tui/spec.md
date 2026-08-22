# Evaluator Config TUI Specification

## Purpose

An interactive terminal UI (`magi tui`) that lets an operator view and edit the `evaluators` section of `magi.config.json` (`backend`/`model`/`timeoutMs`/`maxTokens` per evaluator) with validation identical to what `loadEvaluatorConfig()` would apply, and view (never mutate) the current audit-chain stats in the same session. It is a presentation layer over the existing `EvaluatorsConfigSchema` (`src/gating/evaluator-config.ts`) and `computeAuditStats()`/`readChainRecords` (`src/cli/audit-stats.ts`, `src/audit/read-chain.ts`) — it introduces no new validation rules, aggregation logic, or audit-chain writes.

## Requirements

### Requirement: Editable Field Surface Matches the Schema Exactly

The TUI MUST expose exactly `backend`, `model`, `timeoutMs`, `maxTokens` as editable fields for each of `melchior`, `balthasar`, `casper`, and MUST NOT expose any other field of an evaluator entry as editable.

#### Scenario: All four fields editable per evaluator

- GIVEN the TUI is open on the evaluator-config screen
- WHEN the operator selects `casper`
- THEN `backend`, `model`, `timeoutMs`, and `maxTokens` are each independently editable

### Requirement: Edit-Time Validation Reuses the Shared Schema

Before accepting a field edit, the TUI MUST validate the candidate value against the same validation rules `EvaluatorsConfigSchema` (or the per-field logic it composes) applies, and MUST refuse to commit a value that schema would reject, surfacing the rejection in the field rather than silently discarding or persisting it.

#### Scenario: Invalid timeoutMs rejected at edit time

- GIVEN the operator is editing `melchior.timeoutMs`
- WHEN they enter `-500` (non-positive)
- THEN the TUI refuses the edit, shows an in-field error, and the prior value remains unchanged and unsaved

#### Scenario: Invalid backend string rejected at edit time

- GIVEN the operator is editing `balthasar.backend`
- WHEN they enter `openai` (not one of `anthropic`/`groq`/`gemini`)
- THEN the TUI refuses the edit and shows an in-field error naming the accepted values

#### Scenario: Valid edits are accepted

- GIVEN the operator sets `casper.model` to a non-empty string and `casper.maxTokens` to `600`
- WHEN they confirm the edit
- THEN both values are accepted into the in-memory pending state without error

### Requirement: Save Preserves Every Non-Evaluator Key

Saving MUST write back only the `evaluators` key of `magi.config.json`; every other top-level key (`tiers`, `paths`, `_note`, and any other key present) MUST remain present with its value unchanged.

#### Scenario: Save leaves tiers and paths intact

- GIVEN `magi.config.json` contains `tiers`, `paths`, and `evaluators` keys
- WHEN the operator edits `melchior.model` and saves
- THEN the written file's `tiers` and `paths` values are byte-for-byte unchanged from before the save
- AND `evaluators.melchior.model` reflects the new value

### Requirement: Save Refuses to Overwrite an Unparseable Config File

If `magi.config.json` exists but its contents are not valid JSON, the TUI MUST NOT write to it. It MUST report the parse failure to the operator and leave the file on disk unmodified.

#### Scenario: Unparseable file blocks save

- GIVEN `magi.config.json` exists and contains truncated/invalid JSON
- WHEN the operator attempts to save an evaluator edit
- THEN the save is refused, an error naming the parse failure is shown
- AND the file on disk is byte-for-byte unchanged after the attempt

### Requirement: Save-Then-Reread Reflects the Just-Written Value

Within the same TUI session, after a successful save, the value displayed for an edited field MUST match what was just written — the TUI's read path for its own display/edit state MUST NOT be blocked by any process-lifetime memoization of prior reads of the same path.

#### Scenario: Immediate reread after save shows the new value

- GIVEN the operator edits `balthasar.timeoutMs` and saves successfully
- WHEN the TUI (or a fresh read of the same path) subsequently displays `balthasar`'s settings in the same process
- THEN the displayed `timeoutMs` is the just-saved value, not a stale pre-save value

### Requirement: Audit Stats Summary Is Read-Only and Reuses Existing Aggregation

The TUI MUST render an audit-stats panel showing `totalRecords`, `byDecision`, `bySeverity`, `denyRateProxy`, `overrideCount`, `overrideRate`, `corpusDegradedCount`, `corpusDegradedRate`, `distinctCorpusHashes`, and `recordsWithExemplars` (with its coverage rate), all as computed by the existing `computeAuditStats()`, and MUST perform no writes to the audit chain directory when rendering it. The TUI MUST source these fields via `auditSummary()`'s passthrough of `formatAuditStats()` output — the TUI MUST NOT recompute or re-derive any of these values itself.

#### Scenario: Summary panel matches CLI output

- GIVEN the same `.magi/audit` directory state
- WHEN both `magi audit stats` and the TUI's audit panel are run
- THEN the TUI displays the same values the CLI command reports, including the four new calibration fields

#### Scenario: Corpus-degraded state is visually flagged as an alarm

- GIVEN one or more verdict records have `corpusDegraded === true`
- WHEN `magi audit stats` or the TUI summary is rendered
- THEN `corpusDegradedCount` is non-zero and the rendered line is visually distinguished (CLI: explicit alarm wording; TUI: highlighted styling) from the other summary lines

#### Scenario: Distinct corpus hash churn is reported without judgment

- GIVEN verdict records reference more than one distinct `calibrationCorpusHash`
- WHEN stats are computed
- THEN `distinctCorpusHashes` reports the plain count with no alarm styling or warning wording, in both CLI and TUI

#### Scenario: Empty and override-only chains render zero, never NaN

- GIVEN `.magi/audit` has no verdict records (empty or override-only chain)
- WHEN `computeAuditStats()` runs
- THEN `corpusDegradedRate`, `distinctCorpusHashes`, and `recordsWithExemplars`'s coverage rate are all `0`, never `NaN`

### Requirement: Record Detail Exposes Calibration Provenance

`openDetail()` MUST show the selected denied record's truncated `calibrationCorpusHash`, its `exemplarIds.length`, and its `corpusDegraded` flag, sourced from the already-loaded `auditDetailByHash` map (no new reads). A `corpusDegraded === true` value MUST be rendered with the same alarm-highlighting treatment used in the summary panel.

#### Scenario: Detail view shows calibration fields for a selected denied record

- GIVEN the operator opens the denied-records list and selects a record
- WHEN the detail view renders
- THEN it includes the record's truncated corpus hash, its exemplar count, and its `corpusDegraded` flag

#### Scenario: Degraded record is highlighted in detail view

- GIVEN the selected record has `corpusDegraded === true`
- WHEN the detail view renders
- THEN the degraded flag line uses the alarm-highlighting treatment, distinct from a non-degraded record's detail view

### Requirement: Summary Panel Layout Accommodates New Metrics Without Clipping

`summaryBox`'s `height` and `deniedListBox`'s `top` MUST be adjusted together in the same change so that every summary line — including the new calibration lines — renders fully visible with no line clipped or truncated by the box boundary.

#### Scenario: No summary line is clipped after adding calibration metrics

- GIVEN the audit summary now renders 7-8 lines (up from 5) after wrapping
- WHEN the audit tab is opened in the TUI
- THEN every rendered summary line is fully visible within `summaryBox`, and `deniedListBox` starts immediately below it with no overlap or gap

### Requirement: Denied Records Are Individually Navigable, Read-Only

The audit panel MUST also present a navigable list of individual denied verdict records (at minimum: hash, seq, timestamp, severity) sourced from `readChainRecords`, and MUST NOT append, modify, or otherwise mutate any record in the audit chain while doing so.

#### Scenario: Denied records list is browsable

- GIVEN `.magi/audit` contains verdict records with at least one `deny` decision
- WHEN the operator opens the denied-records list
- THEN each denied record's hash, seq, timestamp, and severity are shown
- AND allow-decision records do not appear in this list

#### Scenario: Viewing denied records writes nothing

- GIVEN the operator navigates the denied-records list
- WHEN they scroll through several records
- THEN no new file or record is written under `.magi/audit`

### Requirement: Structurally Impossible Fields Stay Unreachable

The TUI MUST NOT offer `apiKey`, `baseUrl`, `mode`, `tiers`, or any `paths` entry as editable, and no operator input sequence MUST be able to cause any of them to be written by the TUI's save path.

#### Scenario: No apiKey or baseUrl field exists in the editor

- GIVEN the operator is on the evaluator-config screen for any evaluator
- WHEN they navigate the available fields
- THEN no `apiKey` or `baseUrl` field is offered anywhere in the UI

#### Scenario: mode and tiers are absent from the editable surface

- GIVEN the TUI is open
- WHEN the operator looks for a way to change `mode`, `tiers`, or `paths`
- THEN no screen, field, or keybinding exposes them for editing

## Result Contract

- `status`: `done`
- `executive_summary`: New-capability spec for `evaluator-config-tui` — 9 requirements, 15 scenarios covering editable-field scope, shared-schema edit-time validation, non-destructive/refuse-on-unparseable save, save-then-reread freshness, read-only audit summary and denied-records panel, and the fields that must stay structurally unreachable.
- `artifacts`: `openspec/changes/magi-evaluator-config-tui/specs/evaluator-config-tui/spec.md`, Engram `sdd/magi-evaluator-config-tui/spec`
- `next_recommended`: `sdd-design`
- `risks`: The proposal left the `evaluator-config-layer` Modified Capabilities question conditional on a design choice. This spec resolves it at spec level: the TUI's own read path (used for display and save-then-reread freshness) reads/parses `magi.config.json` directly and validates against `EvaluatorsConfigSchema`, rather than calling the memoized `loadEvaluatorConfig()`. Under that resolution, `evaluator-config-layer` needs no delta spec (its per-process-path memoization contract is unchanged and untouched by this change) — this is captured here as "Save-Then-Reread Reflects the Just-Written Value" rather than as any new export on `evaluator-config.ts`. `sdd-design` should confirm this reading is still preferred once the concrete TUI module structure is chosen, since a future design could instead add an explicit uncached-read export if that proves cleaner to wire through the widget code.

## Key Learnings

1. `readChainRecords` returns a `ChainRecord` union of verdict (`AuditRecord`, has `decision`) and override (`OverrideRecord`, has `override`) records from `src/audit/record.ts` — the denied-records panel must filter to verdict records with `decision === 'deny'`, mirroring `computeAuditStats`'s own `isVerdictRecord` partition.
2. `loadEvaluatorConfig()` is memoized per resolved path at module scope in `src/gating/evaluator-config.ts` (`configCache`), which is fine for a one-shot CLI process but would show stale data after a TUI save-then-reread in the same process if the TUI called it directly.
3. Resolving the save-then-reread staleness by having the TUI read/parse the config file itself (never calling the memoized `loadEvaluatorConfig()`) keeps the `evaluator-config-layer` capability's Modified Capabilities section empty, avoiding a delta spec for that capability in this change.
4. `EvaluatorsConfigSchema` already strips unknown keys via zod's default non-strict object parsing, so `apiKey`/`baseUrl` are structurally absent from the schema the TUI validates against, not just UI-hidden.
