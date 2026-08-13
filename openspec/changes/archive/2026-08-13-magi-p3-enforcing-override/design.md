# Design: P3 — Enforcing Mode + Audited Human Override

## Technical Approach

Two coupled additions over existing machinery. (1) `runHook()` stops hard-coding `allow: true` and derives it from `action.mode` + `verdict.decision`; the process entrypoint replaces its non-contractual stdout shape with Claude Code's documented `hookSpecificOutput` envelope. (2) An override becomes a **second record kind in the same hash chain** — appended, never mutating — plus a `magi audit override` subcommand and a distinct stats metric. Consensus, severity, and durability logic are untouched.

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Hook output shape | Replace `{decision:'allow',reason}` outright; emit `hookSpecificOutput` for **both** allow and deny | Keep legacy shape for shadow/back-compat | The current shape is not a valid Claude Code value in any contract version (legacy vocabulary was `approve`/`block`), so it is silently ignored today. Two shapes would leave shadow speaking an unverified protocol. Updating `tests/claude-code-hook/index.test.ts` is a deliberate spec change, not collateral damage. |
| 2 | Where mode is read | `runHook()` branches on `action.mode` (already on `ProposedAction`) | Call `resolveMode()` inside `runHook()` | Keeps `runHook` pure and table-testable; env is read exactly once, in `main()`. |
| 3 | Override record shape | Repurpose the *name*, replace the *type*: drop `override?: string` from the verdict record; add a required structured `override` object on a new `OverrideRecordSchema`; readers parse `ChainRecordSchema = z.union([...])` | (a) Mutate the original record — breaks `verifyChain()` by construction. (b) Add a `type` discriminator with a Zod `.default()` | No writer ever populated `override` (`fs-append-sink.ts:54-65`), so no on-disk record contains it → zero migration, zero hash invalidation. A defaulted discriminator would materialize a key absent from historical bytes, and `verifyChain()` rehashes the *parsed* object — every pre-P3 record would fail. Required-on-override / absent-on-verdict makes "a verdict can never claim to be overridden" a type guarantee. |
| 4 | Override write path | Extract shared bookkeeping into private `appendRecord()`; `append()` and new `appendOverride()` both call it | A separate writer for overrides | seq / prevHash / day-rollover / fsync must be byte-identical or the chain forks. |
| 5 | Sink port surface | `appendOverride()` on `FsAppendAuditSink` only, not on the `AuditSink` interface | Widen the port | The hook adapter never overrides; widening forces every test fake to grow an unusable method. The CLI follows the existing `runAuditCommand` convention (pure function over `auditDir`), so no injection port is needed. |
| 6 | Failure asymmetry (documented, behavior unchanged) | Evaluator `abstain` → consensus deny → **blocks** under enforcement (fail-closed); adapter exception → **allow** (fail-open) | Fail-closed on adapter errors | A MAGI bug must never wedge the agent; a model declining to vote is a real signal. The hard-coded `"(shadow mode)"` strings become false under enforcement and must be reworded to `"(fail-open)"`. |
| 7 | Exit code | Always `0`; deny carried by JSON only | Exit `2` as hard-block redundancy | Exit 2 treats stderr as the block reason, which would make internal errors indistinguishable from deliberate denies. JSON is authoritative. |
| 8 | Stats denominator | `totalRecords` / `denyRateProxy` count **verdict records only**; overrides are a separate `overrideCount` + `overrideRate = overrides / denies` | Count overrides in `totalRecords` | Including them silently deflates `denyRateProxy`. `overrides / denies` reads directly as "share of denies a human disputed". |

## Data Flow

```
PreToolUse stdin ─→ main() ─ resolveMode() ─→ normalizeToProposedAction(mode)
                                                        │
                                        runHook ─→ classify → collectVotes → assembleVerdict
                                                        │
                                        auditSink.append() ──→ chain (verdict record)  ← ALWAYS, both modes
                                                        │ returns record{hash}
                        allow = !(mode==='enforced' && decision==='deny')
                                                        │
                                        hookSpecificOutput{permissionDecision, reason(3 rationales + hash)}

operator ─→ magi audit override <hash> --reason "…" ─→ read chain → find by hash → assert deny
                                                     └─→ appendOverride() ──→ chain (override record)
                                                                                    │
                                        magi audit verify (unchanged) ─┘   magi audit stats (partitions kinds)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `claude-code-hook/index.ts` | Modify | `runHook()` computes `allow` from `action.mode`+`verdict.decision`, returns the appended `record`; `writeDecision()` → `writeHookOutput(decision, reason)`; `buildBlockReason()`; reword fail-open strings |
| `src/audit/record.ts` | Modify | Remove `override` from `AuditRecordSchema`; add `OverrideSchema`, `OverrideRecordSchema`, `ChainRecordSchema`/`ChainRecord`; widen `computeHash` input via a **distributive** omit |
| `src/audit/fs-append-sink.ts` | Modify | Extract `appendRecord()`; add `appendOverride({targetHash,targetSeq,actor,reason}, now)` |
| `src/audit/verify.ts` | Modify | Parse with `ChainRecordSchema` (keeps its own soft-fail line loop) |
| `src/audit/read-chain.ts` | Create | Shared `listDayFiles` + `readChainRecords(auditDir)` for stats and override lookup |
| `src/gating/verdict.ts` | Modify | `VerdictSchema`'s `.omit({...override:true})` must drop the now-nonexistent key (TS error otherwise) |
| `src/cli/audit-override.ts` | Create | `runAuditOverride({auditDir, targetHash, reason, actor?, now?}): {ok, error?, record?}` |
| `src/cli/main.ts` | Modify | Wire `override` into `runAuditCommand` (needs `rest` + `io`, currently not passed); delete `MagiConfig.mode` (:44) and `DEFAULT_CONFIG.mode` (:50); update usage string |
| `src/cli/audit-stats.ts` | Modify | Partition chain kinds; add `overrideCount`/`overrideRate` + format lines; use `readChainRecords` |
| `magi.config.json` | Modify | Delete `"mode"` and the `_note` line describing it |
| `README.md` | Modify | Move both P3 items out of "Out of scope"; document enforcing mode + override command |
| `tests/**` | Modify | See Testing Strategy |

## Interfaces / Contracts

```ts
// claude-code-hook/index.ts — the documented PreToolUse contract (replaces the old shape)
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow' | 'deny',
    permissionDecisionReason: reason,   // capped at 10_000 chars
  },
}) + '\n');

export interface HookOutcome {
  allow: boolean;
  trivial: boolean;
  verdict: Verdict | null;
  record: AuditRecord | null;  // NEW: append()'s return value, currently discarded —
}                              // supplies the hash the block reason and override CLI need

// src/audit/record.ts
export const OverrideSchema = z.object({
  targetHash: z.string().min(1),
  targetSeq: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export const OverrideRecordSchema = z.object({
  seq, prevHash, hash, timestamp, actor, mode,   // same chain bookkeeping
  override: OverrideSchema,                       // REQUIRED here, ABSENT on verdict records
});
export const ChainRecordSchema = z.union([OverrideRecordSchema, AuditRecordSchema]);
```

Block reason format (single string, header first so truncation never loses the hash):

```
magi: BLOCKED — consensus deny (severity: high)
Action: <action>   Audit: <hash>
Override: magi audit override <hash> --reason "<why>"

MELCHIOR — deny: <rationale>
BALTHASAR — deny: <rationale>
CASPER — abstain: <rationale>
```

**Gotchas for implementation.** `Omit<A|B, K>` is non-distributive and collapses to common keys — `computeHash` needs `type ChainContent = ChainRecord extends infer R ? Omit<R,'hash'|'prevHash'> : never`. Zod v3 omits *absent* optional keys from output (it does not add `undefined`), which is exactly why `canonicalStringify`/`Object.keys` never hashed the dead `override` field — do not replace it with anything defaulted. Zod `z.object` strips unknown keys, so `z.union` order is safe only because `override` is required on `OverrideRecordSchema`.

## Testing Strategy

| Layer | What to test | Approach |
|-------|-------------|----------|
| Unit | `runHook` allow/deny across mode × decision × trivial; block-reason contains all three rationales + hash; 10k cap | `tests/claude-code-hook/index.test.ts`, injected `auditSink`/`now`/`evaluators` |
| Unit | `appendOverride` chain bookkeeping, day rollover, `ChainRecordSchema` round-trip | `tests/audit/audit-sink.test.ts` |
| Unit | `runAuditOverride`: unknown hash, missing/empty reason, target `decision:'allow'` → all reject **and write nothing** (assert byte-identical file + HEAD) | new `tests/cli/audit-override.test.ts` |
| Unit | Stats: 5 denies + 2 overrides → deny split 5, overrides 2, `denyRateProxy` denominator excludes overrides | `tests/cli/audit-stats.test.ts` |
| Integration | `verifyChain()` still valid over a mixed verdict+override chain; and over a **pre-P3 chain with no override records** (regression guard for decision #3) | `tests/audit/verify.test.ts` |
| Integration | `runMain(['audit','override',...])` exit codes; config without `mode` loads | `tests/cli/main.test.ts` |
| E2E | Real binary: `MAGI_MODE=enforced` + deny → stdout `permissionDecision:'deny'`, exit 0 | existing spawn-based hook test |

## Threat Matrix

| Boundary | Applicability | Reason |
|---|---|---|
| Documentation-like paths | N/A | No file classification changes; `isTrivial()`/`classify()` untouched. |
| Git repository selection | N/A | No VCS invocation; MAGI never runs the gated command. |
| Commit state | N/A | No index/worktree interaction. |
| Push state | N/A | No push or ref resolution. |
| PR commands | N/A | No PR automation. |

Process-integration risk here is the hook stdout contract itself, covered by the E2E row above (exact JSON shape, exit code, fail-open on malformed stdin) rather than by these VCS-oriented rows.

## Migration / Rollout

No data migration. Existing chains contain no override records and are unaffected (decision #3). `loadConfig()` casts JSON without validation, so a stale `"mode"` key in an operator's `magi.config.json` is inert, not an error. Rollout is opt-in per session via `MAGI_MODE=enforced`; rollback is unsetting one env var.

## Open Questions

None. The PreToolUse deny contract was resolved before this phase.
