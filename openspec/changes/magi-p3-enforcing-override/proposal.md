# Proposal: P3 — Enforcing Mode + Audited Human Override

## Intent

MAGI computes real deny verdicts but never acts on them — `runHook()` returns `allow: true` on every path. It is a recorder, not a gate. P3 turns enforcement on and, in the same change, ships the operator escape hatch that makes it safe to live with. The two are coupled by the prior design's own reasoning: an override is meaningless with nothing to override.

## Scope

### In Scope

- Block when `mode === 'enforced' && verdict.decision === 'deny'`; shadow behavior otherwise unchanged.
- `MAGI_MODE` env var becomes the sole mode authority. Delete `mode` from `magi.config.json`, `MagiConfig`, `DEFAULT_CONFIG` — no fallback.
- `magi audit override`: targets a denied record, requires non-empty `--reason`, appends a new chained override record.
- `magi audit stats`: override count/rate as a distinct metric.
- Tests for blocking, override append, chain re-verify, stats. README scope update.

### Out of Scope

- Async tool loop / human escalation (P4).
- CI/CD pipeline adapter (P4).
- Override authentication or operator identity (local single-operator v1).

## Capabilities

### New Capabilities

- `enforcing-mode-gate`: mode resolution and deny-blocking in the PreToolUse adapter.
- `audited-human-override`: CLI override of a recorded deny as an appended audit event.

### Modified Capabilities

- None. `openspec/specs/` does not exist; archived Engram spec `sdd/magi/spec` (#1006) requirements 8/9/10 are the historical statement these two capabilities now specify concretely.

## Approach

**Enforcing mode.** Branch in `runHook()` on the already-parsed `mode` and existing `verdict.decision`. Consensus/severity/quorum are built and tested — nothing new is decided, only honored. `resolveMode()` stays the one reader; the dead config field is removed rather than wired, so enforcement cannot be flipped by committing a file.

**Override.** The hash chain forbids mutating a written record, so an override is a **new appended record** referencing the original's `seq`/`hash` plus the reason. In-place mutation of `AuditRecordSchema.override` is explicitly rejected — it would require rewriting every downstream hash and defeat the guarantee `verifyChain()` exists to provide. The unused `override` field is repurposed or removed in design, not left ambiguous.

**Audit semantics.** An overridden deny stays a deny in the decision split. `denyRateProxy` is unaffected; override is separate metadata beside it.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `claude-code-hook/index.ts` | Modified | Deny branch in `runHook()`; `writeDecision()` block shape |
| `src/audit/record.ts` | Modified | Override record shape / `override` field resolution |
| `src/audit/fs-append-sink.ts` | Modified | Append path for override records |
| `src/audit/verify.ts` | Verified | Chain must verify with override records present |
| `src/cli/audit-override.ts` | New | `magi audit override` command |
| `src/cli/main.ts` | Modified | Wire subcommand; drop `MagiConfig.mode` |
| `src/cli/audit-stats.ts` | Modified | Override metric |
| `magi.config.json`, `README.md`, `tests/` | Modified | Remove `mode` key; scope docs; coverage |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Claude Code PreToolUse deny/block JSON contract unverified in this repo | High | **Design-phase research item — do not guess.** Blocking design task |
| Enforcing mode blocks legitimate work | Med | Default stays `shadow`; opt-in per session; override CLI recovers |
| API outage hard-blocks the agent (fail-closed) | Med | Unset `MAGI_MODE` to fall back to shadow instantly |
| Override record shape breaks `verifyChain()` | Low | Chain tests extended before the CLI lands |
| Removing `config.mode` breaks a reader | Low | Confirmed dead today; typecheck + tests catch it |

## Rollback Plan

Enforcement is inert unless `MAGI_MODE=enforced` is set — operational rollback is unsetting one env var, no redeploy. Code rollback is `git revert` of P3 commits; written audit records stay valid because the chain is append-only and override records are additive. Restoring the `mode` config key is a one-line revert.

## Dependencies

- Verified Claude Code PreToolUse hook deny/block response contract (external docs, not in this repo).

## Success Criteria

- [ ] With `MAGI_MODE=enforced` a deny actually blocks; unset, behavior is identical to today's shadow mode.
- [ ] `mode` exists in exactly one place; no `mode` key in `magi.config.json` or `MagiConfig`.
- [ ] `magi audit override` refuses to run without a non-empty `--reason`.
- [ ] After an override, `magi audit verify` passes and the original deny record is byte-unchanged.
- [ ] `magi audit stats` reports the deny in the deny split and the override as a separate metric.
