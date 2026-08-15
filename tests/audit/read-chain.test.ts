import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import { listDayFiles, readChainRecords } from '../../src/audit/read-chain.ts';
import type { Verdict } from '../../src/gating/verdict.ts';

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-audit-read-chain-'));
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

describe('listDayFiles', () => {
  test('returns [] for a never-written / nonexistent audit dir', () => {
    const dir = tmpAuditDir();
    assert.deepEqual(listDayFiles(path.join(dir, 'does-not-exist')), []);
  });

  test('returns only .jsonl files, sorted chronologically', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict(), new Date('2026-08-13T00:05:00.000Z'));
    sink.append(verdict(), new Date('2026-08-12T23:59:00.000Z'));

    assert.deepEqual(listDayFiles(dir), ['2026-08-12.jsonl', '2026-08-13.jsonl']);
  });
});

describe('readChainRecords', () => {
  test('returns [] for an empty audit dir', () => {
    const dir = tmpAuditDir();
    assert.deepEqual(readChainRecords(dir), []);
  });

  test('returns every record across every day file, in chronological order', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const r0 = sink.append(verdict(), new Date('2026-08-12T23:59:00.000Z'));
    const r1 = sink.append(verdict(), new Date('2026-08-13T00:05:00.000Z'));

    const records = readChainRecords(dir);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.seq, r0.seq);
    assert.equal(records[0]?.hash, r0.hash);
    assert.equal(records[1]?.seq, r1.seq);
    assert.equal(records[1]?.hash, r1.hash);
  });

  test('returns both verdict and override records from a mixed chain', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    const denyRecord = sink.append(verdict({ decision: 'deny' }), now);
    const overrideRecord = sink.appendOverride(
      { targetHash: denyRecord.hash, targetSeq: denyRecord.seq, actor: 'operator', reason: 'verified manually' },
      now,
    );

    const records = readChainRecords(dir);
    assert.equal(records.length, 2);
    assert.equal('override' in records[0]!, false);
    assert.equal('override' in records[1]!, true);
    if ('override' in records[1]!) {
      assert.equal(records[1].hash, overrideRecord.hash);
      assert.equal(records[1].override.targetHash, denyRecord.hash);
    }
  });

  test('soft-fails: skips a malformed/schema-invalid line rather than throwing', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    sink.append(verdict(), now);
    const good = sink.append(verdict(), now);

    const filePath = path.join(dir, '2026-08-12.jsonl');
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    lines[0] = '{"not":"a valid chain record"}';
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

    const records = readChainRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.hash, good.hash);
  });
});
