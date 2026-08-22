# Delta Spec: magi-opencode-adapter

## Domain: opencode-adapter (New Capability)

No existing spec. This capability normalizes OpenCode `tool.execute.before` tool calls into a `ProposedAction`, runs them through the unmodified gating pipeline (`runHook`), and enforces the resulting verdict inside a long-lived OpenCode plugin process.

## ADDED Requirements

### Requirement: OpenCode Tool Calls Are Normalized Into ProposedAction

The adapter MUST normalize an OpenCode `tool.execute.before` payload (`input: { tool, sessionID, callID }`, `output: { args }`) into a `ProposedAction` with `source: 'coding_agent'`, reusing the existing discriminated union unchanged — no new `source` variant is introduced. Normalization MUST be a pure, unit-testable function separate from the plugin export, mirroring the `claude-code-hook/index.ts` two-layer split (`normalizeToProposedAction` / plugin entrypoint).

#### Scenario: A recognized OpenCode tool call normalizes to a coding_agent action

- GIVEN an OpenCode `tool.execute.before` payload with `input.tool` set to a known tool name and `output.args` containing the tool's arguments
- WHEN the adapter's normalization function runs
- THEN it returns a `ProposedAction` with `source: 'coding_agent'` and a `command` string derived from the tool name and arguments

#### Scenario: Normalization does not mutate or bypass ProposedActionSchema

- GIVEN any OpenCode payload accepted by normalization
- WHEN the resulting object is validated against `ProposedActionSchema`
- THEN validation succeeds with `source: 'coding_agent'` — the adapter never constructs an action shape the schema does not already accept

### Requirement: OpenCode-Owned Tool-Name Map Enables the Trivial Allowlist Short-Circuit

The adapter MUST own a tool-name → synthetic-command map scoped to OpenCode's own tool vocabulary (which differs from Claude Code's `Read`/`Grep`/`Glob` names). This map MUST live inside `opencode-adapter/`, not in `src/`, and MUST produce synthetic commands recognizable by `src/gating/allowlist.ts`'s existing trivial-allowlist rules so that read-only OpenCode tool calls short-circuit before any evaluator is invoked.

#### Scenario: A read-only OpenCode tool short-circuits through the trivial allowlist

- GIVEN an OpenCode tool call whose tool name maps to a read-only synthetic command via the adapter's tool-name map
- WHEN the action is evaluated by the unmodified gating pipeline
- THEN the action is classified as trivial, zero evaluator calls are made, and zero audit records are written, matching the existing allowlist short-circuit behavior

#### Scenario: An unmapped or non-trivial OpenCode tool call reaches full evaluation

- GIVEN an OpenCode tool call whose tool name is absent from the adapter's map, or whose synthesized command is not read-only
- WHEN the action is evaluated
- THEN the action proceeds through severity classification and evaluator consensus unchanged, same as any Claude Code non-trivial action

### Requirement: Enforced Deny Blocks By Throwing; Allow And Shadow Never Throw

Under `MAGI_MODE=enforced` with a consensus `deny` verdict, the adapter MUST block the tool call by throwing an `Error` whose message is built by the existing `buildBlockReason` (or an equivalent producing the same header-first, hash-and-override-first content). Under an `allow` verdict, or under `MAGI_MODE=shadow` regardless of verdict, the adapter MUST NOT throw — the tool call proceeds, identical in meaning to the Claude Code hook's `allow` output.

#### Scenario: Enforced mode blocks a deny verdict by throwing

- GIVEN mode resolves to `enforced`
- AND the gating pipeline assembles a verdict with `decision: 'deny'`
- WHEN the OpenCode adapter's `tool.execute.before` handler runs
- THEN it throws an `Error` whose message includes the audit hash, the override command, and all three evaluator rationales, and the tool call does not execute

#### Scenario: Enforced mode does not throw on an allow verdict

- GIVEN mode resolves to `enforced`
- AND the gating pipeline assembles a verdict with `decision: 'allow'`
- WHEN the OpenCode adapter's handler runs
- THEN it returns without throwing and the tool call proceeds

#### Scenario: Shadow mode never throws, even on a deny verdict

- GIVEN mode resolves to `shadow`
- AND the gating pipeline assembles a verdict with `decision: 'deny'`
- WHEN the OpenCode adapter's handler runs
- THEN it returns without throwing, the tool call proceeds, and the deny verdict is still recorded to the audit log

### Requirement: Adapter-Side Exceptions Fail Open

Any exception raised inside the adapter itself — malformed payload, normalization failure, audit-write error, evaluator crash surfacing as a rejection the pipeline does not already fail closed on — MUST be caught and MUST NOT propagate out of the `tool.execute.before` handler as a block. The adapter MUST allow the tool call to proceed and MUST surface the swallowed error on stderr for operator visibility. This exception-handling fail-open is distinct from, and MUST NOT be confused with, an evaluator `abstain` folding into a consensus `deny` — that case is a legitimate verdict and MUST still block under enforcement.

#### Scenario: A malformed OpenCode payload does not block the tool call

- GIVEN an OpenCode `tool.execute.before` payload that fails normalization (missing or malformed required fields)
- WHEN the adapter's handler processes it
- THEN the handler catches the resulting error, does not throw, the tool call proceeds, and the error is written to stderr

#### Scenario: An audit-write failure does not block the tool call

- GIVEN the gating pipeline completes evaluation but the audit sink write throws
- WHEN the adapter's handler processes the result
- THEN the handler catches the error, does not throw, and the tool call proceeds

#### Scenario: A consensus deny from evaluator abstention still blocks under enforcement

- GIVEN mode resolves to `enforced`
- AND one or more evaluators return `abstain`, folding into a consensus `decision: 'deny'` per existing consensus rules
- WHEN the adapter's handler runs
- THEN it throws and blocks the tool call — this is a legitimate deny verdict, not an adapter-side exception, and fail-open MUST NOT apply

### Requirement: Mode Is Resolved Per Invocation In A Long-Lived Process

Because an OpenCode plugin process is long-lived (unlike the Claude Code hook's one-shot process per tool call), the adapter MUST resolve `MAGI_MODE` fresh on every `tool.execute.before` invocation via the existing `resolveMode()`, never caching a resolved mode value across invocations within the process lifetime.

#### Scenario: A mode change takes effect on the next tool call without restarting OpenCode

- GIVEN the OpenCode plugin process is already running with `MAGI_MODE=shadow` resolved on a prior invocation
- AND the environment's `MAGI_MODE` is then changed to `enforced` (e.g. by the operator's shell/session)
- WHEN the next `tool.execute.before` invocation occurs in the same running process
- THEN the adapter resolves `enforced` for that invocation, without requiring the OpenCode process to restart

### Requirement: The Gating Pipeline Is Reused Unmodified

The adapter MUST call the existing `runHook` (or the equivalent shared pipeline entrypoint it wraps) as-is, passing the normalized `ProposedAction` and the same injectable seams (`evaluators`, `auditSink`, `now`, `corpus`, `configPath`) already exercised by `claude-code-hook/index.ts`. `src/gating/**`, `src/audit/**`, `src/calibration/**`, and `claude-code-hook/index.ts` MUST have zero diff as a result of this capability's implementation.

#### Scenario: OpenCode and Claude Code audit records share the same chain

- GIVEN both a Claude Code hook invocation and an OpenCode adapter invocation are evaluated in the same repository's `.magi/audit` directory
- WHEN `magi audit verify` runs
- THEN records from both adapters verify together in the same hash chain, both with `source: 'coding_agent'` and indistinguishable by that field

#### Scenario: No gating pipeline file is modified by this capability

- GIVEN the OpenCode adapter capability is implemented
- WHEN a diff of `src/gating/**`, `src/audit/**`, `src/calibration/**`, and `claude-code-hook/index.ts` is taken against the pre-change state
- THEN the diff is empty

## Domain: enforcing-mode-gate (Modified Capability)

Existing full spec: `openspec/specs/enforcing-mode-gate/spec.md`. Its requirements are currently written literally to Claude Code (e.g. "the PreToolUse hook adapter", "communicates ... to Claude Code"). This delta generalizes that wording to cover any gating adapter — including the OpenCode adapter added by this change — while leaving the underlying behavior (mode resolution, block-on-deny, full rationale inclusion, audit-recording-unaffected-by-mode) exactly as it is today.

## MODIFIED Requirements

### Requirement: Enforcing Mode Blocks Deny Verdicts

The system MUST block the tool call when `mode === 'enforced'` and the assembled verdict's `decision === 'deny'`. When `mode !== 'enforced'`, or the verdict is `allow`, behavior MUST be unchanged from current shadow-mode behavior (the gating adapter always allows the tool call to proceed). This requirement applies uniformly to every gating adapter (the Claude Code `PreToolUse` hook adapter, the OpenCode `tool.execute.before` adapter, and any future adapter) — each adapter enforces the block using its own client-specific mechanism, but the mode/verdict decision logic is identical across adapters.
(Previously: worded specifically as "the PreToolUse hook adapter" communicating to "Claude Code".)

#### Scenario: Enforced mode blocks a deny verdict

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'deny'`
- WHEN a gating adapter runs
- THEN the adapter communicates a deny/block outcome through its own client-specific mechanism (e.g. Claude Code's `permissionDecision: 'deny'` JSON output, or OpenCode's thrown `Error`) such that the tool call does not proceed

#### Scenario: Enforced mode does not affect an allow verdict

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'allow'`
- WHEN a gating adapter runs
- THEN the tool call proceeds, identical to shadow mode, regardless of which adapter is running

#### Scenario: Shadow mode never blocks

- GIVEN mode resolves to `shadow`
- AND consensus assembles a verdict with `decision: 'deny'`
- WHEN a gating adapter runs
- THEN the tool call proceeds (allow), and the deny verdict is recorded to the audit log only, regardless of which adapter is running

### Requirement: Block Includes Full Evaluator Rationale

When enforcing mode blocks an action, the reason communicated back through the gating adapter's client-specific mechanism MUST include the full rationale from all three evaluators (Melchior, Balthasar, Casper) — not only the aggregate decision and a pointer to the audit log. This requirement applies to every gating adapter; each adapter is responsible for ensuring its client-specific transport (hook JSON output, thrown error message, or equivalent) actually surfaces this content to the operator.
(Previously: worded specifically as "the reason communicated back to Claude Code".)

#### Scenario: Blocked reason includes all evaluator rationales

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'deny'` from Melchior, Balthasar, and Casper evaluations
- WHEN a gating adapter builds the block reason
- THEN the reason text includes each evaluator's individual verdict and rationale for this action, regardless of which adapter's transport carries it

## Out of Scope (carried from proposal)

Any change to the gating pipeline itself (`src/gating/**`, `src/audit/**`, `src/calibration/**` remain untouched). No new `ProposedAction.source` union variant — the OpenCode adapter reuses `'coding_agent'`. No npm publication of MAGI for `opencode.json`'s `plugin`-key registration — v1 registers only via `.opencode/plugins/` local file placement. No shared normalization layer extracted between the Claude Code hook and the OpenCode adapter. No coverage of other OpenCode hooks (`tool.execute.after`, permission/session events). No change to the audit record format or hash-chain structure. The OpenCode subagent interception gap (issue #5894) is not closed by this spec — it is documented as an unresolved risk to be reproduced or refuted at design time, and is a v1 completion gate, not a spec requirement.
