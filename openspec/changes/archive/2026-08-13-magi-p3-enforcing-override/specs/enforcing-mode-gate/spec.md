# Enforcing Mode Gate Specification

## Purpose

Defines how MAGI resolves its operating mode and how the PreToolUse hook adapter must actually block a tool call when consensus computes a `deny` verdict in enforcing mode.

## Requirements

### Requirement: Single Mode Source

The system MUST resolve `mode` exclusively from the `MAGI_MODE` environment variable. `magi.config.json` MUST NOT contain a `mode` key, and `MagiConfig`/`DEFAULT_CONFIG` MUST NOT expose a `mode` field.

#### Scenario: MAGI_MODE unset

- GIVEN `MAGI_MODE` is not set in the environment
- WHEN `resolveMode()` runs
- THEN mode resolves to `shadow`

#### Scenario: MAGI_MODE set to enforced

- GIVEN `MAGI_MODE=enforced` is set in the environment
- WHEN `resolveMode()` runs
- THEN mode resolves to `enforced`

#### Scenario: Config file has no effect on mode

- GIVEN `magi.config.json` contains no `mode` key (per schema)
- WHEN the CLI loads config
- THEN no code path reads a `mode` value from the config object

### Requirement: Enforcing Mode Blocks Deny Verdicts

The system MUST block the tool call when `mode === 'enforced'` and the assembled verdict's `decision === 'deny'`. When `mode !== 'enforced'`, or the verdict is `allow`, behavior MUST be unchanged from current shadow-mode behavior (always report `allow` to Claude Code).

#### Scenario: Enforced mode blocks a deny verdict

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'deny'`
- WHEN the PreToolUse hook adapter runs
- THEN the hook adapter communicates a deny/block outcome to Claude Code such that the tool call does not proceed

#### Scenario: Enforced mode does not affect an allow verdict

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'allow'`
- WHEN the PreToolUse hook adapter runs
- THEN the tool call proceeds, identical to shadow mode

#### Scenario: Shadow mode never blocks

- GIVEN mode resolves to `shadow`
- AND consensus assembles a verdict with `decision: 'deny'`
- WHEN the PreToolUse hook adapter runs
- THEN the tool call proceeds (allow), and the deny verdict is recorded to the audit log only

### Requirement: Block Includes Full Evaluator Rationale

When enforcing mode blocks an action, the reason communicated back to Claude Code MUST include the full rationale from all three evaluators (Melchior, Balthasar, Casper) — not only the aggregate decision and a pointer to the audit log.

#### Scenario: Blocked reason includes all evaluator rationales

- GIVEN mode resolves to `enforced`
- AND consensus assembles a verdict with `decision: 'deny'` from Melchior, Balthasar, and Casper evaluations
- WHEN the hook adapter builds the block reason
- THEN the reason text includes each evaluator's individual verdict and rationale for this action

### Requirement: Audit Recording Unaffected By Mode

The system MUST continue to write an audit record for every evaluated action regardless of mode, unchanged by whether the action was blocked or allowed.

#### Scenario: Enforced-mode block is still audited

- GIVEN mode resolves to `enforced` and the verdict is `deny`
- WHEN the hook adapter blocks the tool call
- THEN an audit record for the deny is appended to the hash chain, same as in shadow mode
