import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAuditOverride } from '../../src/cli/audit-override.ts';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import type { Verdict } from '../../src/gating/verdict.ts';

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-audit-override-'));
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    actor: 'test-agent',
    mode: 'enforced',
    action: 'git push --force origin main',
    severity: 'high',
    votes: [
      { evaluator: 'melchior', vote: 'deny', rationale: 'force-push to main' },
      { evaluator: 'balthasar', vote: 'deny', rationale: 'blast radius to shared history' },
      { evaluator: 'casper', vote: 'deny', rationale: 'unusual for this actor' },
    ],
    decision: 'deny',
    calibrationCorpusHash: '',
    exemplarIds: [],
    ...overrides,
  };
}

function readBytes(filePath: string): Buffer | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

describe('runAuditOverride — rejection paths write nothing (byte-identical file + HEAD)', () => {
  test('unknown hash: rejects, and does not touch the day file or HEAD', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    sink.append(verdict(), now);

    const dayFile = path.join(dir, '2026-08-13.jsonl');
    const headFile = path.join(dir, 'HEAD');
    const beforeDay = readBytes(dayFile);
    const beforeHead = readBytes(headFile);

    const result = runAuditOverride({ auditDir: dir, targetHash: 'doesnotexist', reason: 'operator verified' });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.record, undefined);
    assert.deepEqual(readBytes(dayFile), beforeDay);
    assert.deepEqual(readBytes(headFile), beforeHead);
  });

  test('missing reason: rejects, and does not touch the day file or HEAD', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const target = sink.append(verdict(), now);

    const dayFile = path.join(dir, '2026-08-13.jsonl');
    const headFile = path.join(dir, 'HEAD');
    const beforeDay = readBytes(dayFile);
    const beforeHead = readBytes(headFile);

    const result = runAuditOverride({
      auditDir: dir,
      targetHash: target.hash,
      reason: undefined as unknown as string,
    });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(readBytes(dayFile), beforeDay);
    assert.deepEqual(readBytes(headFile), beforeHead);
  });

  test('empty reason: rejects, and does not touch the day file or HEAD', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const target = sink.append(verdict(), now);

    const dayFile = path.join(dir, '2026-08-13.jsonl');
    const headFile = path.join(dir, 'HEAD');
    const beforeDay = readBytes(dayFile);
    const beforeHead = readBytes(headFile);

    const result = runAuditOverride({ auditDir: dir, targetHash: target.hash, reason: '' });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(readBytes(dayFile), beforeDay);
    assert.deepEqual(readBytes(headFile), beforeHead);
  });

  test('target decision "allow": rejects, and does not touch the day file or HEAD', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const target = sink.append(verdict({ decision: 'allow' }), now);

    const dayFile = path.join(dir, '2026-08-13.jsonl');
    const headFile = path.join(dir, 'HEAD');
    const beforeDay = readBytes(dayFile);
    const beforeHead = readBytes(headFile);

    const result = runAuditOverride({ auditDir: dir, targetHash: target.hash, reason: 'operator verified' });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(readBytes(dayFile), beforeDay);
    assert.deepEqual(readBytes(headFile), beforeHead);
  });
});

describe('runAuditOverride — success path', () => {
  test('a valid override on a deny record appends a chained override record referencing the target by hash', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const target = sink.append(verdict(), now);

    const result = runAuditOverride({
      auditDir: dir,
      targetHash: target.hash,
      reason: 'operator verified manually',
      now: new Date('2026-08-13T10:05:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.record?.override.targetHash, target.hash);
    assert.equal(result.record?.override.targetSeq, target.seq);
    assert.equal(result.record?.override.reason, 'operator verified manually');
    assert.equal(result.record?.prevHash, target.hash);
    assert.equal(result.record?.seq, target.seq + 1);
  });

  test('resolves the target by hash, not by seq/position', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    sink.append(verdict({ decision: 'allow' }), now); // seq 0, not the target
    const target = sink.append(verdict(), now); // seq 1, deny — the target

    const result = runAuditOverride({ auditDir: dir, targetHash: target.hash, reason: 'ok' });

    assert.equal(result.ok, true);
    assert.equal(result.record?.override.targetSeq, 1);
  });

  test('the original record is unchanged after a successful override (append-only, non-mutating)', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const target = sink.append(verdict(), now);

    const dayFile = path.join(dir, '2026-08-13.jsonl');
    const beforeLines = fs.readFileSync(dayFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);

    runAuditOverride({ auditDir: dir, targetHash: target.hash, reason: 'ok' });

    const afterLines = fs.readFileSync(dayFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    assert.equal(afterLines[0], beforeLines[0]);
    assert.equal(afterLines.length, beforeLines.length + 1);
  });
});
