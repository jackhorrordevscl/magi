import type { Evaluator as EvaluatorName, Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';

/**
 * Port implemented by every concrete evaluator backend that can cast one
 * vote on a proposed action. `src/gating/anthropic-evaluator.ts` is the
 * only concrete implementation in this PR (sync tier, Haiku-class, forced
 * tool-use). `src/gating/melchior.ts` / `balthasar.ts` / `casper.ts` are
 * the three named instances that wrap it with distinct calibration facets.
 */
export interface EvaluatorPort {
  /** Which of the three named evaluators this instance represents. */
  readonly name: EvaluatorName;
  /**
   * Casts exactly one vote for `action` at `severity`. Per spec Requirement:
   * Sync Mode Fail-Closed, a conforming implementation NEVER rejects in
   * normal operation — timeouts, transport errors, and non-conforming
   * model output are all caught internally and turned into a `deny` vote
   * (see `anthropic-evaluator.ts`). `collectVotes` below still guards
   * against an implementation that violates this contract and rejects
   * anyway, as defense in depth.
   */
  castVote(action: ProposedAction, severity: SeverityTier): Promise<Vote>;
}

/**
 * Dispatches all three evaluators in parallel via `Promise.allSettled` and
 * returns exactly three votes, in evaluator order.
 *
 * Per spec Requirement: Sync Mode Fail-Closed — if an evaluator's promise
 * rejects (defense in depth; concrete evaluators are expected to already
 * catch their own errors/timeouts and resolve to a `deny` vote themselves),
 * that evaluator's vote here is substituted with `deny`, never dropped and
 * never allowed to reject the other two votes. `Promise.allSettled` (not
 * `Promise.all`) is what makes this possible: every settlement is observed
 * regardless of any individual rejection.
 */
export async function collectVotes(
  evaluators: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort],
  action: ProposedAction,
  severity: SeverityTier,
): Promise<[Vote, Vote, Vote]> {
  const settled = await Promise.allSettled(evaluators.map((e) => e.castVote(action, severity)));

  const votes = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const evaluator = evaluators[index] as EvaluatorPort;
    const vote: Vote = {
      evaluator: evaluator.name,
      vote: 'deny',
      rationale: `evaluator promise rejected, fail-closed to deny: ${describeReason(result.reason)}`,
    };
    return vote;
  });

  return votes as [Vote, Vote, Vote];
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
