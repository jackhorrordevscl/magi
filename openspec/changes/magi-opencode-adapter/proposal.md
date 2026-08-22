# Proposal: OpenCode Adapter

## Intent

MAGI gates exactly one agent surface today: Claude Code, through `claude-code-hook/index.ts` registered as a `PreToolUse` hook. An operator working in OpenCode gets **zero** gating — no trivial allowlist, no severity classification, no quorum, and no audit record. The same operator, the same repository, the same destructive `git push --force`: gated in one client, invisible in the other.

The gap is an adapter, not a pipeline change. Everything from `isTrivial` onward is already adapter-agnostic by construction: `ProposedAction` is a discriminated union on `source`, and `runHook` takes an action plus injectable seams (`evaluators`, `auditSink`, `now`, `corpus`, `configPath`) with no Claude Code coupling anywhere in its body. The only client-specific code in `claude-code-hook/index.ts` is (a) payload → `ProposedAction` normalization and (b) how a `deny` is communicated back.

Success: an OpenCode operator gets the same verdicts, the same severity tiers, and entries in the same audit hash chain as a Claude Code operator — with `src/` untouched.

## Scope

### In Scope

- New standalone module `opencode-adapter/index.ts`, mirroring `claude-code-hook/index.ts`'s two-layer split: pure, unit-testable normalization + a thin OpenCode-shaped plugin export.
- Normalization of OpenCode's confirmed `tool.execute.before` payload (`input: { tool, sessionID, callID }`, `output: { args }`) into a `ProposedAction` with `source: 'coding_agent'`.
- An OpenCode-owned tool-name → synthetic-command map (OpenCode's own tool names, which are **not** Claude Code's `Read`/`Grep`/`Glob`), so the trivial-allowlist short-circuit is actually reachable and read-only tools do not cost three model calls.
- Enforcement: `throw new Error(buildBlockReason(...))` on an enforced deny; no-op return on allow.
- Fail-open on any adapter-side exception, matching design decision #6 — our own bug never blocks the operator.
- `MAGI_MODE` resolution per invocation (the plugin is long-lived, unlike the one-shot hook process).
- Registration/installation documentation (`.opencode/plugins/`, plural, local) plus a `MANUAL.md` section.
- Tests mirroring `tests/claude-code-hook/index.test.ts` (normalization table + deny/allow/shadow/fail-open behavior).

### Out of Scope

- **Any change to the gating pipeline.** `src/gating/allowlist.ts`, `severity.ts`, `evaluator-port.ts`, `verdict.ts`, `consensus.ts`, the three evaluators, `src/audit/fs-append-sink.ts`, and `src/calibration/exemplar-injection.ts` are all untouched. `runHook` is called, never modified.
- **A new `source: 'opencode'` union variant.** Decided: reuse `'coding_agent'`, same as Claude Code, so the existing allowlist short-circuit and severity table apply unchanged (observation #1096).
- **Extracting a shared normalization layer between the two adapters.** Deferred as premature. Re-reading `claude-code-hook/index.ts` for this proposal confirmed the divergence is real (different payload shape, different tool-name vocabulary, different output mechanism, different process model) — a shared abstraction today would be shaped by one client and bent for the other.
- **Publishing MAGI to npm** so the `plugin` key in `opencode.json` could reference it. The package is `private: true`; v1 registers locally.
- Other OpenCode hooks (`tool.execute.after`, permission/session events).
- Closing the subagent interception gap (see Risks — documented, not fixed).
- Any audit record format or chain change.

## Capabilities

### New Capabilities

- `opencode-adapter`: normalizes OpenCode `tool.execute.before` tool calls into `ProposedAction`, runs them through the existing gating pipeline, and blocks an enforced deny by throwing, with fail-open on adapter error.

### Modified Capabilities

- `enforcing-mode-gate`: its requirements are written Claude-Code-literally — "the PreToolUse hook adapter", "always report `allow` to Claude Code", "the reason communicated back to Claude Code". A second adapter requires generalizing these to *a gating adapter* with an adapter-specific block mechanism, while keeping the Single Mode Source and Audit-Recording-Unaffected-By-Mode requirements exactly as they are. This is a spec-level change and needs a delta spec.
- `audited-human-override`, `non-git-threat-matrix`, `multi-provider-evaluators`, `evaluator-config-layer`, `evaluator-config-tui`: **None.** Severity classification reads the synthetic command string, the override hint is a CLI invocation, and evaluator config is adapter-independent.

## Approach

**Fixed by this proposal:**

1. **A standalone mirror module, not a refactor.** `opencode-adapter/index.ts` sits beside `claude-code-hook/index.ts` as a peer entrypoint. Neither imports the other.
2. **`runHook` is called as-is.** If the adapter turns out to need a change inside `runHook`, that is a signal to stop and re-open the design, not to edit it opportunistically.
3. **`source: 'coding_agent'`** — no new union variant.
4. **Deny throws, allow returns, shadow mode never throws.** Shadow mode records a verdict and lets the tool call proceed, identical in meaning to the hook's `allow` output.
5. **Adapter-side exceptions are always caught and swallowed into allow** (fail-open), surfaced on stderr for operator visibility. An evaluator `abstain` folding into a consensus deny still blocks under enforcement — that asymmetry is preserved.
6. **The OpenCode tool-name map lives in this adapter**, not in `src/`.

**Left to `sdd-design`:**

- The exact plugin export shape, and how a `.ts` module importing `../src/**/*.ts` loads under OpenCode's runtime. The Claude Code hook gets away with raw `.ts` imports because it is an unbundled entrypoint invoked as `node claude-code-hook/index.ts` under Node 22 type stripping; an in-process plugin loaded by OpenCode has no such guarantee, and may need a built artifact and/or an `esbuild.config.mjs` entry.
- Whether `capReason`'s 10 000-character cap applies. That cap is a documented Claude Code contract; OpenCode has no documented equivalent for a thrown `Error` message.
- Whether OpenCode surfaces a thrown plugin error message verbatim to the agent (and to the user) — the block reason is only useful if the evaluator rationales and the override hash survive.
- Where mode/env resolution sits in a long-lived plugin process.
- Registration detail: file placement, naming, and what the operator actually copies or symlinks.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `opencode-adapter/index.ts` | New | Normalization + plugin export + block/fail-open logic |
| `tests/opencode-adapter/index.test.ts` | New | Mirrors the Claude Code hook's test structure |
| `src/gating/**`, `src/audit/**`, `src/calibration/**` | Unchanged | Reused verbatim; a change here invalidates the proposal |
| `claude-code-hook/index.ts` | Unchanged | Not refactored, not shared from |
| `esbuild.config.mjs` | Possibly modified | Only if design concludes the plugin needs a built artifact |
| `package.json` | Possibly modified | `@opencode-ai/plugin` as a **dev**/type-only dependency if types are imported; no new runtime dependency intended |
| `MANUAL.md` | Modified | New OpenCode installation/registration section |
| `openspec/specs/enforcing-mode-gate/spec.md` | Modified (delta) | Generalized from Claude-Code-only wording |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Subagent interception gap (OpenCode issue #5894).** `tool.execute.before` may not intercept tool calls made by subagents launched via `task`, which would mean gating covers the main agent but not delegated work. This is recorded as an **area of risk not resolved** — neither a confirmed bug (the OpenCode maintainer disputed that it was reproducible) nor a non-issue (there is real precedent for related permission bypasses in the same repository: #3808, #4066, #6396, and #7473 with an attached PR). | Unresolved | Must be revisited before v1 ships. Design phase reproduces it directly against the installed OpenCode version and records the observed behavior; if confirmed, either document the coverage boundary explicitly or scope a mitigation. It does not block proposal or spec work, but it must not be silently downgraded to "handled" |
| The `.ts`-importing plugin does not load in OpenCode's runtime | Med | Resolved at design against a real installed OpenCode, before any implementation; may add a built artifact (see Approach) |
| Multi-line thrown-error block reason is truncated or reshaped, losing the audit hash / override hint | Med | Design verifies what OpenCode actually surfaces; the header-first ordering `buildBlockReason` already uses keeps hash and override hint at the front |
| Three model calls per non-trivial tool call make OpenCode feel unusably slow (in-process, blocking the agent loop) | Med | The OpenCode tool-name map is designed specifically to make the trivial-allowlist short-circuit reachable for read-only tools; measured at verification |
| Two adapters drift — a normalization fix lands in one and not the other | Med (accepted) | Accepted consequence of deferring a shared layer. Tests mirror structure so the divergence is visible; revisit extraction after a third adapter or the first real drift bug |
| `@opencode-ai/plugin` contract changes under us | Low | Contract verified twice against primary sources — GitHub `dev` branch and published `@opencode-ai/plugin@1.18.18` on npm — matching byte for byte (observation #1088). Types imported type-only where possible so a version bump is a typecheck failure, not a runtime break |

## Rollback Plan

Purely additive. `git revert` removes `opencode-adapter/`, its tests, the `MANUAL.md` section, and the `enforcing-mode-gate` delta. Nothing in `src/` changed, so `magi calibrate`, `magi audit`, `magi tui`, `dist/magi.mjs`, and the Claude Code hook are unaffected by construction. An operator disables it faster than a revert: delete the plugin file from `.opencode/plugins/`. Audit records already written by the OpenCode adapter stay valid — they are the same `AuditRecord` shape in the same chain, with `source: 'coding_agent'`, indistinguishable by design.

## Dependencies

- OpenCode installed locally, for design-phase verification of plugin loading, error surfacing, and the subagent gap.
- `@opencode-ai/plugin` (contract confirmed at `1.18.18`) — types only; not intended as a runtime dependency.
- No change to `zod`, `@anthropic-ai/sdk`, or `blessed`.

## Success Criteria

- [ ] A non-trivial tool call in OpenCode under `MAGI_MODE=enforced` with a consensus deny does not execute, and the operator sees the severity, all three evaluator rationales, the audit hash, and the override command.
- [ ] The same tool call under `MAGI_MODE=shadow` executes normally and still produces an audit record.
- [ ] Read-only OpenCode tools short-circuit through the trivial allowlist with zero evaluator calls and zero audit writes.
- [ ] Any adapter-side failure (malformed payload, audit write error, evaluator crash) allows the tool call and never throws out of the plugin.
- [ ] Audit records from OpenCode and from Claude Code land in the same chain and verify together under `magi audit verify`.
- [ ] `src/gating/**`, `src/audit/**`, `src/calibration/**`, and `claude-code-hook/index.ts` have zero diff.
- [ ] Every existing test in `tests/` passes unchanged.
- [ ] The subagent interception gap has been reproduced-or-refuted against a real OpenCode install, with the observed behavior recorded, before v1 is called done.
