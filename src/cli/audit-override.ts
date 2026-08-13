import { readChainRecords } from '../audit/read-chain.ts';
import { FsAppendAuditSink } from '../audit/fs-append-sink.ts';
import type { OverrideRecord } from '../audit/record.ts';

/**
 * `magi audit override <hash> --reason "<why>"` — the library function
 * backing the CLI subcommand (wired in `src/cli/main.ts`). Documents that a
 * previously recorded `deny` should be disregarded, WITHOUT mutating the
 * hash chain (see `sdd/magi-p3-enforcing-override/spec`, Requirement:
 * Override Is Append-Only and Non-Mutating) and WITHOUT creating an
 * allowlist entry or re-running the underlying action (Requirement: Override
 * Is Documentary Only — that is left to a separate operator re-attempt).
 */

export interface RunAuditOverrideInput {
  auditDir: string;
  /** Identifies the target record by its content `hash`, never by `seq` (spec Requirement: Override Targets a Record By Hash). */
  targetHash: string;
  reason: string;
  /** Defaults to `'operator'` — the human running the CLI, distinct from the `actor` on the original gated action. */
  actor?: string;
  now?: Date;
}

export interface RunAuditOverrideResult {
  ok: boolean;
  error?: string;
  record?: OverrideRecord;
}

/**
 * Validates and, on success, appends a human-override record. Every
 * rejection path (unknown hash, missing/empty reason, target `decision !==
 * 'deny'`) returns before `FsAppendAuditSink.appendOverride()` is ever
 * called — so a rejected override writes nothing at all, byte-identical
 * chain file + HEAD (spec scenarios: "Override with unknown hash", "Missing
 * reason", "Empty reason", "Overriding an allow record is rejected").
 */
export function runAuditOverride(input: RunAuditOverrideInput): RunAuditOverrideResult {
  const reason = input.reason;
  if (typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, error: 'a non-empty --reason is required' };
  }

  const records = readChainRecords(input.auditDir);
  const target = records.find((record) => record.hash === input.targetHash);
  if (!target) {
    return { ok: false, error: `no audit record found with hash "${input.targetHash}"` };
  }

  // Only a verdict record carries `decision`; an override record does not
  // (see `src/audit/record.ts`'s `ChainRecordSchema`), so this also
  // correctly rejects attempts to override an override.
  if (!('decision' in target) || target.decision !== 'deny') {
    return { ok: false, error: `record "${input.targetHash}" is not a deny verdict, nothing to override` };
  }

  const sink = new FsAppendAuditSink(input.auditDir);
  const record = sink.appendOverride(
    {
      targetHash: target.hash,
      targetSeq: target.seq,
      actor: input.actor ?? 'operator',
      reason,
    },
    input.now ?? new Date(),
  );

  return { ok: true, record };
}
