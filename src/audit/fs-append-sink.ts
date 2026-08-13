import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_GENESIS_SEQ, AuditRecordSchema, OverrideRecordSchema, computeHash } from './record.ts';
import type { AuditRecord, ChainContent, OverrideRecord } from './record.ts';
import type { AuditSink } from './audit-sink.ts';
import type { Verdict } from '../gating/verdict.ts';

const DEFAULT_AUDIT_DIR = '.magi/audit';
const HEAD_FILENAME = 'HEAD';

interface HeadState {
  seq: number;
  hash: string;
  /** UTC `YYYY-MM-DD` date of the last-written record — drives rollover. */
  date: string;
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Filesystem-backed `AuditSink`: writes hash-chained JSONL records under
 * `<auditDir>/YYYY-MM-DD.jsonl` (one file per UTC day, per record
 * timestamp) and durably persists each write — O_APPEND write + fsync —
 * BEFORE `append()` returns. `now` is always an explicit parameter (never
 * an internal `Date.now()` call), which keeps day-rollover behavior
 * deterministic and directly testable.
 */
export class FsAppendAuditSink implements AuditSink {
  private readonly auditDir: string;

  // NOTE: TypeScript constructor parameter-property shorthand
  // (`constructor(private readonly x: T)`) is NOT supported by Node's
  // native strip-only TS execution mode (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
  // — this project runs `.ts` files directly via `node --test`/`node`, so
  // every class in this codebase must assign fields explicitly instead.
  constructor(auditDir: string = DEFAULT_AUDIT_DIR) {
    this.auditDir = auditDir;
  }

  append(verdict: Verdict, now: Date): AuditRecord {
    return this.appendRecord<AuditRecord>(
      (seq, timestamp) => ({
        seq,
        timestamp,
        actor: verdict.actor,
        mode: verdict.mode,
        action: verdict.action,
        severity: verdict.severity,
        votes: verdict.votes,
        decision: verdict.decision,
        calibrationCorpusHash: verdict.calibrationCorpusHash,
        exemplarIds: verdict.exemplarIds,
      }),
      AuditRecordSchema,
      now,
    );
  }

  /**
   * Appends a human-override record referencing an earlier deny record by
   * hash/seq. Lives on `FsAppendAuditSink` only (not the `AuditSink` port —
   * see design decision #5): the hook adapter never overrides, only the
   * `magi audit override` CLI does (`src/cli/audit-override.ts`, PR3).
   *
   * `mode` is hardcoded to `'enforced'` here rather than accepted as an
   * input: an override is only ever operationally meaningful for a deny
   * that actually blocked something, which only happens under enforced
   * mode (see spec `audited-human-override` — shadow-mode denies never
   * block, so there is nothing for an operator to override).
   */
  appendOverride(
    input: { targetHash: string; targetSeq: number; actor: string; reason: string },
    now: Date,
  ): OverrideRecord {
    return this.appendRecord<OverrideRecord>(
      (seq, timestamp) => ({
        seq,
        timestamp,
        actor: input.actor,
        mode: 'enforced',
        override: {
          targetHash: input.targetHash,
          targetSeq: input.targetSeq,
          reason: input.reason,
        },
      }),
      OverrideRecordSchema,
      now,
    );
  }

  /**
   * Shared chain-append bookkeeping: reads HEAD to derive the next `seq`/
   * `prevHash`, handles day-rollover sealing, computes the durable
   * timestamp, hashes and validates the record via `schema`, then durably
   * writes both the day-file line and the HEAD pointer (write + fsync,
   * both BEFORE returning) — byte-identical for every record kind, so the
   * chain can never fork depending on which record kind was appended.
   *
   * `buildContent` receives the derived `seq`/`timestamp` and returns the
   * record's full content minus `hash`/`prevHash`, in the shape of
   * whichever chain record kind `T` is (`AuditRecord` or `OverrideRecord`).
   */
  private appendRecord<T extends AuditRecord | OverrideRecord>(
    buildContent: (seq: number, timestamp: string) => Omit<T, 'hash' | 'prevHash'>,
    schema: { parse: (input: unknown) => T },
    now: Date,
  ): T {
    fs.mkdirSync(this.auditDir, { recursive: true });

    const head = this.readHead();
    const seq = head ? head.seq + 1 : AUDIT_GENESIS_SEQ;
    const prevHash = head ? head.hash : '';

    if (head && head.date !== utcDateString(now)) {
      this.sealPreviousDay(head.date);
    }

    const timestamp = now.toISOString();
    const contentWithoutHash = buildContent(seq, timestamp);
    // Sound but unprovable to TS: each concrete call site (append/appendOverride)
    // builds content matching exactly one arm of ChainContent — see the type's
    // own doc comment in record.ts for why generic inference can't confirm this.
    const hash = computeHash(contentWithoutHash as ChainContent, prevHash);
    const record = schema.parse({ ...contentWithoutHash, prevHash, hash });

    const dateStr = utcDateString(now);
    this.appendDurably(`${dateStr}.jsonl`, `${JSON.stringify(record)}\n`);
    this.writeHeadDurably({ seq, hash, date: dateStr });

    return record;
  }

  private headPath(): string {
    return path.join(this.auditDir, HEAD_FILENAME);
  }

  private dayFilePath(fileName: string): string {
    return path.join(this.auditDir, fileName);
  }

  private readHead(): HeadState | null {
    const headPath = this.headPath();
    if (!fs.existsSync(headPath)) return null;
    const raw = fs.readFileSync(headPath, 'utf8').trim();
    if (raw.length === 0) return null;
    return JSON.parse(raw) as HeadState;
  }

  /** Durable write: O_APPEND-opened fd, write, fsync, all BEFORE returning. */
  private appendDurably(fileName: string, line: string): void {
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY;
    const fd = fs.openSync(this.dayFilePath(fileName), flags, 0o644);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Durable write of the HEAD pointer. HEAD is a single current-state
   * pointer (not a log), so this truncates and rewrites it in place —
   * still write + fsync BEFORE returning, same durability guarantee.
   */
  private writeHeadDurably(head: HeadState): void {
    const fd = fs.openSync(this.headPath(), 'w');
    try {
      fs.writeSync(fd, JSON.stringify(head));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Day-rollover: once a new record's date differs from the last-written
   * file's date, that previous day's file is sealed read-only
   * (`chmod 0444`). A day's file is never sealed prematurely — only once a
   * later record, on a genuinely different date, proves that day is over.
   */
  private sealPreviousDay(previousDate: string): void {
    const previousPath = this.dayFilePath(`${previousDate}.jsonl`);
    if (fs.existsSync(previousPath)) {
      fs.chmodSync(previousPath, 0o444);
    }
  }
}
