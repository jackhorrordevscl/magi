import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import { computeHash, AUDIT_GENESIS_SEQ, ChainRecordSchema } from '../../src/audit/record.ts';
import type { AuditRecord, ChainRecord } from '../../src/audit/record.ts';
import type { Verdict } from '../../src/gating/verdict.ts';

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-audit-'));
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    actor: 'test-agent',
    mode: 'shadow',
    action: 'git status',
    severity: 'low',
    votes: [
      { evaluator: 'melchior', vote: 'allow', rationale: 'ok' },
      { evaluator: 'balthasar', vote: 'allow', rationale: 'ok' },
      { evaluator: 'casper', vote: 'allow', rationale: 'ok' },
    ],
    decision: 'allow',
    calibrationCorpusHash: '',
    exemplarIds: [],
    corpusDegraded: false,
    ...overrides,
  };
}

function readDayFileRecords(auditDir: string, date: Date): AuditRecord[] {
  const fileName = `${date.toISOString().slice(0, 10)}.jsonl`;
  const filePath = path.join(auditDir, fileName);
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

describe('FsAppendAuditSink — hash-chain integrity', () => {
  test('seq starts at AUDIT_GENESIS_SEQ (0) and increments monotonically', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const r0 = sink.append(verdict(), now);
    const r1 = sink.append(verdict(), now);
    const r2 = sink.append(verdict(), now);

    assert.equal(r0.seq, AUDIT_GENESIS_SEQ);
    assert.equal(r0.seq, 0);
    assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2);
  });

  test('each record.prevHash equals the previous record.hash; genesis prevHash is empty string', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const r0 = sink.append(verdict(), now);
    const r1 = sink.append(verdict(), now);
    const r2 = sink.append(verdict(), now);

    assert.equal(r0.prevHash, '');
    assert.equal(r1.prevHash, r0.hash);
    assert.equal(r2.prevHash, r1.hash);
  });

  test('each record.hash is independently reproducible via computeHash(content, prevHash)', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const r0 = sink.append(verdict(), now);
    const { hash, prevHash, ...content } = r0;
    assert.equal(computeHash(content, prevHash), hash);
  });

  test('N sequential records produce a chain readable straight from the day file', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    for (let i = 0; i < 5; i++) sink.append(verdict(), now);

    const records = readDayFileRecords(dir, now);
    assert.equal(records.length, 5);
    for (let i = 0; i < records.length; i++) {
      assert.equal(records[i]?.seq, i);
      if (i > 0) assert.equal(records[i]?.prevHash, records[i - 1]?.hash);
    }
  });

  test('.magi/audit/HEAD tracks the latest seq and hash', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    sink.append(verdict(), now);
    const last = sink.append(verdict(), now);

    const head = JSON.parse(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8')) as {
      seq: number;
      hash: string;
    };
    assert.equal(head.seq, last.seq);
    assert.equal(head.hash, last.hash);
  });
});

describe('FsAppendAuditSink — durable write ordering (O_APPEND write + fsync BEFORE returning)', () => {
  test('the record is present on disk synchronously by the time append() returns', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const record = sink.append(verdict(), now);

    // No await, no setImmediate — if append() returned before the durable
    // write completed, this synchronous read would miss the record.
    const onDisk = readDayFileRecords(dir, now);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]?.hash, record.hash);
  });

  test('call order proof: writeSync happens, then fsyncSync happens, then append() returns', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const calls: string[] = [];
    const originalWriteSync = fs.writeSync;
    const originalFsyncSync = fs.fsyncSync;

    // Spy by direct reassignment (not a mocking library): the fs module's
    // default export is a plain, mutable object, and fs-append-sink.ts
    // calls through it (`fs.writeSync(...)`), so this reassignment is
    // observed by the code under test without needing to change it.
    fs.writeSync = ((...args: Parameters<typeof originalWriteSync>) => {
      calls.push('writeSync');
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;
    fs.fsyncSync = ((...args: Parameters<typeof originalFsyncSync>) => {
      calls.push('fsyncSync');
      return originalFsyncSync(...args);
    }) as typeof fs.fsyncSync;

    try {
      sink.append(verdict(), now);
      calls.push('returned');
    } finally {
      fs.writeSync = originalWriteSync;
      fs.fsyncSync = originalFsyncSync;
    }

    // append() durably writes the day-file record AND the HEAD pointer —
    // two write/fsync pairs — then returns.
    assert.equal(calls[calls.length - 1], 'returned');
    assert.equal(calls.filter((c) => c === 'writeSync').length, 2);
    assert.equal(calls.filter((c) => c === 'fsyncSync').length, 2);
    for (let i = 0; i < calls.length - 1; i += 1) {
      if (calls[i] === 'writeSync') assert.equal(calls[i + 1], 'fsyncSync');
    }
  });
});

describe('FsAppendAuditSink — day rollover', () => {
  test('the previous day file is sealed read-only (chmod 0444) once a new day record is appended', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const day1 = new Date('2026-08-12T23:59:00.000Z');
    const day2 = new Date('2026-08-13T00:05:00.000Z');

    sink.append(verdict(), day1);
    const day1FilePath = path.join(dir, '2026-08-12.jsonl');
    assert.equal((fs.statSync(day1FilePath).mode & 0o200) !== 0, true, 'day1 file writable before rollover');

    sink.append(verdict(), day2);

    const mode = fs.statSync(day1FilePath).mode;
    assert.equal((mode & 0o200) === 0, true, 'day1 file should have no owner-write bit after rollover');

    const day2FilePath = path.join(dir, '2026-08-13.jsonl');
    assert.equal(fs.existsSync(day2FilePath), true);
  });

  test('records continue to chain across the day boundary (seq/prevHash unaffected by rollover)', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const day1 = new Date('2026-08-12T23:59:00.000Z');
    const day2 = new Date('2026-08-13T00:05:00.000Z');

    const r0 = sink.append(verdict(), day1);
    const r1 = sink.append(verdict(), day2);

    assert.equal(r1.seq, r0.seq + 1);
    assert.equal(r1.prevHash, r0.hash);
  });

  test('same-day records never seal the current file mid-day', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    sink.append(verdict(), now);
    sink.append(verdict(), now);
    const filePath = path.join(dir, '2026-08-12.jsonl');
    assert.equal((fs.statSync(filePath).mode & 0o200) !== 0, true);
  });
});

function readDayFileChainRecords(auditDir: string, date: Date): ChainRecord[] {
  const fileName = `${date.toISOString().slice(0, 10)}.jsonl`;
  const filePath = path.join(auditDir, fileName);
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ChainRecordSchema.parse(JSON.parse(line)));
}

describe('FsAppendAuditSink — appendOverride', () => {
  test('appendOverride continues the SAME chain as append (seq/prevHash bookkeeping shared)', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const verdictRecord = sink.append(verdict({ decision: 'deny' }), now);
    const overrideRecord = sink.appendOverride(
      { targetHash: verdictRecord.hash, targetSeq: verdictRecord.seq, actor: 'operator', reason: 'verified manually' },
      now,
    );

    assert.equal(overrideRecord.seq, verdictRecord.seq + 1);
    assert.equal(overrideRecord.prevHash, verdictRecord.hash);
    assert.equal(overrideRecord.override.targetHash, verdictRecord.hash);
    assert.equal(overrideRecord.override.targetSeq, verdictRecord.seq);
    assert.equal(overrideRecord.override.reason, 'verified manually');
  });

  test("appendOverride's hash is independently reproducible via computeHash(content, prevHash)", () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const verdictRecord = sink.append(verdict({ decision: 'deny' }), now);
    const overrideRecord = sink.appendOverride(
      { targetHash: verdictRecord.hash, targetSeq: verdictRecord.seq, actor: 'operator', reason: 'ok' },
      now,
    );

    const { hash, prevHash, ...content } = overrideRecord;
    assert.equal(computeHash(content, prevHash), hash);
  });

  test('HEAD tracks the override record after it becomes the latest chain entry', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const verdictRecord = sink.append(verdict({ decision: 'deny' }), now);
    const overrideRecord = sink.appendOverride(
      { targetHash: verdictRecord.hash, targetSeq: verdictRecord.seq, actor: 'operator', reason: 'ok' },
      now,
    );

    const head = JSON.parse(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8')) as { seq: number; hash: string };
    assert.equal(head.seq, overrideRecord.seq);
    assert.equal(head.hash, overrideRecord.hash);
  });

  test('appendOverride triggers day rollover identically to append', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const day1 = new Date('2026-08-12T23:59:00.000Z');
    const day2 = new Date('2026-08-13T00:05:00.000Z');

    const verdictRecord = sink.append(verdict({ decision: 'deny' }), day1);
    const day1FilePath = path.join(dir, '2026-08-12.jsonl');
    assert.equal((fs.statSync(day1FilePath).mode & 0o200) !== 0, true, 'day1 file writable before rollover');

    sink.appendOverride(
      { targetHash: verdictRecord.hash, targetSeq: verdictRecord.seq, actor: 'operator', reason: 'ok' },
      day2,
    );

    const mode = fs.statSync(day1FilePath).mode;
    assert.equal((mode & 0o200) === 0, true, 'day1 file should have no owner-write bit after rollover');
    assert.equal(fs.existsSync(path.join(dir, '2026-08-13.jsonl')), true);
  });

  test('a chain mixing verdict and override records round-trips through ChainRecordSchema', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const verdictRecord = sink.append(verdict({ decision: 'deny' }), now);
    sink.appendOverride(
      { targetHash: verdictRecord.hash, targetSeq: verdictRecord.seq, actor: 'operator', reason: 'ok' },
      now,
    );

    const records = readDayFileChainRecords(dir, now);
    assert.equal(records.length, 2);
    assert.equal('override' in records[0]!, false);
    assert.equal('override' in records[1]!, true);
  });
});
