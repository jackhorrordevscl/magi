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
  calibrationCorpusHash: z.string(),
  exemplarIds: z.array(z.string()),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/**
 * The structured payload of a human override: which prior record it
 * disputes (by content hash and, redundantly, by seq) and why. `reason` is
 * mandatory — an override with no rationale is never valid (see
 * `src/cli/audit-override.ts`, PR3).
 */
export const OverrideSchema = z.object({
  targetHash: z.string().min(1),
  targetSeq: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export type Override = z.infer<typeof OverrideSchema>;

/**
 * A second, distinct record kind appended to the same hash chain as
 * `AuditRecordSchema` — never a mutation of the original verdict record.
 * Shares the same chain bookkeeping fields (`seq`/`prevHash`/`hash`/
 * `timestamp`/`actor`/`mode`) so `computeHash`/`verifyChain` treat both
 * kinds uniformly; `override` is REQUIRED here and does not exist at all on
 * `AuditRecordSchema`, so "a verdict record claims to be overridden" is a
 * type-level impossibility rather than a runtime check.
 */
export const OverrideRecordSchema = z.object({
  seq: z.number().int().nonnegative(),
  prevHash: z.string(),
  hash: z.string(),
  timestamp: z.string(),
  actor: z.string().min(1),
  mode: MagiModeSchema,
  override: OverrideSchema,
});
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;

/**
 * Every record kind that can legally appear in the hash chain. Readers
 * (`verifyChain`, `readChainRecords`) parse each line against this union
 * rather than `AuditRecordSchema` alone, so the chain can carry both
 * verdict and override records interchangeably.
 */
export const ChainRecordSchema = z.union([OverrideRecordSchema, AuditRecordSchema]);
export type ChainRecord = z.infer<typeof ChainRecordSchema>;

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
 * `Omit<ChainRecord, 'hash' | 'prevHash'>` would NOT distribute over the
 * `ChainRecordSchema` union — `Omit` on a union type collapses to the
 * union's common keys first, so `override` (present on `OverrideRecord`
 * only) and the verdict-only fields (`action`/`severity`/`votes`/
 * `decision`/`calibrationCorpusHash`/`exemplarIds`) would both be silently
 * dropped from the parameter type. `T extends infer R ? ... : never` only
 * distributes when `T` is a naked type parameter of an enclosing generic —
 * referencing `ChainRecord` directly (an already-resolved union alias) does
 * NOT distribute, it silently collapses to the common-keys case above. Going
 * through `Distribute<T>` first makes `T` a naked parameter, which does.
 */
type Distribute<T, K extends keyof any> = T extends infer R ? Omit<R, K & keyof R> : never;
/**
 * Exported so `fs-append-sink.ts`'s shared generic `appendRecord<T>` can
 * assert its per-call content into this shape at the single point where it
 * calls `computeHash`. That assertion is narrow and sound in practice: each
 * of the two public call sites (`append`/`appendOverride`) builds content
 * matching exactly one arm of this union, but `Omit<T, K>` over an abstract
 * generic `T` can't be proven (by TS's structural checker) to land in one
 * specific arm of an already-distributed union — that's a limitation of
 * generic inference through mapped types, not a gap in this type itself.
 */
export type ChainContent = Distribute<ChainRecord, 'hash' | 'prevHash'>;

/**
 * Computes a record's chain hash: SHA-256 (hex) over the canonical JSON
 * serialization of the record's own content (everything except `hash` and
 * `prevHash`) plus the previous record's hash. The genesis record's
 * `prevHash` is `''`.
 *
 * This is the single source of truth for the hash-chain algorithm — both
 * `src/audit/fs-append-sink.ts` (writing) and `src/audit/verify.ts`
 * (replaying/verifying) call this same function, so a written chain and a
 * verified chain can never silently drift apart. It accepts the content of
 * EITHER chain record kind (verdict or override) via `ChainContent`.
 */
export function computeHash(record: ChainContent, prevHash: string): string {
  const canonical = canonicalStringify({ ...record, prevHash });
  return createHash('sha256').update(canonical).digest('hex');
}
