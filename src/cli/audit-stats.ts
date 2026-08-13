import fs from 'node:fs';
import path from 'node:path';
import { AuditRecordSchema } from '../audit/record.ts';
import type { AuditDecision, AuditRecord } from '../audit/record.ts';
import type { SeverityTier } from '../gating/proposed-action.ts';

const DEFAULT_AUDIT_DIR = '.magi/audit';

export interface AuditStats {
  totalRecords: number;
  byDecision: Record<AuditDecision, number>;
  bySeverity: Record<SeverityTier, number>;
  /**
   * Fraction (0-1) of gated audit records whose verdict was `deny` — a raw
   * proxy for the P1 shadow-mode false-positive rate (per
   * `sdd/magi/design`'s rollout: "records, blocks nothing, measures
   * false-positive rate"). This is NOT itself a false-positive rate: MAGI
   * has no ground truth about the human operator's actual intent, so this
   * number only tells you how often shadow mode WOULD have blocked.
   * Confirming which of those denials are genuinely false positives still
   * requires a human reviewing the individual denied records (e.g. via
   * `magi calibrate import` to turn confirmed false positives into
   * calibration exemplars).
   */
  denyRateProxy: number;
}

function listDayFiles(auditDir: string): string[] {
  if (!fs.existsSync(auditDir)) return [];
  return fs
    .readdirSync(auditDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

function readAllRecords(auditDir: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const fileName of listDayFiles(auditDir)) {
    const lines = fs
      .readFileSync(path.join(auditDir, fileName), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      records.push(AuditRecordSchema.parse(JSON.parse(line)));
    }
  }
  return records;
}

const ZERO_DECISION: Record<AuditDecision, number> = { allow: 0, deny: 0 };
const ZERO_SEVERITY: Record<SeverityTier, number> = { low: 0, medium: 0, high: 0, critical: 0 };

/**
 * Reads every audit record under `auditDir` (default `.magi/audit`) and
 * aggregates verdict distribution plus the P1 shadow-mode
 * false-positive-rate proxy. Pure aggregation over already-written records
 * — no model call, no network. Backs the `magi audit stats` CLI command
 * (see `src/cli/main.ts`).
 */
export function computeAuditStats(auditDir: string = DEFAULT_AUDIT_DIR): AuditStats {
  const records = readAllRecords(auditDir);

  const byDecision: Record<AuditDecision, number> = { ...ZERO_DECISION };
  const bySeverity: Record<SeverityTier, number> = { ...ZERO_SEVERITY };
  for (const record of records) {
    byDecision[record.decision] += 1;
    bySeverity[record.severity] += 1;
  }

  const denyRateProxy = records.length === 0 ? 0 : byDecision.deny / records.length;

  return { totalRecords: records.length, byDecision, bySeverity, denyRateProxy };
}

/** Human-readable rendering of `AuditStats`, for the `magi audit stats` CLI output. */
export function formatAuditStats(stats: AuditStats): string[] {
  return [
    `Total gated records: ${stats.totalRecords}`,
    `Decisions — allow: ${stats.byDecision.allow}, deny: ${stats.byDecision.deny}`,
    `Severity — low: ${stats.bySeverity.low}, medium: ${stats.bySeverity.medium}, ` +
      `high: ${stats.bySeverity.high}, critical: ${stats.bySeverity.critical}`,
    `Deny-rate proxy: ${(stats.denyRateProxy * 100).toFixed(1)}% ` +
      '(raw proxy only — confirm each denial with a human before treating it as a real false positive)',
  ];
}
