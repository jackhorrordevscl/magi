import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeAuditStats, formatAuditStats } from '../../src/cli/audit-stats.ts';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import type { Verdict } from '../../src/gating/verdict.ts';

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-audit-stats-'));
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

describe('computeAuditStats — verdict distribution + deny-rate proxy', () => {
  test('an empty/nonexistent audit dir produces all-zero stats without throwing', () => {
    const dir = path.join(os.tmpdir(), 'magi-audit-stats-does-not-exist');
    const stats = computeAuditStats(dir);
    assert.equal(stats.totalRecords, 0);
    assert.equal(stats.byDecision.allow, 0);
    assert.equal(stats.byDecision.deny, 0);
    assert.equal(stats.denyRateProxy, 0);
  });

  test('aggregates counts per decision and per severity tier across multiple records', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');

    sink.append(verdict({ severity: 'low', decision: 'allow' }), now);
    sink.append(verdict({ severity: 'high', decision: 'deny' }), now);
    sink.append(verdict({ severity: 'critical', decision: 'deny' }), now);
    sink.append(verdict({ severity: 'medium', decision: 'allow' }), now);

    const stats = computeAuditStats(dir);

    assert.equal(stats.totalRecords, 4);
    assert.equal(stats.byDecision.allow, 2);
    assert.equal(stats.byDecision.deny, 2);
    assert.equal(stats.bySeverity.low, 1);
    assert.equal(stats.bySeverity.medium, 1);
    assert.equal(stats.bySeverity.high, 1);
    assert.equal(stats.bySeverity.critical, 1);
    assert.equal(stats.denyRateProxy, 0.5);
  });

  test('reads across multiple day-partitioned files', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict({ decision: 'allow' }), new Date('2026-08-12T23:59:00.000Z'));
    sink.append(verdict({ decision: 'deny' }), new Date('2026-08-13T00:05:00.000Z'));

    const stats = computeAuditStats(dir);
    assert.equal(stats.totalRecords, 2);
  });
});

describe('formatAuditStats — human-readable rendering', () => {
  test('renders total, decision counts, severity counts, and the deny-rate proxy caveat', () => {
    const stats = computeAuditStats(path.join(os.tmpdir(), 'magi-audit-stats-does-not-exist-2'));
    const lines = formatAuditStats(stats);
    assert.ok(lines.some((l) => l.includes('Total gated records: 0')));
    assert.ok(lines.some((l) => l.includes('allow') && l.includes('deny')));
    assert.ok(lines.some((l) => l.toLowerCase().includes('proxy')));
  });

  test('renders an overrides line', () => {
    const stats = computeAuditStats(path.join(os.tmpdir(), 'magi-audit-stats-does-not-exist-3'));
    const lines = formatAuditStats(stats);
    assert.ok(lines.some((l) => l.toLowerCase().includes('override')));
  });
});

describe('computeAuditStats — override accounting (design decision #8)', () => {
  test('5 denies + 2 overrides: byDecision.deny stays 5, overrideCount is 2, denyRateProxy excludes overrides', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');

    const denies = [];
    for (let i = 0; i < 5; i++) denies.push(sink.append(verdict({ decision: 'deny' }), now));
    sink.append(verdict({ decision: 'allow' }), now);
    sink.append(verdict({ decision: 'allow' }), now);

    sink.appendOverride(
      { targetHash: denies[0]!.hash, targetSeq: denies[0]!.seq, actor: 'operator', reason: 'verified manually' },
      now,
    );
    sink.appendOverride(
      { targetHash: denies[1]!.hash, targetSeq: denies[1]!.seq, actor: 'operator', reason: 'verified manually' },
      now,
    );

    const stats = computeAuditStats(dir);

    // 5 deny + 2 allow verdict records = 7. The 2 override records are
    // excluded from totalRecords/byDecision entirely — a separate metric.
    assert.equal(stats.totalRecords, 7);
    assert.equal(stats.byDecision.deny, 5);
    assert.equal(stats.byDecision.allow, 2);
    assert.equal(stats.overrideCount, 2);
    assert.equal(stats.overrideRate, 2 / 5);
    assert.equal(stats.denyRateProxy, 5 / 7);
  });

  test('overriding a deny never reclassifies it out of byDecision.deny', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-13T10:00:00.000Z');

    const denied = sink.append(verdict({ decision: 'deny' }), now);
    sink.appendOverride(
      { targetHash: denied.hash, targetSeq: denied.seq, actor: 'operator', reason: 'ok' },
      now,
    );

    const stats = computeAuditStats(dir);
    assert.equal(stats.byDecision.deny, 1);
    assert.equal(stats.overrideCount, 1);
  });

  test('no denies yet: overrideRate is 0 rather than dividing by zero', () => {
    const dir = tmpAuditDir();
    const stats = computeAuditStats(dir);
    assert.equal(stats.overrideRate, 0);
  });
});
