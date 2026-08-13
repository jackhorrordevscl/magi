import { readChainRecords } from '../audit/read-chain.ts';
import type { AuditDecision, AuditRecord, OverrideRecord } from '../audit/record.ts';
import type { SeverityTier } from '../gating/proposed-action.ts';

const DEFAULT_AUDIT_DIR = '.magi/audit';

export interface AuditStats {
  /** Count of verdict records only (design decision #8) — override records are never counted here. */
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
   *
   * The denominator is verdict records only (`totalRecords`) — overrides
   * are never counted in it (design decision #8): including them would
   * silently deflate this proxy without changing what actually happened.
   */
  denyRateProxy: number;
  /** Count of override records — a metric distinct from `byDecision` (spec Requirement: Override Count Reported Separately). Overriding a deny NEVER reclassifies it out of `byDecision.deny`. */
  overrideCount: number;
  /** `overrideCount / byDecision.deny` — "share of denies a human disputed". `0` when there are no denies. */
  overrideRate: number;
}

const ZERO_DECISION: Record<AuditDecision, number> = { allow: 0, deny: 0 };
const ZERO_SEVERITY: Record<SeverityTier, number> = { low: 0, medium: 0, high: 0, critical: 0 };

function isVerdictRecord(record: AuditRecord | OverrideRecord): record is AuditRecord {
  return 'decision' in record;
}

/**
 * Reads every chain record under `auditDir` (default `.magi/audit`) and
 * aggregates verdict distribution, the P1 shadow-mode false-positive-rate
 * proxy, and override accounting. Pure aggregation over already-written
 * records — no model call, no network. Backs the `magi audit stats` CLI
 * command (see `src/cli/main.ts`).
 *
 * Partitions `readChainRecords`' single list into verdict records (carry
 * `decision`) and override records (carry `override`) per design decision
 * #8: overrides are a separate metric, never folded into `byDecision` or
 * `denyRateProxy`'s denominator.
 */
export function computeAuditStats(auditDir: string = DEFAULT_AUDIT_DIR): AuditStats {
  const records = readChainRecords(auditDir);
  const verdictRecords = records.filter(isVerdictRecord);
  const overrideRecords = records.filter((record): record is OverrideRecord => !isVerdictRecord(record));

  const byDecision: Record<AuditDecision, number> = { ...ZERO_DECISION };
  const bySeverity: Record<SeverityTier, number> = { ...ZERO_SEVERITY };
  for (const record of verdictRecords) {
    byDecision[record.decision] += 1;
    bySeverity[record.severity] += 1;
  }

  const denyRateProxy = verdictRecords.length === 0 ? 0 : byDecision.deny / verdictRecords.length;
  const overrideCount = overrideRecords.length;
  const overrideRate = byDecision.deny === 0 ? 0 : overrideCount / byDecision.deny;

  return {
    totalRecords: verdictRecords.length,
    byDecision,
    bySeverity,
    denyRateProxy,
    overrideCount,
    overrideRate,
  };
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
    `Overrides: ${stats.overrideCount} (${(stats.overrideRate * 100).toFixed(1)}% of denies overridden — ` +
      'documentary only, does not reclassify the original deny)',
  ];
}
