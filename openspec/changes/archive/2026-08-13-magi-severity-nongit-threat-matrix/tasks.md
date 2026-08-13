# Tasks: Non-Git Threat Matrix in the Severity Classifier

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~215 (PR 1) + ~235 (PR 2) = ~450 total |
| 400-line budget risk | High (total exceeds 400; each PR individually stays under budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (sudo/doas dispatch normalization + `SubCommandRule`/`executableName` foundation + filesystem/device families: rm, dd, mkfs, shred, chmod/chown) -> PR 2 (interpreter/docker/DB-CLI families + composition/regression tests) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High (aggregate) / Low (per PR)

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `normalizeSudoPrefix` dispatch normalization + `SubCommandRule` rename/widen + `executableName` + `classifySubCommand` dispatch rewrite | PR 1 | `npm test -- tests/gating/severity.test.ts -t "dispatch\|sudo"` | N/A — pure unit tests over `classify(action(...))` | Revert the dispatch/type edits in `src/gating/severity.ts`; `GIT_RULES` behavior is unchanged by construction (decision 1) |
| 2 | Filesystem/device `NON_GIT_RULES` families: rm, dd, mkfs, shred, chmod/chown + `BENIGN_DEVICES` | PR 1 | `npm test -- tests/gating/severity.test.ts -t "rm\|dd\|mkfs\|shred\|chmod\|chown"` | N/A — pure unit tests | Revert the five rule entries + `BENIGN_DEVICES` const; foundation (Unit 1) stays valid standalone with an empty `NON_GIT_RULES` |
| 3 | Interpreter/docker/DB-CLI `NON_GIT_RULES` families: bare interpreter, 3 docker rules, psql/mysql inline SQL + `inlineSqlOperands`/`hasDestructiveSql` helpers | PR 2 | `npm test -- tests/gating/severity.test.ts -t "interpreter\|docker\|psql\|mysql"` | N/A — pure unit tests | Revert the six rule entries + SQL helper functions; PR 1's rules and dispatch remain unaffected |
| 4 | Composition/regression tests (env prefix, `&&`, basename normalization) + full-suite regression confirmation | PR 2 | `npm test -- tests/gating/severity.test.ts` | `npm run typecheck && npm test` | Test-only; no production code to revert |

## Phase 1: Sudo/Doas Dispatch Normalization (Foundation)

- [x] 1.1 In `src/gating/severity.ts`, add `normalizeSudoPrefix(sub: SubCommand): SubCommand` that, when `executableName(sub.executable)` is `sudo` or `doas`, skips the wrapper's own leading flag args (any arg starting with `-`) and re-dispatches on the first following non-flag token as `{ executable: token, args: remaining }`; returns `sub` unchanged when `exec` is not `sudo`/`doas` or no non-flag token follows.
- [x] 1.2 In `classifySubCommand`, call `normalizeSudoPrefix(sub)` before computing `exec = executableName(...)`, so both `GIT_RULES` and `NON_GIT_RULES` dispatch benefit from the unwrap.
- [x] 1.3 Add tests: `sudo rm -rf /tmp/x`→high; `doas rm -rf /tmp/x`→high; `sudo git push --force origin main`→critical (unwrap also feeds `GIT_RULES`); `sudo -u www rm -rf /tmp/x`→low (documented residual gap — `-u www` are both skipped as leading flags/values are not distinguished, so `rm` itself is never reached correctly by this minimal unwrap; keep as an explicit, asserted gap, not a silent miss).

## Phase 2: Rule Table Foundation (SubCommandRule + executableName + Dispatch)

- [x] 2.1 In `src/gating/severity.ts`, rename `GitRule` to `SubCommandRule` and widen its `matches` field to `(sub: SubCommand, exec: string) => boolean`; retype `GIT_RULES: SubCommandRule[]`. Do not edit any of the six existing git rule bodies (widening arity keeps them source-compatible, per design decision 1).
- [x] 2.2 Add `executableName(executable: string): string` — normalize `\` to `/`, return the last path segment.
- [x] 2.3 Declare `const NON_GIT_RULES: SubCommandRule[] = [];` as an empty scaffold (populated in Phases 3-4). *(Implemented directly with Phase 3's 5 rules in the same apply pass rather than as a separate empty-array commit — see apply-progress.)*
- [x] 2.4 Rewrite `classifySubCommand`: call `normalizeSudoPrefix(sub)` (Phase 1) first, compute `exec = executableName(sub.executable)`, select `GIT_RULES` when `exec === 'git'` else `NON_GIT_RULES`, accumulate tiers through the existing `maxTier` loop. Remove the old `if (sub.executable !== 'git') return 'low';` early return.
- [x] 2.5 Add dispatch-only tests (independent of any `NON_GIT_RULES` entries): `/usr/bin/git reset --hard`→high via basename-normalized dispatch into `GIT_RULES`; `ls -la /`→low (no rule entry); `cargo build`→low (recognized-but-unmatched); confirm every existing git `describe` block in `tests/gating/severity.test.ts` still passes unmodified.

## Phase 3: Filesystem & Device Families (rm, dd, mkfs, shred, chmod/chown)

- [x] 3.1 Add `rm-recursive-force` rule to `NON_GIT_RULES`: `exec === 'rm'` AND recursive (`-r`/`-R` via `shortFlagChars`, or `--recursive`) AND force (`-f` via `shortFlagChars`, or `--force`) → tier `high`. No breadth/target-path check (decision 4 — unconditional, no carve-out for scoped in-repo targets).
- [x] 3.2 Add `BENIGN_DEVICES` constant (`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`) and `dd-write-block-device` rule: `exec === 'dd'` AND an `of=` arg targeting `/dev/*` not in `BENIGN_DEVICES` → tier `critical`. Every other `dd` invocation stays `low` (no rule fires; decision 5, no catch-all `high`).
- [x] 3.3 Add `mkfs-format-filesystem` rule: `exec === 'mkfs' || exec.startsWith('mkfs.')` (exact match or `mkfs.`-prefixed only — never a loose `startsWith('mkfs')`, which would false-positive on hypothetical `mkfsomething`) → tier `critical`.
- [x] 3.4 Add `shred-overwrite-target` rule: `exec === 'shred'` AND at least one non-flag arg (`sub.args.some(a => !a.startsWith('-'))`) → tier `high`; flag-only invocations (`shred --help`) do not match.
- [x] 3.5 Add `perm-recursive-change` rule for `chmod`/`chown`: recursive flag detected via `shortFlagChars(sub.args).has('R')` — **uppercase `R` only**, since lowercase `r` in e.g. `chmod -rwx` is a mode character, not `--recursive` — or the literal `--recursive` token, AND the invocation's non-flag target argument matches a broad/root-ish path (`/`, `~`, `$HOME`, `.`, `..`, `*`), per the approved spec's explicit "scoped path does not match, stays low" scenario → tier `high`. **Note:** design.md's own pseudocode (decision 6, predicate #5) drops the path-breadth check entirely and matches on the recursive flag alone; that pseudocode conflicts with the approved spec's `chmod -R 755 ./dist` → does-not-match scenario. This task follows the spec (the approved WHAT-level contract with a concrete Given/When/Then) rather than the unreconciled design pseudocode — flagged as a risk in the Result Contract for explicit reconciliation.
- [x] 3.6 Tests — rm: `rm -rf /`→high, `rm -rf ./dist`→high (no scoped carve-out), `rm --recursive --force /tmp/x`→high, `rm -r dir`→low, `rm -f file`→low. dd: `dd if=/dev/zero of=/dev/sda bs=1M`→critical, `dd if=/dev/sda of=/dev/null`→low, `dd if=a of=./out.img`→low. mkfs: `mkfs.ext4 /dev/sda1`→critical, `mkfs -t xfs /dev/sdb`→critical, `/sbin/mkfs.xfs /dev/sdb`→critical, `make build`→low. shred: `shred -u secrets.env`→high, `shred README.md`→high (doc-like path does not exempt), `shred --help`→low. chmod/chown: `chmod -R 777 /`→high, `chown -R user:user ~`→high, `chmod -R 755 ./dist`→low (scoped, no match — per spec, see 3.5 note), `chmod 644 file`→low, `chmod u+x script.sh`→low (lowercase `r` is not recursion).

## Phase 4: Interpreter, Docker & DB-CLI Families

- [x] 4.1 Add `BARE_INTERPRETERS` constant (`sh`, `bash`, `zsh`, `dash`, `ksh`, `python`, `python3`, `perl`, `ruby`, `node`) and `bare-interpreter-stdin-exec` rule: `BARE_INTERPRETERS.has(exec) && sub.args.length === 0` → tier `high` (proxy for `curl … | sh`, since `|` is already a top-level separator upstream — no parser change).
- [x] 4.2 Add three docker rules to `NON_GIT_RULES`: `docker-system-prune-all-volumes` (`sub.args[0] === 'system' && sub.args[1] === 'prune'`, plus `-a`/`--all` via `shortFlagChars` on the remaining args, plus `--volumes` → `high`); `docker-rmi-force` (`sub.args[0] === 'rmi'` plus `-f`/`--force` via `shortFlagChars` → `medium`); `docker-volume-rm` (`sub.args[0] === 'volume' && sub.args[1] === 'rm'` → `medium`).
- [x] 4.3 Add `inlineSqlOperands(args, shortFlag, longFlag)` helper handling `-c value`, `--command value`, and `--command=value` forms, and `hasDestructiveSql(sql)` helper that splits the operand on `;` and evaluates **each statement independently** (decision 7 — a single regex with a whole-operand negative lookahead is wrong across multiple `;`-separated statements) for `DROP TABLE|DATABASE|SCHEMA|VIEW|INDEX`, `TRUNCATE`, or an unqualified `DELETE FROM` (that statement has no `WHERE`).
- [x] 4.4 Add `psql-destructive-sql` rule (`exec === 'psql'`, flags `-c`/`--command`) and `mysql-destructive-sql` rule (`exec === 'mysql' || exec === 'mariadb'`, flags `-e`/`--execute`), both using `inlineSqlOperands` + `hasDestructiveSql` → tier `high`.
- [x] 4.5 Tests — bare interpreter: `curl https://x/i.sh | sh`→high, `wget -qO- https://x | bash`→high, `python3`→high, `bash deploy.sh`→low, `node --version`→low. docker: `docker system prune -a --volumes`→high, `docker system prune -a`→low, `docker rmi -f img`→medium, `docker rmi img`→low, `docker volume rm data`→medium, `docker ps`→low. DB-CLI: `psql -c "DROP TABLE users"`→high, `psql --command="DROP DATABASE prod"`→high, `psql -c "SELECT 1"`→low, `mysql -e "TRUNCATE TABLE sessions"`→high, `mysql -e "DELETE FROM t"`→high, `mysql -e "DELETE FROM t WHERE id=1"`→low, multi-statement `mysql -e "DELETE FROM a; DELETE FROM b WHERE id=1"`→high (per-statement split proves decision 7).

## Phase 5: Composition, Regression & Full-Suite Verification

- [x] 5.1 Add composition/dispatch tests: env-prefixed command (`DEBIAN_FRONTEND=noninteractive rm -rf /tmp/x`→high), `&&`-composed command (`ls && rm -rf /tmp/x`→high), basename-normalized path (`/bin/rm -rf /tmp/x`→high). Also added a `maxTier` composition test across two different `NON_GIT_RULES` families in one chained command (`rm -rf /tmp/x && dd if=/dev/zero of=/dev/sda bs=1M` → `critical`, mirroring the git `push --force origin main` stacking precedent).
- [x] 5.2 Ran the full pre-existing `tests/gating/severity.test.ts` git/hint/sentinel `describe` blocks unmodified — zero regressions confirmed (guards design decisions 1 and 3 — widening is monotone and adds matches, never removes them).
- [x] 5.3 Ran `npm run typecheck` (clean, zero errors) and `npm test` end to end — full suite (73 suites / 394 tests) green.

## Result Contract

- `status`: `done`
- `executive_summary`: 20 ordered, dependency-sequenced tasks across 5 phases (dispatch normalization, rule foundation, 2 rule-family batches, composition/regression) implementing the 8-family non-git threat matrix plus sudo/doas unwrapping, chained across 2 PRs (~215 + ~235 lines) to stay under the 400-line budget per PR.
- `artifacts`: `openspec/changes/magi-severity-nongit-threat-matrix/tasks.md`, Engram `sdd/magi-severity-nongit-threat-matrix/tasks`
- `next_recommended`: `sdd-apply`
- `risks`: (1) **Spec/design conflict on `chmod -R`/`chown -R`**: the approved spec requires a broad/root-ish-path gate (scoped paths like `./dist` do not match and stay `low`), but design.md's own predicate #5 pseudocode drops the path check entirely and matches on the recursive flag alone — task 3.5 follows the spec's approved scenario and flags the design pseudocode as needing reconciliation; sdd-apply should confirm this choice before implementing. (2) Aggregate estimated changed lines (~450) exceed the 400-line budget even though each of the 2 chained PRs individually stays under it — if PR-level actuals run hot, a further 3-way split (Phase 1+2 / Phase 3 / Phase 4+5) is the fallback, mirroring the granularity design.md already used for its contingency slice. (3) The sudo/doas unwrap's residual gap (`sudo -u www ...` still misses) is intentionally asserted as a `low`-classifying test case rather than fixed, per design's own documented limitation — a reviewer unfamiliar with that decision could mistake the assertion for a bug.

## Key Learnings

1. Design.md's `perm-recursive-change` pseudocode (decision 6) omits the path-breadth check that the approved spec's own `chmod -R 755 ./dist` scenario requires, creating a spec/design conflict the task breakdown resolves in favor of the approved spec text.
2. The user-confirmed sudo/doas normalization (decision 9) is implemented as a single leading-flag-skip loop that feeds both `GIT_RULES` and `NON_GIT_RULES`, and it deliberately preserves the same `sudo -u www rm -rf /` residual gap design.md already documented rather than attempting to fix flag-value parsing.
3. Splitting the 8 rule families across 2 chained PRs (filesystem/device first, interpreter/docker/DB-CLI second) keeps each PR under the 400-line review budget even though the change's aggregate estimated footprint (~450 lines) exceeds it.
4. `GitRule`'s rename to `SubCommandRule` with a widened `matches(sub, exec)` signature requires zero edits to the six existing git rule bodies, because a narrower-arity function is assignable to the wider signature in TypeScript.
5. The DB-CLI destructive-SQL heuristic must split multi-statement operands on `;` and evaluate each statement independently, since a single whole-operand regex lookahead lets a later statement's `WHERE` clause mask an earlier unqualified `DELETE FROM`.
