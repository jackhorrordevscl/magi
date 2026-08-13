import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VoteSchema } from '../gating/consensus.ts';
import { MagiModeSchema, SeverityTierSchema } from '../gating/proposed-action.ts';

/**
 * `AuditRecord` data shape (PR1) plus the hashing primitive the
 * hash-chained sink is built on (PR2). The append-only filesystem sink
 * that actually writes these records to `.magi/audit/` lives in
 * `src/audit/fs-append-sink.ts`.
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

/**
 * The first record in every hash chain has `seq` = this value and
 * `prevHash` = `''`. Documented explicitly (per task requirement) so
 * `src/audit/fs-append-sink.ts` and `src/audit/verify.ts` agree on the same
 * convention: sequence numbers are 0-indexed.
 */
export const AUDIT_GENESIS_SEQ = 0;

/**
 * Deterministically serializes `value` with object keys sorted at every
 * level, so the same logical content always canonicalizes to the exact
 * same string regardless of property insertion order. This is what makes
 * `computeHash` reproducible independent of how a record object happened
 * to be constructed.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Computes a record's chain hash: SHA-256 (hex) over the canonical JSON
 * serialization of the record's own content (everything except `hash` and
 * `prevHash`) plus the previous record's hash. The genesis record's
 * `prevHash` is `''`.
 *
 * This is the single source of truth for the hash-chain algorithm — both
 * `src/audit/fs-append-sink.ts` (writing) and `src/audit/verify.ts`
 * (replaying/verifying) call this same function, so a written chain and a
 * verified chain can never silently drift apart.
 */
export function computeHash(record: Omit<AuditRecord, 'hash' | 'prevHash'>, prevHash: string): string {
  const canonical = canonicalStringify({ ...record, prevHash });
  return createHash('sha256').update(canonical).digest('hex');
}
