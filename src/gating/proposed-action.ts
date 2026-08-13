import { z } from 'zod';

/**
 * Operating mode magi is running under for a given proposed action.
 *
 * - `shadow`: observe and record only — a deny verdict is never enforced.
 * - `enforced`: a deny verdict blocks the action.
 */
export const MagiModeSchema = z.enum(['shadow', 'enforced']);
export type MagiMode = z.infer<typeof MagiModeSchema>;

/**
 * Severity tier assigned to an action, either by the rule-based classifier
 * (see `src/gating/severity.ts`) or hinted by an upstream adapter.
 *
 * Four tiers per the approved spec (Requirement: Severity Tier
 * Classification): `critical` = irreversible on production/shared state
 * (e.g. force-push to a protected branch), `high` = broad blast radius but
 * not fully irreversible, `medium` = reversible non-trivial, `low` = local
 * reversible. See `src/gating/severity.ts` for the rule table and
 * `src/gating/consensus.ts` for how each tier's quorum requirement differs.
 */
export const SeverityTierSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type SeverityTier = z.infer<typeof SeverityTierSchema>;

/**
 * Fields shared by every ProposedAction regardless of originating source.
 */
const baseActionShape = {
  /** Identity of who/what is proposing the action (agent id, user, service). */
  actor: z.string().min(1),
  /** Coarse category of the action, e.g. "shell_exec", "file_write". */
  actionType: z.string().min(1),
  /** What the action operates on — a path, ref, resource identifier, etc. */
  target: z.string().min(1),
  /** Where the action would execute, e.g. "local", "ci", "production". */
  environment: z.string().min(1),
  /**
   * Optional severity hint supplied by the calling adapter. Per the
   * threat-matrix design, a hint may only ever raise the tier the rule
   * table computes — never lower it. See `src/gating/severity.ts`.
   */
  adapterSeverityHint: SeverityTierSchema.optional(),
  mode: MagiModeSchema,
};

/**
 * A proposed action originating from a coding agent (e.g. a Claude Code
 * hook invocation proposing a shell command). This is the only source
 * shape exercised through the PR1-PR3 gating pipeline scope.
 */
export const CodingAgentActionSchema = z.object({
  ...baseActionShape,
  source: z.literal('coding_agent'),
  /** The raw shell command text the coding agent proposes to run. */
  command: z.string().min(1),
});
export type CodingAgentAction = z.infer<typeof CodingAgentActionSchema>;

/**
 * A proposed action originating from an infra/CI pipeline adapter.
 *
 * STUB (PR1 scope): the CI pipeline adapter itself is deferred to a later
 * PR. This shape exists only so `ProposedActionSchema` is a real
 * discriminated union that type-checks and is importable today; it is not
 * exercised by any gating logic in this PR.
 */
export const InfraPipelineActionSchema = z.object({
  ...baseActionShape,
  source: z.literal('infra_pipeline'),
  pipelineId: z.string().min(1),
});
export type InfraPipelineAction = z.infer<typeof InfraPipelineActionSchema>;

/**
 * Discriminated union of every action source magi can gate. Discriminated
 * on `source` per the original exploration (coding_agent vs
 * infra_pipeline).
 */
export const ProposedActionSchema = z.discriminatedUnion('source', [
  CodingAgentActionSchema,
  InfraPipelineActionSchema,
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
