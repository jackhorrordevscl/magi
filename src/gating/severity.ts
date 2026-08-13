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

interface GitRule {
  id: string;
  matches: (sub: SubCommand) => boolean;
  tier: SeverityTier;
}

/**
 * Table-driven git threat matrix. Ordered array so the classification is
 * self-documenting and easy to extend; every entry is a pure predicate
 * over the already-decomposed sub-command, never a model call.
 */
const GIT_RULES: GitRule[] = [
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

function classifySubCommand(sub: SubCommand): SeverityTier {
  if (sub.executable !== 'git') return 'low';

  let tier: SeverityTier = 'low';
  for (const rule of GIT_RULES) {
    if (rule.matches(sub)) tier = maxTier(tier, rule.tier);
  }
  return tier;
}
