# Delta Spec: audit-blind-fields-visibility

## Domain: evaluator-config-tui (Modified Capability)

Existing full spec: `sdd/magi-evaluator-config-tui/spec` (engram #1056). This delta extends the audit-summary and denied-record-detail requirements it already defines with calibration-provenance metrics.

## MODIFIED Requirements

### Requirement: Audit Stats Summary Is Read-Only and Reuses Existing Aggregation

The TUI MUST render an audit-stats panel showing `totalRecords`, `byDecision`, `bySeverity`, `denyRateProxy`, `overrideCount`, `overrideRate`, `corpusDegradedCount`, `corpusDegradedRate`, `distinctCorpusHashes`, and `recordsWithExemplars` (with its coverage rate), all as computed by the existing `computeAuditStats()`, and MUST perform no writes to the audit chain directory when rendering it. The TUI MUST source these fields via `auditSummary()`'s passthrough of `formatAuditStats()` output — the TUI MUST NOT recompute or re-derive any of these values itself.
(Previously: enumerated only `totalRecords`, `byDecision`, `bySeverity`, `denyRateProxy`, `overrideCount`, `overrideRate`.)

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

## ADDED Requirements

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

## Out of Scope (carried from proposal)

No JSON/machine-readable output mode, no time-windowed aggregation, no corpus-hash histograms or drift alerting, no denied-list row or filter/sort exposure of calibration fields — this delta covers whole-chain aggregation and summary/detail rendering only.
