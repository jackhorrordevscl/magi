import { computeAuditStats, formatAuditStats } from '../audit-stats.ts';
import type { AuditStats } from '../audit-stats.ts';
import { readChainRecords } from '../../audit/read-chain.ts';
import type { AuditRecord, ChainRecord } from '../../audit/record.ts';
import type { SeverityTier } from '../../gating/proposed-action.ts';

/**
 * Read-only view model over the audit chain for the TUI's Audit screen
 * (`app.ts`, Slice 3). Introduces no new aggregation logic and never writes
 * to `auditDir`.
 *
 * (a) `auditSummary` wraps the existing `computeAuditStats()`/
 * `formatAuditStats()` (`src/cli/audit-stats.ts`) as-is, so the TUI panel
 * can never drift from `magi audit stats`' own output (spec: Audit Stats
 * Summary Is Read-Only and Reuses Existing Aggregation).
 *
 * (b) `deniedRecords` builds the individually-navigable denied-records list
 * from `readChainRecords` (`src/audit/read-chain.ts`), filtered to verdict
 * records (`ChainRecord`'s `AuditRecord` arm — has `decision`) with
 * `decision === 'deny'`, mirroring `computeAuditStats`'s own
 * `isVerdictRecord` partition; override records (the `OverrideRecord` arm —
 * has `override`, no `decision`) are always excluded. `readChainRecords`
 * has no cursor API and already materializes the whole chain, so the
 * 500-row cap here bounds render cost only, not read cost (design
 * decision 9).
 */

const DEFAULT_AUDIT_DIR = '.magi/audit';
const MAX_DENIED_ROWS = 500;

export interface AuditSummaryView {
  stats: AuditStats;
  /** `formatAuditStats(stats)` — identical lines to `magi audit stats`. */
  lines: string[];
}

/** (a) — read-only; performs no writes to `auditDir`. */
export function auditSummary(auditDir: string = DEFAULT_AUDIT_DIR): AuditSummaryView {
  const stats = computeAuditStats(auditDir);
  return { stats, lines: formatAuditStats(stats) };
}

export interface DeniedRecordRow {
  hash: string;
  seq: number;
  timestamp: string;
  severity: SeverityTier;
}

export interface DeniedRecordsView {
  /** Newest-first, capped at `MAX_DENIED_ROWS`. */
  rows: DeniedRecordRow[];
  /** Total denied verdict records found, before the render cap. */
  totalDenied: number;
  truncated: boolean;
}

function isVerdictRecord(record: ChainRecord): record is AuditRecord {
  return 'decision' in record;
}

/** (b) — read-only; performs no writes to `auditDir`. */
export function deniedRecords(auditDir: string = DEFAULT_AUDIT_DIR): DeniedRecordsView {
  const records = readChainRecords(auditDir);
  const denied = records.filter(
    (record): record is AuditRecord => isVerdictRecord(record) && record.decision === 'deny',
  );

  // readChainRecords walks day files in chronological (oldest-first) order,
  // and records within a file are chronological too (monotonic seq) — so
  // reversing the chronological list yields newest-first.
  const newestFirst = denied.slice().reverse();
  const rows = newestFirst.slice(0, MAX_DENIED_ROWS).map((record) => ({
    hash: record.hash,
    seq: record.seq,
    timestamp: record.timestamp,
    severity: record.severity,
  }));

  return { rows, totalDenied: denied.length, truncated: denied.length > MAX_DENIED_ROWS };
}

/** `undefined` when the list was not truncated — render nothing in that case. */
export function deniedRecordsFooter(view: DeniedRecordsView): string | undefined {
  return view.truncated ? `showing newest ${MAX_DENIED_ROWS} of ${view.totalDenied}` : undefined;
}
