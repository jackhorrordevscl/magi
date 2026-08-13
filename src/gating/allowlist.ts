import { parseShellCommand, type SubCommand } from '../shell/command-parser.ts';
import type { ProposedAction } from './proposed-action.ts';

/**
 * Static, code-defined trivial-scope allowlist. See
 * `docs/trivial-allowlist-scope.md` for the full scope addendum.
 *
 * Scope (confirmed): ONLY read-only, zero-side-effect local operations —
 * file reads, `git log` / `git diff` in their read-only form, and
 * grep/glob-style searches. Everything else, with no exception, falls
 * through to the full severity/quorum voting pipeline built in later PRs.
 *
 * This allowlist is NOT model-driven and NOT configurable at runtime by an
 * adapter: `isTrivial()` re-derives trivial-ness from the actual parsed
 * command shape (via the Phase 2 shell parser) rather than trusting an
 * adapter's self-reported `actionType`, so a mislabeled or malicious
 * adapter tag can never smuggle a mutating command through as "trivial".
 *
 * TODO(PR4): wire isTrivial() as the first short-circuit step in the
 * Claude Code hook adapter.
 */

const SAFE_READ_EXECUTABLES = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc']);

const SAFE_SEARCH_EXECUTABLES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);

/** `find` action flags that turn a search into a mutation — never trivial. */
const FIND_MUTATING_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprintf',
]);

function isTrivialSubCommand(sub: SubCommand): boolean {
  if (SAFE_READ_EXECUTABLES.has(sub.executable)) return true;
  if (SAFE_SEARCH_EXECUTABLES.has(sub.executable)) return true;

  if (sub.executable === 'find') {
    return !sub.args.some((arg) => FIND_MUTATING_FLAGS.has(arg));
  }

  if (sub.executable === 'git') {
    // Only the read-only forms — every other git subcommand goes through
    // the full pipeline (see severity.ts for the destructive-op rules).
    return sub.args[0] === 'log' || sub.args[0] === 'diff';
  }

  return false;
}

/**
 * Returns true only when every decomposed sub-command of the proposed
 * action's shell command is a confirmed read-only, zero-side-effect
 * operation. Fails closed (returns false) on anything ambiguous,
 * unparseable, or outside the confirmed set.
 */
export function isTrivial(action: ProposedAction): boolean {
  if (action.source !== 'coding_agent') {
    // STUB (PR1 scope): infra_pipeline actions have no command shape to
    // verify yet — never trivial until that adapter lands.
    return false;
  }

  const parsed = parseShellCommand(action.command);
  if (!parsed.ok) return false;

  return parsed.subCommands.length > 0 && parsed.subCommands.every(isTrivialSubCommand);
}
