import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_GENESIS_SEQ, ChainRecordSchema, computeHash } from './record.ts';
import type { ChainRecord } from './record.ts';
import { listDayFiles } from './read-chain.ts';

export interface VerifyResult {
  valid: boolean;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Replays every day-partitioned `.jsonl` file under `auditDir` in
 * chronological order and re-derives the hash chain from scratch, proving
 * (or disproving) that no record's content, `prevHash`, or `hash` has been
 * tampered with since it was written.
 *
 * This makes the log tamper-EVIDENT, not tamper-PROOF: a local attacker
 * with write access to `.magi/audit/` could in principle rewrite the
 * entire chain (including HEAD) self-consistently. That is a documented
 * limitation of this design (see `sdd/magi/design`), not solved in this PR.
 *
 * NOTE: a CLI entrypoint (`magi audit verify`) is NOT wired up in this PR —
 * no CLI exists until Phase 9 (a later PR). This is the library function
 * only, proven directly by `tests/audit/verify.test.ts`.
 */
export function verifyChain(auditDir: string): VerifyResult {
  const dayFiles = listDayFiles(auditDir);

  let expectedSeq = AUDIT_GENESIS_SEQ;
  let expectedPrevHash = '';

  for (const fileName of dayFiles) {
    const filePath = path.join(auditDir, fileName);
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    for (const line of lines) {
      let record: ChainRecord;
      try {
        record = ChainRecordSchema.parse(JSON.parse(line));
      } catch {
        return { valid: false, brokenAtSeq: expectedSeq, reason: 'malformed or schema-invalid record' };
      }

      if (record.seq !== expectedSeq) {
        return { valid: false, brokenAtSeq: expectedSeq, reason: 'sequence gap, duplicate, or reorder' };
      }
      if (record.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAtSeq: record.seq, reason: 'prevHash does not match the prior record' };
      }

      const { hash, prevHash, ...contentWithoutHash } = record;
      const recomputed = computeHash(contentWithoutHash, prevHash);
      if (recomputed !== hash) {
        return { valid: false, brokenAtSeq: record.seq, reason: 'content/hash mismatch (tampered)' };
      }

      expectedSeq += 1;
      expectedPrevHash = record.hash;
    }
  }

  return { valid: true };
}
