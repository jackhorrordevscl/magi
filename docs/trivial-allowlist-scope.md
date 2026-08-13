# Trivial-Scope Allowlist — Scope Addendum

This is a lightweight spec clarification for `src/gating/allowlist.ts`, not a
new spec document. It records the confirmed scope boundary for the trivial
allowlist referenced by design `sdd/magi/design` (#1008).

## Scope

The trivial allowlist covers **only** read-only, zero-side-effect local
operations:

- File reads (`cat`, `head`, `tail`, `less`, `more`, `wc`).
- `git log` / `git diff` in their read-only form (these subcommands never
  mutate repository state).
- Grep/glob-style searches (`grep`, `egrep`, `fgrep`, `rg`, `ag`, and `find`
  used purely as a search — never with a mutating action flag such as
  `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprintf`).

**Everything else, with no exception, goes through the full severity/quorum
voting pipeline built in later PRs.** This includes, but is not limited to:
any write, delete, network, install, or execution-of-arbitrary-code
operation, any command the Phase 2 parser can't decompose, and any
compound chain where even one sub-command falls outside the set above.

## Non-negotiable properties

- The allowlist is **static and code-defined** (`src/gating/allowlist.ts`).
  It is not model-driven and not configurable at runtime by an adapter.
- An adapter's self-reported `actionType`/severity hint can never make an
  action trivial on its own — `isTrivial()` re-derives trivial-ness from the
  actual parsed command shape (via the Phase 2 shell parser), so a
  mislabeled or malicious adapter tag can't smuggle a mutating command
  through as "trivial".
- `infra_pipeline` actions (CI adapter — deferred to a later PR) are never
  trivial in this PR's scope; there is no command shape to verify yet.

## Wiring (deferred)

`isTrivial()` is intended to be the first short-circuit step in the Claude
Code hook adapter. That wiring happens in the Phase 9 hook adapter PR, not
this one — see the `// TODO(PR4)` marker in `src/gating/allowlist.ts`.
