# Proposal: Surface Calibration Blind Fields in Audit Stats and TUI

## Intent

Every verdict `AuditRecord` carries `calibrationCorpusHash`, `exemplarIds`, and `corpusDegraded` (wired by `magi-calibration-live-wiring`, 2026-08-15), but nothing aggregates or displays them. An operator cannot answer "is calibration silently degraded?" without grepping raw audit JSONL. High-severity finding of the 2026-08-17 MAGI audit (engram #1079): MAGI reports *what it decided* but not *how trustworthy the calibration behind those decisions was*.

## Scope

### In Scope
- `AuditStats` gains: `corpusDegradedCount`, `corpusDegradedRate`, `distinctCorpusHashes`, `recordsWithExemplars` (+ coverage rate).
- Aggregation added to the existing single `verdictRecords` pass in `computeAuditStats()`; 1–2 new `formatAuditStats()` lines.
- TUI per-record detail (`openDetail()`) shows truncated `calibrationCorpusHash`, `exemplarIds.length`, and `corpusDegraded` (highlighted when true).
- Resize `summaryBox` so new summary lines are not clipped.
- Tests for new aggregations, including the empty-chain case.

### Out of Scope
- Corpus-hash histograms, time series, or drift alerting.
- Distinct-exemplar-ID dedup across records (coverage count only).
- Schema, write-path, or chain-read changes (`record.ts`, `fs-append-sink.ts`, `read-chain.ts`).
- Exposing calibration fields on the denied-records list rows or as a filter/sort key.
- Any new `magi calibrate` command or remediation flow.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `audit-stats`: stats output must report calibration corpus degradation, corpus-hash churn, and exemplar coverage.
- `tui-audit-screen`: record detail must expose the calibration provenance of the selected denied record.

## Approach

All aggregation lands in `computeAuditStats()`/`formatAuditStats()` — never duplicated in the TUI. `auditSummary()` forwards both verbatim (a documented no-drift invariant), so the TUI summary inherits the new lines with zero TUI aggregation code. `openDetail()` reads fields already in memory via `auditDetailByHash`; no new reads.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/cli/audit-stats.ts` | Modified | Only file with new logic: interface, loop, formatter |
| `src/cli/tui/app.ts` | Modified | `openDetail()` +3 lines; `summaryBox` height / `deniedListBox` top |
| `src/cli/tui/audit-view.ts` | Unchanged | Inherits via passthrough — invariant preserved |
| `tests/cli/audit-stats.test.ts`, `tests/cli/tui/audit-view.test.ts` | Modified | Cover new fields and rendered lines |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `summaryBox` is fixed `height: 8` (6 content rows) already rendering 5 wrapping lines; new lines clip silently | High | Grow height and shift `deniedListBox.top` in the same change; assert line count in tests |
| Empty/override-only chain yields `NaN` rates | Medium | Guard denominators exactly like `denyRateProxy`/`overrideRate` |
| Aggregation duplicated in the TUI breaks the no-drift invariant | Low | All aggregation stays in `audit-stats.ts` |
| Ambiguous metric names read as a real false-positive rate | Low | Follow `denyRateProxy`'s precedent: caveat in the doc comment and rendered line |

## Rollback Plan

Revert the two source files and their tests. Purely a read/aggregation/display layer: no schema change, no write-path change, no persisted data touched, no migration, no config. Existing audit chains stay readable at any commit.

## Dependencies

- None. No new packages, no new types beyond extending `AuditStats`.

## Success Criteria

- [ ] `magi audit stats` reports corpus-degraded count/rate, distinct corpus hashes, and exemplar coverage.
- [ ] The TUI Audit summary shows identical lines with no TUI-side aggregation code.
- [ ] Selecting a denied record shows its corpus hash, exemplar count, and degraded flag.
- [ ] A degraded corpus is detectable without reading raw audit JSONL.
- [ ] Empty and override-only chains render `0`, never `NaN`.
- [ ] No summary line is clipped by the TUI summary box.

## Proposal question round (unanswered — sub-agent could not block for input)

1. Is `corpusDegraded === true` an alarm state (operator must act now) or an expected steady state under some configs? Affects whether the line is neutral text or highlighted/warned.
2. Should `distinctCorpusHashes > 1` be treated as normal churn or as a signal worth calling out?
3. Does `magi audit stats` need a machine-readable/JSON mode for these metrics, or is human text enough for now?
4. Should stats be filterable by time window, or is whole-chain aggregation acceptable for the first slice?

Assumptions taken absent answers: degraded is alarm-worthy and highlighted; distinct hashes reported as a plain count with no judgment; human-readable text only; whole-chain aggregation only.
