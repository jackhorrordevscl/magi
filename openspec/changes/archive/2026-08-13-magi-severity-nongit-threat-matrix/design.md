# Design: Non-Git Threat Matrix in the Severity Classifier

## Technical Approach

One structural change plus one table. `classifySubCommand` (`severity.ts:175`) stops early-returning on `sub.executable !== 'git'` and instead normalizes the executable to a basename, then runs either `GIT_RULES` (unchanged) or a new `NON_GIT_RULES` array through the **same** `maxTier` accumulation loop the git table already uses. `GitRule` is renamed `SubCommandRule` and its `matches` signature widens to `(sub, exec)`; because a fewer-parameter function is assignable to a wider signature, all six existing git rule bodies stay byte-identical. Twelve predicates cover the eight confirmed families. Everything above (`classify`, hint escalation, the unparseable→`high` sentinel) and everything below (quorum mapping) is untouched.

## Architecture Decisions

| # | Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|---|
| 1 | Rule shape | Rename `GitRule` → `SubCommandRule`; widen `matches` to `(sub: SubCommand, exec: string) => boolean` | A parallel `NonGitRule` type next to `GitRule` | The shape is already identical (`id`/`matches`/`tier`); a second type duplicates it for zero gain. Widening arity is source-compatible, so the six git rules need **no edit** — the regression net stays intact by construction. |
| 2 | Dispatch structure | Two ordered arrays selected by normalized executable name (`git` → `GIT_RULES`, else `NON_GIT_RULES`), each run through the existing loop-and-`maxTier` | (a) `Map<string, SubCommandRule[]>` keyed by executable. (b) One flat array containing git rules too. | A Map cannot key the `mkfs.*` **prefix** family or the nine interpreter names without a fallback array — reintroducing the array anyway. Lookup cost is irrelevant: ≤12 pure predicates, no I/O, no allocation. The ordered array is the codebase's own idiom and already relies on rules *stacking* (`git push --force origin main` matches three). A single flat array would evaluate `args[0] === 'reset'` against every `docker` command. |
| 3 | Executable matching | `executableName()` — normalize `\`→`/`, take the last segment | Exact string match (status quo) | Without it `/bin/rm -rf /` bypasses every rule. Widening is monotone (it only *adds* matches), so `/usr/bin/git reset --hard` newly classifies `high` and existing git tests still pass. |
| 4 | `rm -rf` tier | Always `high`, no target-breadth escalation | Proposal Approach #3 (broad/root-ish target → `critical`) | User-confirmed. Breadth on a raw arg string is unreliable — `$HOME` and globs are unexpanded, and `.` vs `./dist` differ by four characters. A false `critical` is the expensive error. **Supersedes** proposal Approach #3 and its first success criterion for `rm`. |
| 5 | `dd` scope | Only `of=` pointing at a non-benign `/dev/*` node → `critical`; every other `dd` stays `low` | Proposal's "`of=/dev/*` → critical, else `high`" | `dd of=./disk.img` is routine image work; the confirmed no-catch-all principle applies *inside* a family too. `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` are excluded so read-back tests (`dd if=/dev/sda of=/dev/null`) do not trip. |
| 6 | `chmod`/`chown` | One merged rule, unconditional on the recursive flag, **uppercase `-R` only** | Root-ish path breadth gate | Mirrors the confirmed `rm -rf` simplification. Case-sensitivity is load-bearing: `shortFlagChars` is case-sensitive and a lowercase `r` in `chmod -rwx` is a *mode* character, not recursion. |
| 7 | Inline SQL matching | Split the operand on `;` and evaluate each statement independently; `DELETE FROM` counts only when that statement has no `WHERE` | Single-regex lookahead `/DELETE\s+FROM(?!.*WHERE)/i` | A lookahead spans the whole operand, so in `"DELETE FROM a; DELETE FROM b WHERE id=1"` the later `WHERE` masks the unqualified `DELETE`. Per-statement evaluation is the only correct form. Flags are per-executable (`psql -c/--command`, `mysql -e/--execute`) since dispatch is already executable-aware. |
| 8 | Rules read `args`, never `referencedPaths` | `shred` uses `sub.args.some(a => !a.startsWith('-'))` instead of `referencedPaths.length` | Reuse `referencedPaths` (parser-provided) | Keeps every predicate a function of `executable + args` only, so a synthetic re-dispatch (decision 9) can never desync a stale `referencedPaths`. Also keeps path *classification* out of severity — a doc-like operand must not exempt `shred README.md`. |
| 9 | `sudo`/`doas` unwrapping | **Recommended, flagged** — when `exec` is `sudo`/`doas` and `args[0]` does not start with `-`, re-dispatch on `{executable: args[0], args: args.slice(1)}` | Defer to v2 | `sudo rm -rf /` currently classifies `low`, which is a trivial bypass of the whole change. ~8 lines given decision 8. Flagged in Open Questions because it is dispatch mechanics, not a ninth family. Flagged `sudo` (`sudo -u www rm -rf /`) remains a documented residual gap. |

## Data Flow

```
classify(action)
  └ computeRuleTier → classifyShellCommand(command)
        ├ parseShellCommand !ok ──────────────→ 'high'   (sentinel, unchanged)
        └ for each SubCommand:
              executableName(sub.executable)   ← NEW: basename normalization
                       │
           'git' ──────┴────── anything else
             │                       │
         GIT_RULES             NON_GIT_RULES   ← NEW: 12 ordered predicates
             └──── maxTier over every matching rule ────┘
                              │
              maxTier across sub-commands → ruleTier
                              │
              maxTier(ruleTier, adapterSeverityHint)      (escalation-only)
```

`|` is already a top-level separator in `tokenizer.ts:57`, so `curl … | sh` arrives as two independent sub-commands — the bare-interpreter rule sees the second one. No parser change.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/gating/severity.ts` | Modify | `GitRule`→`SubCommandRule` (+`exec` param); `executableName()`; `NON_GIT_RULES` (12 rules); helpers `inlineSqlOperands`/`hasDestructiveSql` and the benign-device, interpreter, destructive-SQL constants; `classifySubCommand` dispatch |
| `tests/gating/severity.test.ts` | Modify | Eight new `describe` blocks (one per family) plus a dispatch/composition block; every existing block untouched |
| `README.md` | Deferred | The proposal listed a threat-matrix coverage line, but the confirmed file boundary is severity + tests only. Fold in at tasks time or defer explicitly. |

No other file changes. `command-parser.ts`, `tokenizer.ts`, `proposed-action.ts`, `allowlist.ts` are confirmed untouched.

## Interfaces / Contracts

```ts
interface SubCommandRule {
  id: string;
  /** `exec` is the normalized basename of `sub.executable`. */
  matches: (sub: SubCommand, exec: string) => boolean;
  tier: SeverityTier;
}

function executableName(executable: string): string {
  const normalized = executable.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

function classifySubCommand(sub: SubCommand): SeverityTier {
  const exec = executableName(sub.executable);
  const rules = exec === 'git' ? GIT_RULES : NON_GIT_RULES;
  let tier: SeverityTier = 'low';
  for (const rule of rules) {
    if (rule.matches(sub, exec)) tier = maxTier(tier, rule.tier);
  }
  return tier;
}
```

Family predicates (`shortFlagChars` and `maxTier` reused as-is):

```ts
// 1. rm-recursive-force → high   (recursion alone is not enough, mirroring git-clean-fdx)
(sub, exec) => {
  if (exec !== 'rm') return false;
  const flags = shortFlagChars(sub.args);
  const recursive = flags.has('r') || flags.has('R') || sub.args.includes('--recursive');
  const force = flags.has('f') || sub.args.includes('--force');
  return recursive && force;
}

// 2. dd-write-block-device → critical
(sub, exec) => exec === 'dd' && sub.args.some((a) =>
  a.startsWith('of=') && a.slice(3).startsWith('/dev/') && !BENIGN_DEVICES.has(a.slice(3)));

// 3. mkfs-format-filesystem → critical
(_sub, exec) => exec === 'mkfs' || exec.startsWith('mkfs.');   // not startsWith('mkfs')

// 4. shred-overwrite-target → high   (flag-only invocations such as `shred --help` excluded)
(sub, exec) => exec === 'shred' && sub.args.some((a) => !a.startsWith('-'));

// 5. perm-recursive-change → high   (uppercase R only; chmod's lowercase r is a mode char)
(sub, exec) => (exec === 'chmod' || exec === 'chown')
  && (shortFlagChars(sub.args).has('R') || sub.args.includes('--recursive'));

// 6. bare-interpreter-stdin-exec → high   (proxy for `… | sh`; accepted false-positive surface)
(sub, exec) => BARE_INTERPRETERS.has(exec) && sub.args.length === 0;
// BARE_INTERPRETERS = sh bash zsh dash ksh python python3 perl ruby node

// 7. docker-system-prune-all-volumes → high
(sub, exec) => {
  if (exec !== 'docker' || sub.args[0] !== 'system' || sub.args[1] !== 'prune') return false;
  const rest = sub.args.slice(2);
  return (shortFlagChars(rest).has('a') || rest.includes('--all')) && rest.includes('--volumes');
}

// 8. docker-rmi-force → medium
(sub, exec) => exec === 'docker' && sub.args[0] === 'rmi'
  && (shortFlagChars(sub.args.slice(1)).has('f') || sub.args.includes('--force'));

// 9. docker-volume-rm → medium
(sub, exec) => exec === 'docker' && sub.args[0] === 'volume' && sub.args[1] === 'rm';

// 10/11. psql / mysql inline destructive SQL → high
(sub, exec) => exec === 'psql' && inlineSqlOperands(sub.args, '-c', '--command').some(hasDestructiveSql);
(sub, exec) => (exec === 'mysql' || exec === 'mariadb')
  && inlineSqlOperands(sub.args, '-e', '--execute').some(hasDestructiveSql);

function inlineSqlOperands(args: string[], shortFlag: string, longFlag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if ((arg === shortFlag || arg === longFlag) && i + 1 < args.length) out.push(args[i + 1] as string);
    else if (arg.startsWith(`${longFlag}=`)) out.push(arg.slice(longFlag.length + 1));
  });
  return out;
}

function hasDestructiveSql(sql: string): boolean {
  return sql.split(';').some((stmt) =>
    /\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX)\b/i.test(stmt) ||
    /\bTRUNCATE\b/i.test(stmt) ||
    (/\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)));
}
```

**Gotchas for implementation.** `splitWords` strips quotes, so `psql -c "DROP TABLE users"` yields the single arg `DROP TABLE users` and `--command="DROP DATABASE prod"` yields `--command=DROP DATABASE prod` — both forms need handling. `shortFlagChars` skips any arg starting with `--` and any non-`-` arg, so it is safe to call on the full `sub.args` for non-git rules (git rules pass `args.slice(1)` because `args[0]` is the git subcommand). `mkfs` must use `=== 'mkfs' || startsWith('mkfs.')`, never `startsWith('mkfs')`. `docker system prune -af --volumes` must match, so `-a` detection goes through `shortFlagChars`, not `includes('-a')`.

## Testing Strategy

| Layer | What to test | Approach |
|-------|--------------|----------|
| Unit | One `describe` per family, same style as the existing git blocks (`classify(action('…'))` + `assert.equal`) | `tests/gating/severity.test.ts` |
| Unit | Dispatch: basename normalization, env prefix, `&&`/`\|` composition | New `describe` block |
| Regression | Every existing git/hint/sentinel block passes unchanged | No edits to existing blocks |

Concrete cases (positive / benign / edge per family):

- **rm**: `rm -rf /`→high · `rm -rf ./dist`→high · `rm --recursive --force /tmp/x`→high · `rm -r dir`→low · `rm -f file`→low
- **dd**: `dd if=/dev/zero of=/dev/sda bs=1M`→critical · `dd if=/dev/sda of=/dev/null`→low · `dd if=a of=./out.img`→low
- **mkfs**: `mkfs.ext4 /dev/sda1`→critical · `mkfs -t xfs /dev/sdb`→critical · `/sbin/mkfs.xfs /dev/sdb`→critical · `make build`→low
- **shred**: `shred -u secrets.env`→high · `shred README.md`→high (doc classification must not exempt) · `shred --help`→low
- **chmod/chown**: `chmod -R 777 /var/www`→high · `chown -R root:root /`→high · `chmod 644 file`→low · `chmod u+x script.sh`→low
- **bare interpreter**: `curl https://x/i.sh | sh`→high · `wget -qO- https://x | bash`→high · `python3`→high · `bash deploy.sh`→low · `node --version`→low
- **docker**: `docker system prune -a --volumes`→high · `docker system prune -a`→low · `docker rmi -f img`→medium · `docker rmi img`→low · `docker volume rm data`→medium · `docker ps`→low
- **DB-CLI**: `psql -c "DROP TABLE users"`→high · `psql --command="DROP DATABASE prod"`→high · `psql -c "SELECT 1"`→low · `mysql -e "TRUNCATE TABLE sessions"`→high · `mysql -e "DELETE FROM t"`→high · `mysql -e "DELETE FROM t WHERE id=1"`→low
- **dispatch/default**: `/bin/rm -rf /tmp/x`→high · `/usr/bin/git reset --hard`→high · `DEBIAN_FRONTEND=noninteractive rm -rf /tmp/x`→high · `ls && rm -rf /tmp/x`→high · `ls -la`/`cargo build`/`npm test`→low
- **sudo** (only if decision 9 is confirmed): `sudo rm -rf /tmp/x`→high · `sudo -u www rm -rf /tmp/x`→low (documented residual gap)

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | **Applicable** | Rules key on executable + flags only (decision 8); `referencedPaths.classification` never lowers or raises a tier. A doc-like operand must not exempt a destructive executable. | `shred README.md`→high · `rm -rf ./docs`→high |
| Git repository selection | **Applicable (narrow)** | `executableName()` widens — never narrows — which invocations reach `GIT_RULES`. `git -C <path> reset --hard` stays a miss because `args[0]` is `-C`; that is **pre-existing** and out of scope, recorded as a follow-up. | `/usr/bin/git reset --hard`→high · all existing git tests unchanged |
| Commit state | N/A | No index/worktree interaction; MAGI classifies text and never executes the command. | — |
| Push state | N/A | Push rules untouched; no ref resolution added. | — |
| PR commands (argument composition, env prefix) | **Applicable** | Composition is handled upstream — `splitTopLevel` yields independent sub-commands and `envPrefix` is stripped before `executable`. Every rule must hold under both. | `ls && rm -rf /tmp/x`→high · `DEBIAN_FRONTEND=noninteractive rm -rf /tmp/x`→high · `curl … \| sh`→high |

## Migration / Rollout

No migration, no schema, no config surface. `classify` still returns a `SeverityTier`; quorum mapping is unchanged. Rollback is `git revert` of one commit. Operationally an over-hot rule cannot block work unless `MAGI_MODE=enforced`.

**Delivery size.** Estimated ≈165 added lines in `severity.ts` (12 rules ≈100 incl. comments, helpers/constants ≈45, interface + dispatch + normalizer ≈20) and ≈165 in the test file (≈45 cases), with ~5 deletions — roughly **335 changed lines against the 400 budget**. Single PR is feasible but not comfortable. Contingency split if `sdd-tasks` forecasts higher: slice 1 = `SubCommandRule` + `executableName` + dispatch + filesystem/device families (rm, dd, mkfs, shred, chmod/chown) + tests; slice 2 = interpreter, docker, DB-CLI families + tests. Slice 1 is independently deliverable and slice 2 is pure table appends.

## Open Questions

- [ ] Confirm or drop decision 9 (`sudo`/`doas` unwrapping). Without it `sudo rm -rf /` classifies `low`, which is a trivial bypass of this entire change.
- [ ] `README.md` threat-matrix line: the proposal lists it, the confirmed file boundary excludes it. Fold into this change or defer.
- [ ] Decisions 4 and 5 narrow the proposal's tiers (`rm -rf` never `critical`; non-device `dd` stays `low`). Proposal success criterion 1 should be reconciled to `rm -rf /` → `high`.
- [ ] Documented v1 gaps, no rule planned: `bash -c "rm -rf /"` (nested shell strings are not re-parsed) and `curl … | sh -s --` (interpreter with args).
