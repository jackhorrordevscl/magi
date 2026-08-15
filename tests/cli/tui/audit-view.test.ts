import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditSummary, deniedRecords, deniedRecordsFooter } from '../../../src/cli/tui/audit-view.ts';
import { computeAuditStats, formatAuditStats } from '../../../src/cli/audit-stats.ts';
import { FsAppendAuditSink } from '../../../src/audit/fs-append-sink.ts';
import type { Verdict } from '../../../src/gating/verdict.ts';

// --- Fixtures ---------------------------------------------------------

function tmpAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-tui-audit-view-'));
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

function snapshotDir(dir: string): { entries: string[]; mtimes: Record<string, number> } {
  const entries = fs.readdirSync(dir).sort();
  const mtimes: Record<string, number> = {};
  for (const entry of entries) {
    mtimes[entry] = fs.statSync(path.join(dir, entry)).mtimeMs;
  }
  return { entries, mtimes };
}

// --- auditSummary — matches computeAuditStats/formatAuditStats exactly ----

describe('auditSummary — reuses existing aggregation, no new logic', () => {
  test('an empty/nonexistent audit dir produces the same stats/lines computeAuditStats/formatAuditStats would', () => {
    const dir = path.join(os.tmpdir(), 'magi-tui-audit-view-does-not-exist');
    const view = auditSummary(dir);
    assert.deepEqual(view.stats, computeAuditStats(dir));
    assert.deepEqual(view.lines, formatAuditStats(computeAuditStats(dir)));
  });

  test('matches CLI output for a populated audit dir (spec: "Summary panel matches CLI output")', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-14T10:00:00.000Z');

    sink.append(verdict({ severity: 'low', decision: 'allow' }), now);
    sink.append(verdict({ severity: 'high', decision: 'deny' }), now);
    sink.append(verdict({ severity: 'critical', decision: 'deny' }), now);

    const view = auditSummary(dir);
    const cliStats = computeAuditStats(dir);

    assert.deepEqual(view.stats, cliStats);
    assert.deepEqual(view.lines, formatAuditStats(cliStats));
    assert.equal(view.stats.totalRecords, 3);
    assert.equal(view.stats.byDecision.deny, 2);
  });
});

// --- deniedRecords — deny-only, newest-first, overrides excluded ----------

describe('deniedRecords — verdict deny records only, newest-first, override records excluded', () => {
  test('a fixture chain with allow/deny/override records surfaces only deny verdicts, newest-first', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-14T10:00:00.000Z');

    sink.append(verdict({ decision: 'allow' }), now);
    const deny1 = sink.append(verdict({ decision: 'deny', severity: 'medium' }), now);
    const deny2 = sink.append(verdict({ decision: 'deny', severity: 'high' }), now);
    sink.appendOverride(
      { targetHash: deny1.hash, targetSeq: deny1.seq, actor: 'operator', reason: 'verified manually' },
      now,
    );

    const view = deniedRecords(dir);

    assert.equal(view.totalDenied, 2);
    assert.equal(view.truncated, false);
    assert.equal(view.rows.length, 2);

    // newest-first: deny2 was appended after deny1.
    assert.equal(view.rows[0]?.hash, deny2.hash);
    assert.equal(view.rows[0]?.seq, deny2.seq);
    assert.equal(view.rows[0]?.severity, 'high');
    assert.equal(view.rows[1]?.hash, deny1.hash);
    assert.equal(view.rows[1]?.severity, 'medium');

    for (const row of view.rows) {
      assert.equal(typeof row.hash, 'string');
      assert.equal(typeof row.seq, 'number');
      assert.equal(typeof row.timestamp, 'string');
      assert.equal(typeof row.severity, 'string');
    }
  });

  test('allow-decision records do not appear in the denied list', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-14T10:00:00.000Z');
    sink.append(verdict({ decision: 'allow' }), now);
    sink.append(verdict({ decision: 'allow' }), now);

    const view = deniedRecords(dir);
    assert.equal(view.totalDenied, 0);
    assert.deepEqual(view.rows, []);
  });

  test('an empty/nonexistent audit dir returns an empty, non-truncated view', () => {
    const dir = path.join(os.tmpdir(), 'magi-tui-audit-view-denied-does-not-exist');
    const view = deniedRecords(dir);
    assert.deepEqual(view, { rows: [], totalDenied: 0, truncated: false });
    assert.equal(deniedRecordsFooter(view), undefined);
  });

  test('500-row cap: an oversized fixture truncates rendered rows and the footer names the true total', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-14T10:00:00.000Z');

    const total = 510;
    for (let i = 0; i < total; i++) {
      sink.append(verdict({ decision: 'deny' }), now);
    }

    const view = deniedRecords(dir);
    assert.equal(view.totalDenied, total);
    assert.equal(view.rows.length, 500);
    assert.equal(view.truncated, true);
    assert.equal(deniedRecordsFooter(view), `showing newest 500 of ${total}`);
  });

  test('viewing denied records writes nothing under the audit dir (spec: "Viewing denied records writes nothing")', () => {
    const dir = tmpAuditDir();
    const sink = new FsAppendAuditSink(dir);
    const now = new Date('2026-08-14T10:00:00.000Z');
    sink.append(verdict({ decision: 'deny' }), now);
    sink.append(verdict({ decision: 'allow' }), now);

    const before = snapshotDir(dir);

    // "Scroll through several records" — call the read path repeatedly.
    deniedRecords(dir);
    deniedRecords(dir);
    deniedRecords(dir);

    const after = snapshotDir(dir);
    assert.deepEqual(after, before);
  });
});
