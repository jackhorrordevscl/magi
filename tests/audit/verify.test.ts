import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import { verifyChain } from '../../src/audit/verify.ts';
import type { Verdict } from '../../src/gating/verdict.ts';

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-audit-verify-'));
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
    ...overrides,
  };
}

describe('verifyChain — untampered chain', () => {
  test('returns {valid: true} for a freshly written, untampered chain', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    for (let i = 0; i < 4; i++) sink.append(verdict(), now);

    assert.deepEqual(verifyChain(dir), { valid: true });
  });

  test('returns {valid: true} for an empty (never-written) audit dir', () => {
    const dir = tmpAuditDir();
    assert.deepEqual(verifyChain(dir), { valid: true });
  });

  test('returns {valid: true} for a chain spanning multiple day files', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict(), new Date('2026-08-12T23:59:00.000Z'));
    sink.append(verdict(), new Date('2026-08-13T00:05:00.000Z'));
    sink.append(verdict(), new Date('2026-08-13T01:00:00.000Z'));

    assert.deepEqual(verifyChain(dir), { valid: true });
  });
});

describe('verifyChain — tampered chain detection', () => {
  test('detects tampered record content (hash no longer matches recomputed content)', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    sink.append(verdict(), now);
    sink.append(verdict(), now);
    sink.append(verdict(), now);

    const filePath = path.join(dir, '2026-08-12.jsonl');
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const tampered = JSON.parse(lines[1] as string);
    tampered.action = 'git reset --hard'; // content mutated, hash left stale
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

    const result = verifyChain(dir);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 1);
  });

  test('detects a directly tampered hash value', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    sink.append(verdict(), now);
    sink.append(verdict(), now);

    const filePath = path.join(dir, '2026-08-12.jsonl');
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const tampered = JSON.parse(lines[0] as string);
    tampered.hash = 'deadbeef'.repeat(8);
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

    const result = verifyChain(dir);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 0);
  });

  test('detects a broken prevHash link even if the tampered record recomputes its own hash consistently', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    sink.append(verdict(), now);
    sink.append(verdict(), now);

    const filePath = path.join(dir, '2026-08-12.jsonl');
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const tampered = JSON.parse(lines[1] as string);
    tampered.prevHash = 'not-the-real-prev-hash';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

    const result = verifyChain(dir);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 1);
  });
});
