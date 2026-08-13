import { z } from 'zod';

/**
 * STUB (PR1 scope): data shapes only.
 *
 * The three-evaluator quorum/consensus resolution logic (melchior,
 * balthasar, casper voting + divergence-floor handling) lands in PR2. This
 * file exists in PR1 solely so `Vote` compiles and is importable by
 * `src/audit/record.ts` and by later PRs.
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

// TODO(PR2): implement quorum/consensus resolution over three Vote
// records (one per evaluator) plus the divergence floor from
// magi.config.json (`tiers.divergenceFloorPercent`).
