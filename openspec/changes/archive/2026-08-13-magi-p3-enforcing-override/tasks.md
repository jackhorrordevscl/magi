# Tasks: P3 — Enforcing Mode + Audited Human Override

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~430-520 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (audit chain schema + sink) -> PR 2 (hook enforcing gate) -> PR 3 (override CLI + stats + docs) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Chain schema (`ChainRecordSchema`/`OverrideSchema`) + `appendRecord`/`appendOverride` + `read-chain.ts` + `verify.ts` union parse | PR 1 | `npm test -- tests/audit` | N/A — pure unit/property tests over synthetic chain files | Revert `src/audit/record.ts`, `src/audit/fs-append-sink.ts`, `src/audit/verify.ts`, `src/audit/read-chain.ts`; no other file depends on the new union yet |
| 2 | `runHook()` enforcing gate + `hookSpecificOutput` contract + `verdict.ts` omit fix | PR 2 | `npm test -- tests/claude-code-hook` | Spawn-based E2E hook test (`MAGI_MODE=enforced` real binary run) | Revert `claude-code-hook/index.ts`, `src/gating/verdict.ts`; PR 1's schema stays valid standalone |
| 3 | `magi audit override` CLI + `main.ts` wiring + `audit-stats.ts` metrics + config/README | PR 3 | `npm test -- tests/cli` | `node dist/cli/main.js audit override <hash> --reason "..."` against a fixture chain dir | Revert `src/cli/audit-override.ts`, `src/cli/main.ts`, `src/cli/audit-stats.ts`, `magi.config.json`, `README.md`; PR 1/2 behavior unaffected |

## Phase 1: Audit Chain Schema & Sink (Foundation)

- [x] 1.1 In `src/audit/record.ts`, remove `override?: string` from `AuditRecordSchema`; add `OverrideSchema` (`targetHash`, `targetSeq`, `reason: z.string().min(1)`).
- [x] 1.2 In `src/audit/record.ts`, add `OverrideRecordSchema` (shares `seq`/`prevHash`/`hash`/`timestamp`/`actor`/`mode`; `override: OverrideSchema` required) and `ChainRecordSchema = z.union([OverrideRecordSchema, AuditRecordSchema])` + exported `ChainRecord` type.
- [x] 1.3 In `src/audit/record.ts`, widen `computeHash`'s input type via distributive `type ChainContent = ChainRecord extends infer R ? Omit<R,'hash'|'prevHash'> : never` so both record kinds hash correctly.
- [x] 1.4 In `src/gating/verdict.ts`, fix `VerdictSchema`'s `.omit({...override:true})` call since `override` no longer exists on the source schema (resolve the resulting TS error).
- [x] 1.5 Create `src/audit/read-chain.ts` exporting `listDayFiles(auditDir)` and `readChainRecords(auditDir): ChainRecord[]`, parsing each line with `ChainRecordSchema` (reuse existing day-file/soft-fail conventions).
- [x] 1.6 In `src/audit/fs-append-sink.ts`, extract shared bookkeeping (seq/prevHash/day-rollover/fsync) into a private `appendRecord()`; make `append()` call it.
- [x] 1.7 In `src/audit/fs-append-sink.ts`, add `appendOverride({targetHash, targetSeq, actor, reason}, now)` on `FsAppendAuditSink` (not on the `AuditSink` port interface) using the shared `appendRecord()`.
- [x] 1.8 In `src/audit/verify.ts`, switch parsing to `ChainRecordSchema` while keeping the existing per-line soft-fail loop.

## Phase 2: Enforcing Mode Gate (Core Implementation)

- [x] 2.1 In `claude-code-hook/index.ts`, change `runHook()` to compute `allow = !(action.mode === 'enforced' && verdict.decision === 'deny')` instead of hard-coding `allow: true`.
- [x] 2.2 In `claude-code-hook/index.ts`, extend `HookOutcome` with `record: AuditRecord | null` and return `auditSink.append()`'s result so the hash is available downstream.
- [x] 2.3 In `claude-code-hook/index.ts`, add `buildBlockReason()` assembling the header/action/audit-hash/override-hint + all three evaluator rationales, per the design's fixed format, capped at 10,000 chars.
- [x] 2.4 In `claude-code-hook/index.ts`, replace `writeDecision()` with `writeHookOutput(decision, reason)` emitting the documented `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision, permissionDecisionReason}}` shape for both allow and deny.
- [x] 2.5 In `claude-code-hook/index.ts`, reword hard-coded `"(shadow mode)"` fail-open strings to `"(fail-open)"` (decision #6 — failure asymmetry documentation).
- [x] 2.6 Confirm exit code stays `0` in all paths (JSON `permissionDecision` is authoritative, no exit-2 hard block).

## Phase 3: Audited Human Override CLI (Integration)

- [x] 3.1 Create `src/cli/audit-override.ts` exporting `runAuditOverride({auditDir, targetHash, reason, actor?, now?}): {ok, error?, record?}` using `readChainRecords` to find the target by hash.
- [x] 3.2 In `runAuditOverride`, reject with no write when: hash not found, `reason` missing/empty, or target `decision !== 'deny'`.
- [x] 3.3 On success, call `appendOverride()` referencing `targetHash`/`targetSeq` and return the new record.
- [x] 3.4 In `src/cli/main.ts`, wire `override` into `runAuditCommand` (pass `rest` + `io`, currently not forwarded), update the usage string, and delete `MagiConfig.mode` and `DEFAULT_CONFIG.mode`.
- [x] 3.5 In `src/cli/audit-stats.ts`, switch to `readChainRecords`, partition chain kinds (verdict vs override), and add `overrideCount` + `overrideRate = overrides / denies` as a metric separate from the allow/deny split; keep `denyRateProxy` counting verdict records only.
- [x] 3.6 In `magi.config.json`, delete the `"mode"` key and its `_note` line.

## Phase 4: Testing

- [x] 4.1 In `tests/claude-code-hook/index.test.ts`, test `runHook` allow/deny matrix across mode x decision x trivial, block-reason containing all three rationales + hash, and the 10k cap (RED before Phase 2 code, GREEN after).
- [x] 4.2 In `tests/audit/audit-sink.test.ts`, test `appendOverride` chain bookkeeping, day rollover, and `ChainRecordSchema` round-trip.
- [x] 4.3 Create `tests/cli/audit-override.test.ts` covering unknown hash, missing/empty reason, and target `decision:'allow'` — each asserting rejection AND a byte-identical file + unchanged HEAD (no write).
- [x] 4.4 In `tests/cli/audit-stats.test.ts`, test 5 denies + 2 overrides yields deny split 5, overrides 2, and `denyRateProxy` denominator excludes overrides.
- [x] 4.5 In `tests/audit/verify.test.ts`, test `verifyChain()` stays valid over a mixed verdict+override chain, and over a pre-P3 chain with no override records (regression guard for decision #3).
- [x] 4.6 In `tests/cli/main.test.ts`, test `runMain(['audit','override',...])` exit codes and that config loading without a `mode` key succeeds.
- [x] 4.7 Extend the existing spawn-based hook E2E test: real binary with `MAGI_MODE=enforced` + deny verdict asserts stdout `permissionDecision:'deny'` and exit code `0`.

## Phase 5: Documentation

- [x] 5.1 Update `README.md` to move both P3 items out of "Out of scope" and document enforcing mode (`MAGI_MODE=enforced`) and the `magi audit override <hash> --reason "..."` command.
