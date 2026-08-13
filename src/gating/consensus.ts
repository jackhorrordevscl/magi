import { z } from 'zod';
import type { SeverityTier } from './proposed-action.ts';

/**
 * Vote/evaluator data shapes (PR1) plus quorum resolution logic (PR2).
 *
 * The three evaluators (melchior, balthasar, casper) each cast exactly one
 * vote per action (`src/gating/evaluator-port.ts` / the concrete Anthropic
 * evaluators land in PR3 — out of this PR's scope). `resolveConsensus`
 * below is the pure, deterministic quorum rule that turns those three
 * votes plus a severity tier into a single allow/deny decision.
 */

export const EvaluatorSchema = z.enum(['melchior', 'balthasar', 'casper']);
export type Evaluator = z.infer<typeof EvaluatorSchema>;

export const VoteDecisionSchema = z.enum(['allow', 'deny', 'abstain']);
export type VoteDecision = z.infer<typeof VoteDecisionSchema>;

export const VoteSchema = z.object({
  evaluator: EvaluatorSchema,
  vote: VoteDecisionSchema,
  rationale: z.string().min(1),
});
export type Vote = z.infer<typeof VoteSchema>;

/** Tiers that require unanimous 3-of-3 allow rather than 2-of-3. */
const UNANIMOUS_TIERS: ReadonlySet<SeverityTier> = new Set<SeverityTier>(['high', 'critical']);

/**
 * Resolves the quorum decision for a fully-collected set of votes against a
 * severity tier. Pure and deterministic — no model call, no I/O.
 *
 * Rule (per spec Requirement: Consensus and Quorum):
 * - Low/Medium severity: at least 2-of-3 `allow` votes -> allow.
 * - High/Critical severity: unanimous 3-of-3 `allow` -> allow.
 * - `abstain` NEVER counts toward allow, in any tier, at any count — it is
 *   treated identically to `deny` for quorum-counting purposes.
 *
 * See `tests/gating/consensus.test.ts` for the full 27-combination x
 * 4-tier RED matrix this implements.
 */
export function resolveConsensus(votes: Vote[], tier: SeverityTier): 'allow' | 'deny' {
  const allowCount = votes.filter((v) => v.vote === 'allow').length;
  const requiredAllow = UNANIMOUS_TIERS.has(tier) ? 3 : 2;
  return allowCount >= requiredAllow ? 'allow' : 'deny';
}
