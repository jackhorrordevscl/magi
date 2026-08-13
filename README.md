# MAGI — Multi-Agent Action Gating

MAGI is an independent, multi-perspective gate that rules allow/deny on
high-impact actions proposed by coding agents (and, in a future phase, CI/CD
pipelines) before they execute. Three independent evaluators — **Melchior**
(fact/consistency), **Balthasar** (blast radius to others + policy), and
**Casper** (actor risk/anomaly) — each cast one vote per proposed action; a
deterministic, table-driven severity classifier decides how much consensus
is required before an action is allowed.

This repository currently ships **v1, scope P0–P2**: deterministic gating
core, hash-chained audit log, a Claude Code `PreToolUse` hook adapter
running in **shadow mode**, and a human-grounded calibration corpus +
divergence harness. See [Scope](#scope-p0p2-this-repository) and
[Out of scope](#out-of-scope-p3p4--not-implemented-here) below for the
precise boundary.

## Status: local-only, shadow mode

This project has **no production deployment target yet**. It is being
tuned locally against the operator's own judgment before any enforcing
behavior ships. The Claude Code hook adapter runs in
`MAGI_MODE=shadow` — see [Shadow mode](#shadow-mode-always-allows-always-records)
for exactly what that means.

## Scope (P0–P2, this repository)

| Phase | What it delivers |
|---|---|
| P0 — domain core + audit | `ProposedAction` normalization, table-driven severity classification (`src/gating/severity.ts`), the trivial-scope read-only allowlist (`src/gating/allowlist.ts`), quorum consensus + verdict assembly (`src/gating/consensus.ts`, `src/gating/verdict.ts`), and the tamper-evident hash-chained audit sink (`src/audit/`). |
| P1 — shadow-mode hook | The Claude Code `PreToolUse` hook adapter (`claude-code-hook/index.ts`), wiring allowlist → severity → evaluators → consensus → verdict → audit into one pipeline, running in `MAGI_MODE=shadow`. |
| P2 — calibration + divergence harness | A local, human-grounded calibration corpus (`src/calibration/corpus.ts`), deterministic lexical exemplar retrieval (`src/calibration/selector.ts`), and a divergence harness (`src/calibration/divergence-harness.ts`) that proves the three evaluator facets genuinely disagree on designed-divergent fixtures and agree on controls — catching cosmetic persona collapse. |

Three independent evaluators back every non-trivial gated action:

- **Melchior** — fact/consistency (`src/gating/melchior.ts`)
- **Balthasar** — blast radius to others + policy (`src/gating/balthasar.ts`)
- **Casper** — actor risk/anomaly (`src/gating/casper.ts`)

Consensus/quorum rule (spec Requirement: Consensus and Quorum):
low/medium severity requires 2-of-3 `allow`; high/critical severity
requires a unanimous 3-of-3 `allow`. `abstain` never counts toward allow,
at any tier. Sync-tier evaluator timeout or transport error is treated as
`deny` (fail-closed), never `allow`.

## Shadow mode: always allows, always records

**`MAGI_MODE=shadow` never blocks a tool call, regardless of the computed
verdict.** If severity classification, all three evaluators, and consensus
resolution together compute `deny` for a critical action, the hook
adapter still allows the underlying Claude Code tool call to proceed.

What shadow mode *does* do, unconditionally, for every non-trivial gated
action: it durably appends the full verdict — decision, severity, all
three evaluator votes + rationales, actor, mode, timestamp — to the
hash-chained audit log (`.magi/audit/`) **before** the hook returns its
`allow` decision. This is what makes shadow mode useful even though it
never blocks: it measures what an enforcing gate *would have* decided,
against real day-to-day agent activity, without any risk of an
over-eager gate wedging a real workflow.

This is a deliberate two-step rollout (see `sdd/magi/design`'s P1 → P4
plan): observe and measure false-positive rate in shadow mode first,
build enough confidence in the evaluators' judgment (backed by a real
calibration corpus), and only then flip to enforcing. **No enforcing
behavior exists in this repository.**

Use `magi audit stats` to see the recorded verdict distribution and a
raw deny-rate proxy for the P1 evaluation period (see
[CLI commands](#cli-commands) below).

### Trivial-scope allowlist

Not every intercepted tool call is gated at all. A static, code-defined
allowlist (`src/gating/allowlist.ts`, scope documented in
`docs/trivial-allowlist-scope.md`) short-circuits **only** confirmed
read-only, zero-side-effect operations (file reads, `git log`/`git diff`,
grep/glob-style searches) straight to allow — no evaluator calls, no
audit record. This is what keeps the hook usable: gating every `Read`,
`Grep`, and `Glob` tool call through three model calls each would make
the adapter unusable in practice. Everything else — every mutation,
every execution, every command the allowlist can't positively confirm as
trivial — goes through the full severity/quorum pipeline with no
exception.

## Out of scope (P3/P4 — NOT implemented here)

The following are explicitly deferred to a future change, per
`sdd/magi/tasks`' own "out of scope" boundary and the local-only rollout
decision (`sdd/magi/design-decisions`):

- **CI/CD pipeline adapter** (async mode's Requirement: CI/CD Pipeline
  Adapter). There is no production pipeline to gate yet.
- **Async mode's bounded tool loop + human escalation** (a stronger model
  with real, bounded tool access, escalating ambiguous/high-severity
  verdicts to a human with a visible-failure timeout).
- **`--override-magi` CLI / audited human override** (Requirement: Audited
  Human Override). No enforcing mode exists yet for an override to matter
  against.
- **`MAGI_MODE=enforced` flip** (the design's own `MagiMode` enum already
  reserves the value for forward compatibility — `ProposedAction.mode`
  and audit records can carry it — but no code path in this repository
  ever blocks on it; the hook adapter's pipeline only implements shadow
  behavior).

Building any of the above now, against a pipeline and enforcement
posture that don't exist yet, would be premature — this is a deliberate
scope boundary, not an oversight.

## Placeholder values — revisit after the first real corpus

Two numeric thresholds in `magi.config.json` and the calibration harness
are explicit **placeholders**, confirmed as acceptable to proceed with
before any real calibration corpus exists (`sdd/magi/design-decisions`):

- **Selector top-K**: `tiers.sync.k = 5` (used, once calibration
  injection is wired), `tiers.async.k = 12` (currently unused — async
  mode itself is out of scope, see above).
- **Divergence harness floor**: `tiers.divergenceFloorPercent = 40` — the
  minimum fraction of designed-divergent fixtures the three evaluator
  facets must genuinely disagree on for `magi calibrate verify` to pass.

Both values are placeholders precisely because there is no real
calibration corpus yet to validate them against — they were never
derived from real operator judgment data. **Revisit both once the first
real calibration corpus exists** (built via `magi calibrate` / `magi
calibrate import`, see below), rather than treating either number as
load-bearing today.

## Setup

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test "tests/**/*.test.ts"
npm run build        # bundles src/cli/main.ts -> dist/magi.mjs
```

Requires Node.js >= 22 (developed and verified against Node v26's native
TypeScript strip-only execution — every class in this codebase assigns
constructor fields explicitly in the body, since parameter-property
shorthand is not supported by that execution mode).

## CLI commands

The `magi` binary (`src/cli/main.ts`, bundled to `dist/magi.mjs` by
`npm run build`, or run directly via `node src/cli/main.ts <command>`):

| Command | What it does |
|---|---|
| `magi calibrate` | Interviews the operator for one calibration exemplar (tag, severity, judgment narrative). Never writes without explicit confirmation. |
| `magi calibrate import <candidates.json>` | Reviews a JSON array of candidate exemplars one at a time, requiring per-entry confirmation before writing. Candidates already present (identical content) are skipped without prompting. |
| `magi calibrate verify --fixtures <fixtures.json>` | Runs the divergence harness against the real melchior/balthasar/casper evaluators and a JSON array of designed fixtures (`{id, kind: "divergent"\|"control", action, severity}[]`). No built-in fixture set ships yet — author your own from real judgment calls once you have some. |
| `magi audit verify` | Replays the hash chain under `.magi/audit/` and reports whether it is intact (tamper-evident, not tamper-proof — see `src/audit/verify.ts`). |
| `magi audit stats` | Reports verdict distribution (counts per decision, per severity tier) and a raw deny-rate proxy for the shadow-mode evaluation period. |

The calibration corpus (`.magi/calibration/`) and audit log
(`.magi/audit/`) are both local-only and already excluded via
`.gitignore` — the corpus contains the operator's real review-judgment
history and is never committed to a shared/remote repository.

## Claude Code hook wiring

Point Claude Code's `PreToolUse` hook configuration at
`claude-code-hook/index.ts` (run directly via `node
claude-code-hook/index.ts` — Node's native TypeScript support means no
build step is required for the hook itself). Set `MAGI_MODE=shadow` in
the hook's environment (or omit it — `shadow` is the default for any
unset or invalid value). The hook reads the tool-call payload from
stdin, always exits `0`, and prints a JSON `{"decision":"allow","reason":
"..."}` line to stdout describing what happened (trivial short-circuit,
or the recorded verdict's decision).

## Architecture references

- `sdd/magi/spec` — the formal requirements/scenarios this implementation
  is built against.
- `sdd/magi/design` — locked stack and architecture decisions.
- `sdd/magi/tasks` — the full phase-by-phase task breakdown.
- `docs/trivial-allowlist-scope.md` — the trivial-scope allowlist's
  confirmed boundary.
