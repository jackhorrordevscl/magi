# Tasks: audit-blind-fields-visibility

## Implementation Tasks (Original 18)

- [x] 1.1 Add `corpusDegradedCount`, `corpusDegradedRate`, `distinctCorpusHashes`, `recordsWithExemplars`, `exemplarCoverageRate` fields to `AuditStats` interface in `src/cli/audit-stats.ts`
- [x] 1.2 Update `computeAuditStats()` to initialize accumulators for the five new fields
- [x] 1.3 Within the single `verdictRecords` loop, collect `corpusDegraded` counts and exemplar coverage
- [x] 1.4 Compute rates; guard against `NaN` (empty/override-only chain) exactly like `denyRateProxy`/`overrideRate`
- [x] 1.5 Exclude empty-string corpus hashes from `distinctCorpusHashes` count
- [x] 2.1 Add 2 lines to `formatAuditStats()` output: corpus degradation alarm line + corpus-hash/exemplar-coverage line
- [x] 2.2 Export `CORPUS_DEGRADED_LINE_PREFIX = 'Corpus degraded:'` constant from `audit-stats.ts`
- [x] 2.3 Write unit tests for all five new fields over a fixture chain
- [x] 2.4 Write unit tests for empty and override-only chains → zero rates, never `NaN`
- [x] 2.5 Write unit tests for empty-string corpus hash exclusion logic
- [x] 2.6 Write unit tests asserting ALARM wording iff `corpusDegradedCount > 0`; hash-churn line never alarms
- [x] 3.1 Add `export const AUDIT_SUMMARY_BOX_HEIGHT = 12;` constant to `src/cli/tui/app.ts`
- [x] 3.2 Update `loadAuditTabOnce()` to map over summary lines, prefix-matching `CORPUS_DEGRADED_LINE_PREFIX` and wrapping in `{red-fg}...{/red-fg}` for alarm styling
- [x] 3.3 Update `summaryBox.height` from `8` to `AUDIT_SUMMARY_BOX_HEIGHT`
- [x] 3.4 Update `deniedListBox.top` from `8` to `AUDIT_SUMMARY_BOX_HEIGHT`
- [x] 3.5 Update `deniedListBox.height` to `` `100%-${AUDIT_SUMMARY_BOX_HEIGHT}` ``
- [x] 4.1 Add 3 detail lines to `openDetail()`: corpus hash (truncated), exemplar count, and degraded flag (alarmed if true)
- [x] 4.2 Extract the alarm-styling logic into a pure exported `detailLines()` helper mirroring the design spec's `highlightAlarmLines` pattern (or equivalent)

## Post-Verify Fix Tasks (Closes CRITICAL Finding — 3 tasks)

- [x] 19.1 Extract `loadAuditTabOnce()`'s inline `CORPUS_DEGRADED_LINE_PREFIX ? {red-fg}...{/red-fg} : line` ternary into a pure exported `highlightAlarmLines(lines: string[]): string[]` in `src/cli/tui/app.ts` (mirrors the existing `detailLines()` extraction pattern used for the same alarm-styling need in the detail view).
- [x] 19.2 `loadAuditTabOnce()` now calls `highlightAlarmLines(summary.lines).join('\n')` instead of the inline ternary.
- [x] 19.3 Add `highlightAlarmLines` unit tests to `tests/cli/tui/app.test.ts` (new `describe` block after `detailLines`): asserts the `CORPUS_DEGRADED_LINE_PREFIX`-matched line is wrapped in `{red-fg}...{/red-fg}` and other lines pass through untouched; also covers the no-alarm-line case (all lines untouched).

Reason: sdd-verify found 1 CRITICAL — spec scenario "Corpus-degraded state is visually flagged as an alarm" had a passing covering test for its CLI half (`formatAuditStats()` `— ALARM` suffix) but zero runtime covering test for its TUI half. This closes that gap with the same extraction pattern already established in the same change for `openDetail()`/`detailLines()`.

## Status: 18/18 original + 3/3 post-verify fix = 21/21 complete.
Commit: d44a6d6 (merged to master via PR #14, 2026-08-17T06:53:59Z).
