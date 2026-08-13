import type { AuditRecord } from './record.ts';
import type { Verdict } from '../gating/verdict.ts';

/**
 * Port for durably appending gating verdicts to the tamper-evident,
 * hash-chained audit log. See `src/audit/fs-append-sink.ts` for the
 * filesystem-backed implementation used at runtime.
 */
export interface AuditSink {
  /**
   * Appends `verdict` as the next record in the hash chain, durably
   * persisting it (write + fsync) BEFORE this call returns/resolves.
   *
   * `now` is an explicit parameter rather than the implementation reading
   * `Date.now()` internally: it is both the record's `timestamp` and the
   * selector for which day-partitioned log file the record lands in, which
   * keeps day-rollover behavior deterministic and testable.
   */
  append(verdict: Verdict, now: Date): AuditRecord;
}
