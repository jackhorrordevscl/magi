import { parseShellCommand, type SubCommand } from '../shell/command-parser.ts';
import { type ProposedAction, type SeverityTier } from './proposed-action.ts';

/**
 * Deterministic, table-driven severity classification. No model call is
 * involved: the same `ProposedAction` always produces the same tier.
 *
 * `final = max(ruleClassifiedTier, adapterSeverityHint)` — an adapter hint
 * can only ever raise the tier the rule table computed, never lower it.
 */
export function classify(action: ProposedAction): SeverityTier {
  const ruleTier = computeRuleTier(action);
  return action.adapterSeverityHint ? maxTier(ruleTier, action.adapterSeverityHint) : ruleTier;
}

// --- Tier ordering --------------------------------------------------------

// NOTE: PR2 widened SeverityTierSchema to 4 tiers (added `critical`) for
// the consensus/quorum layer — see proposed-action.ts. The rule table below
// emits `critical` for the spec's own exemplar (force-push resolving to an
// explicitly-identified protected branch, e.g. main) — see
// `git-push-force-protected-branch`.
const TIER_ORDER: Record<SeverityTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function maxTier(a: SeverityTier, b: SeverityTier): SeverityTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

// --- Rule dispatch per action source --------------------------------------

function computeRuleTier(action: ProposedAction): SeverityTier {
  switch (action.source) {
    case 'coding_agent':
      return classifyShellCommand(action.command);
    case 'infra_pipeline':
      // STUB (PR1 scope): the infra/CI pipeline rule table is deferred to
      // the CI adapter PR. Fail closed rather than guessing at safety.
      return 'high';
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}

/**
 * Classifies a raw shell command string, decomposing compound commands via
 * the Phase 2 parser and taking the highest tier across every sub-command.
 * A genuinely unparseable command (the parser's sentinel result) forces
 * High per the threat-matrix design — ambiguity is never treated as safe.
 */
function classifyShellCommand(command: string): SeverityTier {
  const parsed = parseShellCommand(command);
  if (!parsed.ok) return 'high';

  let tier: SeverityTier = 'low';
  for (const sub of parsed.subCommands) {
    tier = maxTier(tier, classifySubCommand(sub));
  }
  return tier;
}

// --- Git threat-matrix rule table -----------------------------------------

const GIT_PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod']);

function isProtectedBranchName(name: string): boolean {
  const stripped = name.replace(/^refs\/heads\//, '');
  if (GIT_PROTECTED_BRANCHES.has(stripped)) return true;
  if (stripped.startsWith('release/') || stripped.startsWith('release-')) return true;
  return false;
}

/** Collects individual short-flag characters (e.g. `-fdx` -> f, d, x). */
function shortFlagChars(args: string[]): Set<string> {
  const chars = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith('--')) continue;
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) chars.add(ch);
    }
  }
  return chars;
}

interface SubCommandRule {
  id: string;
  /** `exec` is the normalized basename of `sub.executable`. */
  matches: (sub: SubCommand, exec: string) => boolean;
  tier: SeverityTier;
}

/**
 * Table-driven git threat matrix. Ordered array so the classification is
 * self-documenting and easy to extend; every entry is a pure predicate
 * over the already-decomposed sub-command, never a model call.
 */
const GIT_RULES: SubCommandRule[] = [
  {
    id: 'git-reset-hard',
    matches: (sub) => sub.args[0] === 'reset' && sub.args.includes('--hard'),
    tier: 'high',
  },
  {
    id: 'git-clean-fdx',
    matches: (sub) => {
      if (sub.args[0] !== 'clean') return false;
      const flags = shortFlagChars(sub.args.slice(1));
      return flags.has('f') && flags.has('d') && flags.has('x');
    },
    tier: 'high',
  },
  {
    id: 'git-push-force',
    matches: (sub) => {
      if (sub.args[0] !== 'push') return false;
      return sub.args.some(
        (a) =>
          a === '--force' ||
          a === '--force-with-lease' ||
          (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('f')),
      );
    },
    tier: 'high',
  },
  {
    // Spec exemplar (Severity Tier Classification, Critical): "force-push to
    // main". A force-push that resolves to an explicitly identified
    // protected branch is irreversible on shared state, not merely
    // high-blast-radius — escalate above the generic force-push rule.
    // Ambiguous/unresolved force-push targets stay High (see
    // git-push-ambiguous-target) since we can't confirm the destination.
    id: 'git-push-force-protected-branch',
    matches: (sub) => {
      if (sub.args[0] !== 'push') return false;
      const isForce = sub.args.some(
        (a) =>
          a === '--force' ||
          a === '--force-with-lease' ||
          (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('f')),
      );
      if (!isForce) return false;
      const nonFlagArgs = sub.args.slice(1).filter((a) => !a.startsWith('-'));
      if (nonFlagArgs.length < 2) return false;
      const refspec = nonFlagArgs[1] as string;
      const dest = refspec.includes(':') ? (refspec.split(':')[1] ?? '') : refspec;
      return isProtectedBranchName(dest);
    },
    tier: 'critical',
  },
  {
    id: 'git-push-protected-branch-refspec',
    matches: (sub) => {
      if (sub.args[0] !== 'push') return false;
      const nonFlagArgs = sub.args.slice(1).filter((a) => !a.startsWith('-'));
      if (nonFlagArgs.length < 2) return false; // no explicit refspec — see ambiguous-target rule
      const refspec = nonFlagArgs[1] as string;
      const dest = refspec.includes(':') ? (refspec.split(':')[1] ?? '') : refspec;
      return isProtectedBranchName(dest);
    },
    tier: 'high',
  },
  {
    id: 'git-push-ambiguous-target',
    matches: (sub) => {
      if (sub.args[0] !== 'push') return false;
      const nonFlagArgs = sub.args.slice(1).filter((a) => !a.startsWith('-'));
      // Ambiguous repo root/target (no explicit refspec resolvable) — the
      // threat matrix forces High rather than assuming a safe default.
      return nonFlagArgs.length < 2;
    },
    tier: 'high',
  },
];

// --- Non-git threat-matrix rule table --------------------------------------

/**
 * Normalizes a raw executable path to its basename: `\` -> `/`, then the
 * last path segment. Widening is monotone — it only ever adds matches, so
 * `/usr/bin/git reset --hard` newly classifies `high` while every existing
 * exact-match git test still passes.
 */
function executableName(executable: string): string {
  const normalized = executable.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

/**
 * `sudo`/`doas` wrapper unwrapping (design decision 9). Skips the wrapper's
 * own leading flag args (anything starting with `-`) and re-dispatches on
 * the first following non-flag token as the effective executable. Returns
 * `sub` unchanged when the executable isn't `sudo`/`doas`, or when no
 * non-flag token follows the leading flags.
 *
 * Documented residual gap: a flag with an attached value between the
 * wrapper and the real command (e.g. `sudo -u www rm -rf /`) still slips
 * through — `-u` is skipped as a flag, then `www` is treated as the
 * effective executable, so `rm` itself is never reached. This is an
 * accepted limitation (design decision 9), not a bug to fix here.
 */
function normalizeSudoPrefix(sub: SubCommand): SubCommand {
  const exec = executableName(sub.executable);
  if (exec !== 'sudo' && exec !== 'doas') return sub;

  let idx = 0;
  while (idx < sub.args.length && (sub.args[idx] as string).startsWith('-')) {
    idx += 1;
  }
  if (idx >= sub.args.length) return sub;

  const token = sub.args[idx] as string;
  return { ...sub, executable: token, args: sub.args.slice(idx + 1) };
}

/** `dd of=` targets excluded from the raw-block-device escalation. */
const BENIGN_DEVICES = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
]);

/** Broad/root-ish target arguments that gate the `chmod -R`/`chown -R` rule. */
const BROAD_PATH_TARGETS = new Set(['/', '~', '$HOME', '.', '..', '*']);

/**
 * Bare interpreters whose zero-arg invocation is treated as a proxy for
 * piped/stdin script execution (e.g. `curl … | sh`). The tokenizer already
 * splits `|` as a top-level separator, so the interpreter sub-command
 * arrives independently with no visibility into what fed its stdin.
 */
const BARE_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
]);

/**
 * Collects inline SQL operand values for a `-c`/`--command`-style flag pair
 * (or `-e`/`--execute` for mysql). Handles the two-token form (`-c <arg>`,
 * `--command <arg>`) and the single-token `--command=<value>` form. Quotes
 * are already stripped by the tokenizer's word splitting, so `-c "DROP
 * TABLE users"` arrives as one intact arg `DROP TABLE users`.
 */
function inlineSqlOperands(args: string[], shortFlag: string, longFlag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if ((arg === shortFlag || arg === longFlag) && i + 1 < args.length) {
      out.push(args[i + 1] as string);
    } else if (arg.startsWith(`${longFlag}=`)) {
      out.push(arg.slice(longFlag.length + 1));
    }
  });
  return out;
}

/**
 * Evaluates a raw inline SQL operand for destructive statements. Splits on
 * `;` and evaluates each statement independently (design decision 7) —
 * a single whole-operand regex with a negative lookahead is wrong, since a
 * later statement's `WHERE` clause would mask an earlier unqualified
 * `DELETE FROM`. Matches `DROP TABLE|DATABASE|SCHEMA|VIEW|INDEX`,
 * `TRUNCATE`, or an unqualified `DELETE FROM` (no `WHERE` in that
 * statement). This is a v1 substring/heuristic match, not a SQL parser.
 */
function hasDestructiveSql(sql: string): boolean {
  return sql.split(';').some((stmt) => {
    if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX)\b/i.test(stmt)) return true;
    if (/\bTRUNCATE\b/i.test(stmt)) return true;
    return /\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt);
  });
}

/**
 * Table-driven non-git threat matrix. PR 1 covered filesystem/device
 * families (rm, dd, mkfs, shred, chmod/chown); PR 2 adds interpreter,
 * docker, and DB-CLI families. Same shape and accumulation semantics as
 * `GIT_RULES`.
 */
const NON_GIT_RULES: SubCommandRule[] = [
  {
    // Recursion alone is not enough, mirroring git-clean-fdx. Unconditional
    // on target breadth — no carve-out for scoped in-repo paths (decision 4).
    id: 'rm-recursive-force',
    matches: (sub, exec) => {
      if (exec !== 'rm') return false;
      const flags = shortFlagChars(sub.args);
      const recursive = flags.has('r') || flags.has('R') || sub.args.includes('--recursive');
      const force = flags.has('f') || sub.args.includes('--force');
      return recursive && force;
    },
    tier: 'high',
  },
  {
    // Only a raw non-benign block device destination escalates; every
    // other `dd` invocation stays `low` — no catch-all `high` (decision 5).
    id: 'dd-write-block-device',
    matches: (sub, exec) =>
      exec === 'dd' &&
      sub.args.some(
        (a) => a.startsWith('of=') && a.slice(3).startsWith('/dev/') && !BENIGN_DEVICES.has(a.slice(3)),
      ),
    tier: 'critical',
  },
  {
    // Exact `mkfs` or `mkfs.`-prefixed only — never a loose
    // `startsWith('mkfs')`, which would false-positive on unrelated binaries.
    id: 'mkfs-format-filesystem',
    matches: (_sub, exec) => exec === 'mkfs' || exec.startsWith('mkfs.'),
    tier: 'critical',
  },
  {
    // Flag-only invocations (e.g. `shred --help`) don't match; a doc-like
    // target argument does not exempt the rule (decision 8).
    id: 'shred-overwrite-target',
    matches: (sub, exec) => exec === 'shred' && sub.args.some((a) => !a.startsWith('-')),
    tier: 'high',
  },
  {
    // Uppercase `-R` only — lowercase `r` in e.g. `chmod -rwx` is a mode
    // character, not `--recursive` (decision 6). Per the approved spec
    // (not design.md's incomplete pseudocode), the recursive flag alone is
    // not sufficient: the invocation must also target a broad/root-ish path
    // (`/`, `~`, `$HOME`, `.`, `..`, `*`) — a scoped path (e.g. `./dist`)
    // does not match and stays `low`.
    id: 'perm-recursive-change',
    matches: (sub, exec) => {
      if (exec !== 'chmod' && exec !== 'chown') return false;
      const recursive = shortFlagChars(sub.args).has('R') || sub.args.includes('--recursive');
      if (!recursive) return false;
      return sub.args.some((a) => !a.startsWith('-') && BROAD_PATH_TARGETS.has(a));
    },
    tier: 'high',
  },
  {
    // Proxy for `curl … | sh`-style piped script execution: a zero-arg
    // interpreter sub-command is the only signal visible after the
    // tokenizer splits `|` into independent sub-commands. An interpreter
    // invoked with an explicit script argument (e.g. `python3 build.py`)
    // does not match.
    id: 'bare-interpreter-stdin-exec',
    matches: (sub, exec) => BARE_INTERPRETERS.has(exec) && sub.args.length === 0,
    tier: 'high',
  },
  {
    // `docker system prune -a/--all --volumes` wipes every unused image,
    // container, network, AND volume — the `--volumes` flag is what makes
    // this irreversible for named volumes, unlike a plain `-a` prune.
    id: 'docker-system-prune-all-volumes',
    matches: (sub, exec) => {
      if (exec !== 'docker' || sub.args[0] !== 'system' || sub.args[1] !== 'prune') return false;
      const rest = sub.args.slice(2);
      const all = shortFlagChars(rest).has('a') || rest.includes('--all');
      return all && rest.includes('--volumes');
    },
    tier: 'high',
  },
  {
    id: 'docker-rmi-force',
    matches: (sub, exec) => {
      if (exec !== 'docker' || sub.args[0] !== 'rmi') return false;
      const rest = sub.args.slice(1);
      return shortFlagChars(rest).has('f') || rest.includes('--force');
    },
    tier: 'medium',
  },
  {
    id: 'docker-volume-rm',
    matches: (sub, exec) => exec === 'docker' && sub.args[0] === 'volume' && sub.args[1] === 'rm',
    tier: 'medium',
  },
  {
    id: 'psql-destructive-sql',
    matches: (sub, exec) =>
      exec === 'psql' && inlineSqlOperands(sub.args, '-c', '--command').some(hasDestructiveSql),
    tier: 'high',
  },
  {
    id: 'mysql-destructive-sql',
    matches: (sub, exec) =>
      (exec === 'mysql' || exec === 'mariadb') &&
      inlineSqlOperands(sub.args, '-e', '--execute').some(hasDestructiveSql),
    tier: 'high',
  },
];

function classifySubCommand(sub: SubCommand): SeverityTier {
  const normalized = normalizeSudoPrefix(sub);
  const exec = executableName(normalized.executable);
  const rules = exec === 'git' ? GIT_RULES : NON_GIT_RULES;

  let tier: SeverityTier = 'low';
  for (const rule of rules) {
    if (rule.matches(normalized, exec)) tier = maxTier(tier, rule.tier);
  }
  return tier;
}
