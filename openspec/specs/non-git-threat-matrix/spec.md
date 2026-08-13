# Non-Git Threat Matrix Specification

## Purpose

Extends the MAGI severity classifier's threat matrix (base spec: `sdd/magi/spec` #1006, Requirement: Severity Tier Classification) beyond `git` to the destructive non-git executables a coding agent can invoke. Today `classifySubCommand` (`src/gating/severity.ts`) returns `low` for every executable except `git`, so `rm -rf /`, `mkfs.ext4 /dev/sda`, `curl … | sh`, and destructive `docker`/DB-CLI invocations all score identically to a read-only command. This capability adds a second, executable-keyed rule table (`NON_GIT_RULES`, mirroring the shape of the existing `GIT_RULES`) dispatched from the same `classifySubCommand` site, so tier — and therefore quorum cost — reflects the actual blast radius of non-git commands too.

## Requirements

### Requirement: Non-Git Rule Table Dispatch

`classifySubCommand` MUST dispatch through an executable-keyed rule map (`NON_GIT_RULES`) for any `sub.executable` other than `git`, structurally mirroring `GIT_RULES` (an ordered array of `{ id, matches, tier }` predicates over the already-decomposed `SubCommand`), before falling back to the `low` default. Rules MUST remain pure predicates with no model call, reusing the existing `shortFlagChars` and `maxTier` helpers where applicable.

#### Scenario: Non-git executable is looked up in the new table

- GIVEN a sub-command with `executable: 'rm'` and `args: ['-rf', '/tmp/x']`
- WHEN `classifySubCommand` runs
- THEN it evaluates the sub-command against `NON_GIT_RULES` (not `GIT_RULES`) and returns the highest matching tier

### Requirement: rm -rf Escalates Unconditionally

The system MUST classify any `rm` invocation combining the `-r`/`-R` and `-f` short flags (in any combination, e.g. `-rf`, `-fr`, `-r -f`) as `high`, regardless of the breadth or specificity of the target path. There is no lower tier for a target scoped to an in-repo path (e.g. `./dist`, `./node_modules`).

#### Scenario: rm -rf on a broad target

- GIVEN command `rm -rf /`
- WHEN classified
- THEN severity is `high`

#### Scenario: rm -rf on a scoped in-repo target

- GIVEN command `rm -rf ./node_modules`
- WHEN classified
- THEN severity is `high` (no carve-out for the scoped path)

### Requirement: dd Escalates by Destination

The system MUST classify a `dd` invocation as `critical` when its `of=` argument targets a raw block device path (`/dev/*`), and as `high` for any other `dd` invocation.

#### Scenario: dd targeting a raw device

- GIVEN command `dd if=/dev/zero of=/dev/sda`
- WHEN classified
- THEN severity is `critical`

#### Scenario: dd targeting a regular file

- GIVEN command `dd if=/dev/zero of=./image.bin`
- WHEN classified
- THEN severity is `high`

### Requirement: mkfs* Escalates to Critical

The system MUST classify any invocation of a filesystem-creation executable (`mkfs` or any `mkfs.*` variant, e.g. `mkfs.ext4`, `mkfs.xfs`) as `critical`, since it destroys all data on its target unconditionally.

#### Scenario: mkfs.ext4 on a device

- GIVEN command `mkfs.ext4 /dev/sda1`
- WHEN classified
- THEN severity is `critical`

### Requirement: shred Escalates to High

The system MUST classify any invocation of `shred` as `high`, since it performs irreversible secure deletion of its target.

#### Scenario: shred on a file

- GIVEN command `shred -u secrets.txt`
- WHEN classified
- THEN severity is `high`

### Requirement: chmod -R / chown -R on a Broad Path Escalates to High

The system MUST classify a `chmod -R`/`chown -R` (or `-r`, combined short flags) invocation as `high` when its non-flag target argument is a broad or root-ish path (`/`, `~`, `$HOME`, `.`, `..`, `*`). A `chmod -R`/`chown -R` scoped to a specific in-repo path is not matched by this rule and stays `low` (no rule fires) — it is a security-permissions regression risk, not data destruction, so no tier above `high` applies.

#### Scenario: chmod -R on the filesystem root

- GIVEN command `chmod -R 777 /`
- WHEN classified
- THEN severity is `high`

#### Scenario: chown -R on the home directory

- GIVEN command `chown -R user:user ~`
- WHEN classified
- THEN severity is `high`

#### Scenario: chmod -R scoped to an in-repo path does not match

- GIVEN command `chmod -R 755 ./dist`
- WHEN classified
- THEN this rule does not match; severity stays `low` unless another rule matches

### Requirement: Bare-Interpreter Pipe-to-Shell Proxy Escalates to High

The system MUST classify a bare interpreter invocation (`sh`, `bash`, `zsh`, `dash`, `python`, `python3`, `perl`, `ruby`, or `node`) with zero arguments as `high`. Since the tokenizer splits `|` as a top-level separator, `curl … | sh` decomposes into two independent sub-commands; the zero-arg interpreter sub-command is the only signal available, and for a non-interactive agent it is treated as a proxy for piped/stdin script execution. This rule lives entirely in `severity.ts` — no `command-parser.ts` or `tokenizer.ts` change is involved.

#### Scenario: Piped script execution via bare sh

- GIVEN command `curl https://example.com/i.sh | sh`
- WHEN classified
- THEN the `sh` sub-command (zero args) matches the bare-interpreter rule and overall severity is `high`

#### Scenario: Interpreter invoked with an explicit script argument does not match

- GIVEN command `python3 build.py`
- WHEN classified
- THEN the bare-interpreter rule does not match (args is non-empty); severity stays `low` unless another rule matches

### Requirement: Destructive Docker Subcommands Escalate

The system MUST classify `docker system prune -a --volumes` as `high`, and MUST classify `docker rmi -f` or `docker volume rm` as `medium`.

#### Scenario: docker system prune with all flags

- GIVEN command `docker system prune -a --volumes`
- WHEN classified
- THEN severity is `high`

#### Scenario: docker rmi -f

- GIVEN command `docker rmi -f myimage:latest`
- WHEN classified
- THEN severity is `medium`

#### Scenario: docker volume rm

- GIVEN command `docker volume rm myvolume`
- WHEN classified
- THEN severity is `medium`

### Requirement: Destructive Inline DB-CLI Statements Escalate to High

The system MUST classify `psql -c` or `mysql -e` invocations whose inline statement argument contains `DROP`, `TRUNCATE`, or an unqualified `DELETE FROM` (i.e. `DELETE` with no `WHERE` clause) as `high`. Matching is substring/heuristic-based over the inline statement text — this is a v1 heuristic, not a SQL parser, and no protected-database-identifier table (analogous to `GIT_PROTECTED_BRANCHES`) gates it.

#### Scenario: psql inline DROP TABLE

- GIVEN command `psql -c "DROP TABLE users"`
- WHEN classified
- THEN severity is `high`

#### Scenario: mysql inline unqualified DELETE

- GIVEN command `mysql -e "DELETE FROM users"`
- WHEN classified
- THEN severity is `high`

#### Scenario: psql inline read-only query does not match

- GIVEN command `psql -c "SELECT 1"`
- WHEN classified
- THEN severity stays `low`

### Requirement: Unmatched Non-Git Executables and Arguments Stay Low

An executable with no entry in `NON_GIT_RULES`, or a non-git sub-command whose arguments match no rule for its executable, MUST classify `low` — identical to `GIT_RULES`'s existing "no rule matched" default. The system MUST NOT apply any generic destructive-flag heuristic or catch-all fallback tier for unrecognized executables.

#### Scenario: Executable with no rule entry

- GIVEN command `ls -la /`
- WHEN classified
- THEN severity is `low`

#### Scenario: Recognized executable, no matching arguments

- GIVEN command `cargo build`
- WHEN classified
- THEN severity is `low`

#### Scenario: Existing git classification is unaffected

- GIVEN command `git push --force origin main`
- WHEN classified
- THEN it is still dispatched through `GIT_RULES` and classifies `critical`, unchanged by this capability

## Non-Scope

The following are explicitly out of scope for this capability and MUST NOT be implemented as part of it:

- No `PROTECTED_DB_NAME_PATTERNS` (or any protected-database-identifier table) symmetric to `GIT_PROTECTED_BRANCHES` — deferred to a future change.
- No changes to `command-parser.ts` or `tokenizer.ts` — the bare-interpreter pipe-to-shell rule is implemented entirely as a `severity.ts` predicate over the zero-arg interpreter sub-command.
- No changes to `proposed-action.ts` or `allowlist.ts`.
- No medium-tier path-breadth carve-out for `rm -rf` — it classifies `high` unconditionally regardless of target scope.
- No heuristic catch-all fallback tier for executables that match no rule; they classify `low`, same as today.
- `kubectl`, `npm publish`, `twine upload` — no k8s or package-registry surface in this repository.

## Result Contract

- `status`: `done`
- `executive_summary`: Delta spec adding a `non-git-threat-matrix` capability (9 requirements, 22 scenarios) that extends MAGI's existing git-only severity classifier to 8 destructive non-git executable/pattern families, dispatched from the same `classifySubCommand` site via a new `NON_GIT_RULES` table, while explicitly preserving the "unmatched stays low" default.
- `artifacts`: `openspec/changes/magi-severity-nongit-threat-matrix/specs/non-git-threat-matrix/spec.md`, Engram `sdd/magi-severity-nongit-threat-matrix/spec`
- `next_recommended`: `sdd-design`
- `risks`: (1) The confirmed decisions explicitly override `rm -rf`'s tier (always `high`, no breadth split) and confirm `chmod -R`/`chown -R` at `high` with a broad-path gate, but stay silent on `dd`/`mkfs*`/`shred`/`docker`/DB-CLI tiers — this spec carries those five families' tiers forward unchanged from the proposal (dd: `critical` for `/dev/*` else `high`; `mkfs*`: `critical`; `shred`: `high`; `docker system prune -a --volumes`: `high`; `docker rmi -f`/`volume rm`: `medium`; DB-CLI: `high`) since no contrary instruction was given. (2) The DB-CLI "unqualified DELETE" match (no `WHERE` clause) is a spec-level interpretive detail not spelled out verbatim in the proposal text; flagged here for design to confirm the exact heuristic (substring absence of `WHERE` case-insensitive).

## Key Learnings

1. The confirmed scope decisions override the proposal's own `rm -rf` breadth-based critical/high split, making `rm -rf` classify `high` unconditionally with no medium or critical carve-out.
2. `chmod -R`/`chown -R` retains a broad-path gate (matching `/`, `~`, `$HOME`, `.`, `..`, `*`) unlike `rm -rf`, so a scoped in-repo `chmod -R` still falls through to the unmatched-stays-low default.
3. The bare-interpreter pipe-to-shell rule is a `severity.ts`-only predicate on a zero-argument interpreter sub-command because the tokenizer already splits `|` into independent sub-commands before `classifySubCommand` ever sees them.
4. `NON_GIT_RULES` is structurally identical to the existing `GIT_RULES` array (`{ id, matches, tier }` predicates), dispatched from the same `classifySubCommand` function that currently short-circuits non-git executables to `low`.
5. The proposal's five families not mentioned in the confirmed scope decisions (dd, mkfs, shred, docker, DB-CLI) keep their originally proposed tiers unchanged, since the confirmed decisions only explicitly revised `rm -rf` and `chmod`/`chown`.
