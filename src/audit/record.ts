import { z } from 'zod';
import { VoteSchema } from '../gating/consensus.ts';
import { MagiModeSchema, SeverityTierSchema } from '../gating/proposed-action.ts';

/**
 * STUB (PR1 scope): data shape only.
 *
 * The append-only, hash-chained audit sink that writes these records to
 * `.magi/audit/` is implemented in a later PR. This file exists in PR1
 * solely so `AuditRecord` compiles and is importable today.
 */

export const AuditDecisionSchema = z.enum(['allow', 'deny']);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

export const AuditRecordSchema = z.object({
  /** Monotonic sequence number within the hash chain. */
  seq: z.number().int().nonnegative(),
  /** Hash of the previous record in the chain (genesis: empty string). */
  prevHash: z.string(),
  /** Hash of this record's own content (including `prevHash`). */
  hash: z.string(),
  timestamp: z.string(),
  actor: z.string().min(1),
  mode: MagiModeSchema,
  action: z.string().min(1),
  severity: SeverityTierSchema,
  /** Exactly one vote per evaluator: melchior, balthasar, casper. */
  votes: z.tuple([VoteSchema, VoteSchema, VoteSchema]),
  decision: AuditDecisionSchema,
  /** Present only when a human overrode the quorum decision. */
  override: z.string().optional(),
  calibrationCorpusHash: z.string(),
  exemplarIds: z.array(z.string()),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

// TODO(PR2+): implement the append-only hash-chained sink that persists
// these records under `.magi/audit/` (see magi.config.json `paths.auditDir`).
