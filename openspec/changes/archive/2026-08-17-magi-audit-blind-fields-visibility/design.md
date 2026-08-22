# Design: Surface Calibration Blind Fields in Audit Stats and TUI

## Technical Approach

All new aggregation lands in `computeAuditStats()`'s existing single `verdictRecords` loop (`src/cli/audit-stats.ts`) — no extra reads, no new module. `formatAuditStats()` gains exactly 2 lines. `auditSummary()` (`src/cli/tui/audit-view.ts`) stays a verbatim passthrough (documented no-drift invariant), so that file is UNCHANGED. `src/cli/tui/app.ts` gets alarm styling, the detail lines, and the layout fix. Satisfies spec #1085 requirements: Audit Stats Summary Is Read-Only, Record Detail Exposes Calibration Provenance, Summary Panel Layout Accommodates New Metrics.

## Architecture Decisions

### Decision: Alarm = terse text marker in the shared formatter + TUI-side prefix-keyed styling

**Choice**: `formatAuditStats()` emits `— ALARM` (plain text) when `corpusDegradedCount > 0`. `audit-stats.ts` exports `CORPUS_DEGRADED_LINE_PREFIX = 'Corpus degraded:'`; `loadAuditTabOnce()` maps `line.startsWith(prefix) ? \`{red-fg}${line}{/red-fg}\` : line` before `summaryBox.setContent`.
**Alternatives considered**: (a) blessed tags inside `formatAuditStats` — CLI would print literal `{red-fg}`; (b) ANSI codes in the formatter — corrupts piped/redirected CLI output; (c) TUI styling by line index — silently breaks when line order changes.
**Rationale**: satisfies "CLI: explicit alarm wording; TUI: highlighted styling" with zero aggregation in the TUI and no index fragility. The exported prefix is the explicit contract between the two.

### Decision: Fixed shared layout constant, sized against a documented reference width

**Choice**: `export const AUDIT_SUMMARY_BOX_HEIGHT = 12;` in `app.ts`, used for `summaryBox.height`, `deniedListBox.top`, and `` height: `100%-${AUDIT_SUMMARY_BOX_HEIGHT}` `` — the literal `8` disappears from all three sites. 12 = 10 content rows after borders. Worst-case wrapped rows at the reference inner width of 78 (80-col terminal minus borders) = 9, leaving 1 row of slack. Enforced by a regression test, not by hope.
**Alternatives considered**: (a) dynamic height from measured wrap — blessed gives no reliable pre-render measurement; (b) `scrollable: true` — overflow stays unreachable, `deniedListBox` owns `keys`/focus; (c) shortening the existing `denyRateProxy`/override caveats — those caveats are deliberate (proposal risk row).
**Rationale**: one constant makes box and list mathematically unable to drift. Cost: on an 80x24 terminal the denied list drops from 10 to 6 content rows — accepted, the summary is the screen's headline.

### Decision: `distinctCorpusHashes` excludes the empty-string hash

**Choice**: count `new Set(hashes).size` over NON-EMPTY `calibrationCorpusHash` values only.
**Alternatives considered**: count all values verbatim.
**Rationale**: `ExemplarSelection.corpusHash` is `''` for an empty OR degraded corpus (`src/calibration/exemplar-injection.ts:21`, `EMPTY_SELECTION`). Counting `''` would report "no corpus" as a distinct corpus version and inflate a metric decision #1084.2 defines as neutral churn.

## Data Flow

    readChainRecords ─→ computeAuditStats  (ONE verdictRecords pass)
                                │
                          formatAuditStats(stats) ─→ string[7]
                            │                              │
                   main.ts (stdout, plain)        auditSummary() passthrough
                                                           │
                                          app.ts loadAuditTabOnce() + highlightAlarm
                                                           └─→ summaryBox
    readChainRecords ─→ auditDetailByHash (already loaded) ─→ openDetail() ─→ detailBox

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/cli/audit-stats.ts` | Modify | Interface fields, loop accumulators, 2 format lines, exported prefix constant |
| `src/cli/tui/app.ts` | Modify | `AUDIT_SUMMARY_BOX_HEIGHT`, alarm mapper in `loadAuditTabOnce()`, 3 lines in `openDetail()` |
| `src/cli/tui/audit-view.ts` | Unchanged | No-drift invariant — inherits everything via passthrough |
| `tests/cli/audit-stats.test.ts` | Modify | New fields, empty/override-only chain, wrapped-row budget |
| `tests/cli/tui/audit-view.test.ts` | Modify | Rendered lines reach the TUI unchanged |

## Interfaces / Contracts

```typescript
export interface AuditStats {
  // ...existing...
  /** Verdict records with `corpusDegraded === true`. Non-zero is an ALARM (operator decision, 2026-08-17). */
  corpusDegradedCount: number;
  /** `corpusDegradedCount / totalRecords`; `0` when there are no verdict records. */
  corpusDegradedRate: number;
  /** Distinct NON-EMPTY `calibrationCorpusHash` values. `''` (empty/degraded corpus) is excluded. Plain churn count — no alarm. */
  distinctCorpusHashes: number;
  /** Verdict records with `exemplarIds.length > 0`. */
  recordsWithExemplars: number;
  /** `recordsWithExemplars / totalRecords`; `0` when there are no verdict records. */
  exemplarCoverageRate: number;
}
export const CORPUS_DEGRADED_LINE_PREFIX = 'Corpus degraded:';
```

Exact rendered lines (fixed here so apply cannot drift the wrap budget):

```
Corpus degraded: {n} of {total} ({pct}%) — ALARM      // only when n > 0
Corpus degraded: 0 of {total} (0.0%)                  // when n === 0
Corpus hashes seen: {d} distinct; exemplar coverage: {k} of {total} ({pct}%)
```

Detail lines in `openDetail()`: `corpus: {hash.slice(0,12) || '(none)'}`, `exemplars: {record.exemplarIds.length}`, and — only when `record.corpusDegraded` — `{red-fg}corpus degraded: yes — ALARM{/red-fg}`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | All 5 new fields over a fixture chain | Extend `tests/cli/audit-stats.test.ts` |
| Unit | Empty and override-only chain → `0`, never `NaN` | `Number.isNaN` assertions on all 3 rates |
| Unit | `''` corpus hashes excluded from `distinctCorpusHashes` | Fixture mixing `''` and real hashes |
| Unit | ALARM wording present iff `corpusDegradedCount > 0`; hash-churn line never alarms | Assert on `formatAuditStats()` output |
| Regression | Layout budget: `sum(ceil(len/78)) <= AUDIT_SUMMARY_BOX_HEIGHT - 2` for worst-case (6-digit) stats | Import both from `app.ts` + `audit-stats.ts` in `tests/cli/tui/audit-view.test.ts` |
| Integration | TUI summary lines identical to CLI lines | Existing `audit-view.test.ts` passthrough assertions |

The layout-budget test is the real guard: a future long line fails a test instead of clipping silently.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Read/aggregate/display layer only; `record.ts`, `read-chain.ts`, `fs-append-sink.ts` untouched.

## Migration / Rollout

No migration required. No schema, write-path, or persisted-data change; existing chains stay readable at any commit. Rollback = revert the two source files and their tests.

## Open Questions

None. The four proposal questions were resolved in engram #1084 (alarm on degraded; plain churn count; no JSON mode; whole-chain aggregation).
