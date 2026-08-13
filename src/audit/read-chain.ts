import fs from 'node:fs';
import path from 'node:path';
import { ChainRecordSchema } from './record.ts';
import type { ChainRecord } from './record.ts';

/**
 * Lists day-partitioned `.jsonl` files under `auditDir` in chronological
 * order (lexicographic sort matches chronological order for `YYYY-MM-DD`
 * filenames). Shared by `verifyChain` (`src/audit/verify.ts`) and
 * `readChainRecords` below, so both walk the exact same file set in the
 * exact same order.
 */
export function listDayFiles(auditDir: string): string[] {
  if (!fs.existsSync(auditDir)) return [];
  return fs
    .readdirSync(auditDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

/**
 * Reads every record across every day file under `auditDir`, in
 * chronological order, parsing each line with `ChainRecordSchema` so both
 * verdict and override records come back through a single list. Soft-fails
 * per line: a malformed or schema-invalid line is skipped rather than
 * aborting the whole read. Consumers here (`magi audit stats`, `magi audit
 * override`'s target lookup) need a best-effort view of the chain content,
 * not a tamper-evidence proof — that is `verifyChain`'s job, not this
 * function's.
 */
export function readChainRecords(auditDir: string): ChainRecord[] {
  const records: ChainRecord[] = [];

  for (const fileName of listDayFiles(auditDir)) {
    const filePath = path.join(auditDir, fileName);
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    for (const line of lines) {
      try {
        records.push(ChainRecordSchema.parse(JSON.parse(line)));
      } catch {
        // soft-fail: skip malformed/schema-invalid lines, same convention
        // as verifyChain's per-line handling.
      }
    }
  }

  return records;
}
