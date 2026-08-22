# Archive Report: audit-blind-fields-visibility

**Change**: audit-blind-fields-visibility  
**Archived**: 2026-08-22  
**Status**: Complete and verified  

## Cycle Summary

The `audit-blind-fields-visibility` change was planned, designed, implemented, verified, and merged to master (PR #14, 2026-08-17T06:53:59Z) without persisting to `openspec/changes/archive/` on disk. This archive report reconstructs the complete cycle from Engram memory and establishes disk persistence.

### Artifacts Sourced from Engram

| Artifact | Engram ID | Topic | Retrieved |
|----------|-----------|-------|-----------|
| Proposal | #1082 | `sdd/audit-blind-fields-visibility/proposal` | 2026-08-17 02:08:35 |
| Delta Spec | #1085 | `sdd/audit-blind-fields-visibility/spec` | 2026-08-17 02:12:36 |
| Design | #1086 | `sdd/audit-blind-fields-visibility/design` | 2026-08-17 02:14:55 |
| Tasks | #1087 | `sdd/audit-blind-fields-visibility/tasks` | 2026-08-17 02:29:43 (revised with post-verify fix) |
| Verify Report | #1090 | `sdd/audit-blind-fields-visibility/verify-report` | 2026-08-17 02:45:11 (re-verification PASS) |

## Change Scope

**Intent**: Surface calibration blind fields (`calibrationCorpusHash`, `exemplarIds`, `corpusDegraded`) in audit stats and TUI to make corpus degradation visible to operators.

**Modified Capabilities**:
- `audit-stats`: added corpus degradation count/rate, distinct corpus hash count, and exemplar coverage metrics
- `tui-audit-screen`: record detail now shows calibration provenance of selected denied records

**Affected Files**:
- `src/cli/audit-stats.ts` (modified)
- `src/cli/tui/app.ts` (modified)
- `src/cli/tui/audit-view.ts` (unchanged — no-drift invariant preserved)
- `tests/cli/audit-stats.test.ts` (modified)
- `tests/cli/tui/app.test.ts` (modified)

## Verification Summary

**Verdict**: PASS (re-verification per `#1090`)

| Metric | Value |
|--------|-------|
| Requirements | 3/3 |
| Scenarios | 7/7 |
| Tasks complete | 21/21 (18 original + 3 post-verify fix) |
| Test result | 567 passed / 0 failed |
| Build status | OK |
| Typecheck | OK |
| Lint | OK |

**Key Verification Facts**:
- Verify initially returned CRITICAL for missing TUI unit test coverage (spec scenario "Corpus-degraded state is visually flagged as an alarm")
- `sdd-apply` fixed the gap via post-verify commits: extracted alarm-styling into pure exported `highlightAlarmLines()` helper and added 2 passing unit tests
- Re-verification independently confirmed all 567 tests pass, including the 2 new tests for `highlightAlarmLines()`
- All 7/7 spec scenarios now have runtime-passing covering tests
- No unrelated scope reopened; only 2 files modified after the fix

**Build Evidence**:
- `npm test`: 567 tests (exit 0)
- `npm run typecheck`: clean (exit 0)
- `npm run lint`: clean (exit 0)
- `npm run build`: bundled `src/cli/main.ts` → `dist/magi.mjs` (exit 0)

## Spec Merge Summary

**Target Spec**: `openspec/specs/evaluator-config-tui/spec.md`

**Action**: MODIFIED (Requirement: Audit Stats Summary Is Read-Only and Reuses Existing Aggregation)

The existing requirement was extended to enumerate the four new calibration fields (`corpusDegradedCount`, `corpusDegradedRate`, `distinctCorpusHashes`, `recordsWithExemplars` + coverage rate) and to document their alarm/non-alarm styling rules.

**Added Requirements**:
- Record Detail Exposes Calibration Provenance (2 scenarios)
- Summary Panel Layout Accommodates New Metrics Without Clipping (1 scenario)

**Merge Completed**: Yes (2026-08-22, as part of archive move)

## Final State

**Merged to master**: Yes (PR #14, commit d44a6d6, 2026-08-17T06:53:59Z)

**Code Evidence**:
```
git diff f39709c..d44a6d6 --stat:
src/cli/tui/app.ts        | 16 ++++++++++++----
tests/cli/tui/app.test.ts | 22 ++++++++++++++++++++++
2 files changed, 34 insertions(+), 4 deletions(-)
```

Note: The original 18 tasks completed during sdd-apply (not shown in verify diff). The verify diff shows only the 3 post-verify fix commits closing the CRITICAL finding.

## Archive Decisions

1. **Why reconstructed from Engram**: The change was merged to master (2026-08-17) but the SDD artifacts were never written to `openspec/changes/archive/` on disk — only persisted to Engram memory. This archive reconstructs the full cycle and establishes disk persistence as the source of truth.

2. **Spec merge strategy**: The delta spec for `evaluator-config-tui` capability was merged into `openspec/specs/evaluator-config-tui/spec.md` by modifying the existing "Audit Stats Summary Is Read-Only and Reuses Existing Aggregation" requirement and adding 2 new requirements for calibration provenance and layout accommodation.

3. **No stale task checkboxes**: All 21/21 implementation tasks (18 original + 3 post-verify fix) are marked complete in `tasks.md`. The post-verify fix tasks closed a CRITICAL verification finding and were independently re-verified.

## Rollback / Migration

**No migration required**: The change introduces no schema changes, no write-path changes, and no persisted-data format changes. Existing audit chains remain readable at any commit.

**Rollback**: Would revert `src/cli/audit-stats.ts` and `src/cli/tui/app.ts` plus their tests. Pure read/aggregation/display layer.

## Key Learnings

1. **Alarm styling pattern**: Terse text marker in the shared formatter (`CORPUS_DEGRADED_LINE_PREFIX`, `— ALARM` wording) + TUI-side prefix-keyed blessing styling (`{red-fg}...{/red-fg}`) keeps the formatter CLI-safe and the styling TUI-local with zero aggregation duplication.

2. **Post-verify fixes close real gaps**: The initial CRITICAL was legitimate — spec scenario "Corpus-degraded state is visually flagged as an alarm" had a passing CLI test but zero TUI test. The 3 post-verify fix tasks extracted the inline ternary into a testable helper and closed the gap.

3. **Layout constant as enforcement**: `AUDIT_SUMMARY_BOX_HEIGHT = 12` exported from `app.ts` and enforced by a regression test is far more reliable than hoping wrapping stays within bounds — a future long metric fails a test instead of clipping silently.

4. **No-drift invariant**: `auditSummary()` remains a verbatim passthrough of `formatAuditStats()` output, preserving the documented no-drift contract — TUI never re-aggregates, and the summary lines are identical between CLI and TUI.

---

**Archived by**: sdd-archive (2026-08-22)  
**Archive location**: `openspec/changes/archive/2026-08-17-magi-audit-blind-fields-visibility/`  
**Git commit**: (committed after archive move, per SDD archive protocol)
