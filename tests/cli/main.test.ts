import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMain } from '../../src/cli/main.ts';
import type { MainIO } from '../../src/cli/main.ts';
import { FsAppendAuditSink } from '../../src/audit/fs-append-sink.ts';
import { CalibrationCorpus } from '../../src/calibration/corpus.ts';
import type { Verdict } from '../../src/gating/verdict.ts';
import type { CalibrateIO } from '../../src/cli/calibrate.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capturingIO(): { io: MainIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { write: (l) => out.push(l), error: (l) => err.push(l) }, out, err };
}

function scriptedCalibrateIO(confirmations: boolean[]): CalibrateIO {
  let confirmIndex = 0;
  const answers = ['test-tag', 'low', 'a scripted test exemplar narrative'];
  let askIndex = 0;
  return {
    async ask(): Promise<string> {
      const answer = answers[askIndex] ?? 'unused';
      askIndex += 1;
      return answer;
    },
    async confirm(): Promise<boolean> {
      const v = confirmations[confirmIndex] ?? false;
      confirmIndex += 1;
      return v;
    },
    write(): void {},
  };
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

function fixedEvaluator(name: Vote['evaluator'], vote: Vote['vote']): EvaluatorPort {
  return {
    name,
    async castVote(): Promise<Vote> {
      return { evaluator: name, vote, rationale: `${name}-${vote}` };
    },
  };
}

describe('runMain — usage / unknown commands', () => {
  test('no arguments prints usage and returns 1', async () => {
    const { io, err } = capturingIO();
    const code = await runMain([], { io });
    assert.equal(code, 1);
    assert.ok(err.some((l) => l.toLowerCase().includes('usage')));
  });

  test('an unknown top-level command returns 1', async () => {
    const { io, err } = capturingIO();
    const code = await runMain(['bogus'], { io });
    assert.equal(code, 1);
    assert.ok(err.length > 0);
  });

  test('an unknown calibrate subcommand returns 1', async () => {
    const { io } = capturingIO();
    const code = await runMain(['calibrate', 'bogus'], { io });
    assert.equal(code, 1);
  });

  test('an unknown audit subcommand returns 1', async () => {
    const { io } = capturingIO();
    const code = await runMain(['audit', 'bogus'], { io });
    assert.equal(code, 1);
  });
});

describe('runMain — audit verify', () => {
  test('a valid chain reports success and returns 0', async () => {
    const dir = tmpDir('magi-main-audit-verify-ok-');
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict(), new Date('2026-08-12T10:00:00.000Z'));

    const { io, out } = capturingIO();
    const code = await runMain(['audit', 'verify'], { io, auditDir: dir });
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.toLowerCase().includes('valid')));
  });

  test('a tampered chain reports failure and returns 1', async () => {
    const dir = tmpDir('magi-main-audit-verify-bad-');
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict(), new Date('2026-08-12T10:00:00.000Z'));
    const filePath = path.join(dir, '2026-08-12.jsonl');
    fs.chmodSync(filePath, 0o644);
    const original = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    original.action = 'tampered';
    fs.writeFileSync(filePath, `${JSON.stringify(original)}\n`);

    const { io, err } = capturingIO();
    const code = await runMain(['audit', 'verify'], { io, auditDir: dir });
    assert.equal(code, 1);
    assert.ok(err.length > 0);
  });
});

describe('runMain — audit stats', () => {
  test('prints the formatted stats and returns 0', async () => {
    const dir = tmpDir('magi-main-audit-stats-');
    const sink = new FsAppendAuditSink(dir);
    sink.append(verdict({ decision: 'allow' }), new Date('2026-08-12T10:00:00.000Z'));
    sink.append(verdict({ decision: 'deny' }), new Date('2026-08-12T10:05:00.000Z'));

    const { io, out } = capturingIO();
    const code = await runMain(['audit', 'stats'], { io, auditDir: dir });
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.includes('Total gated records: 2')));
  });
});

describe('runMain — calibrate (interview)', () => {
  test('a confirmed interview adds exactly one entry to the injected corpus', async () => {
    const dir = tmpDir('magi-main-calibrate-');
    const corpus = new CalibrationCorpus(dir);
    const { io } = capturingIO();

    const code = await runMain(['calibrate'], { io, corpus, calibrateIO: scriptedCalibrateIO([true]) });
    assert.equal(code, 0);
    assert.equal(corpus.list().length, 1);
  });
});

describe('runMain — calibrate import', () => {
  test('missing file argument returns 1 with a usage message', async () => {
    const { io, err } = capturingIO();
    const code = await runMain(['calibrate', 'import'], { io });
    assert.equal(code, 1);
    assert.ok(err.some((l) => l.toLowerCase().includes('usage')));
  });

  test('imports confirmed candidates from a JSON file into the injected corpus', async () => {
    const corpusDir = tmpDir('magi-main-calibrate-import-corpus-');
    const filesDir = tmpDir('magi-main-calibrate-import-files-');
    const corpus = new CalibrationCorpus(corpusDir);
    const candidatesFile = path.join(filesDir, 'candidates.json');
    fs.writeFileSync(
      candidatesFile,
      JSON.stringify([
        { tag: 'a', severity: 'low', exemplar: 'exemplar-a' },
        { tag: 'b', severity: 'medium', exemplar: 'exemplar-b' },
      ]),
    );

    const { io } = capturingIO();
    const code = await runMain(['calibrate', 'import', candidatesFile], {
      io,
      corpus,
      calibrateIO: scriptedCalibrateIO([true, true]),
    });
    assert.equal(code, 0);
    assert.equal(corpus.list().length, 2);
  });
});

describe('runMain — calibrate verify', () => {
  test('missing --fixtures returns 1 with a usage message', async () => {
    const { io, err } = capturingIO();
    const code = await runMain(['calibrate', 'verify'], { io });
    assert.equal(code, 1);
    assert.ok(err.some((l) => l.toLowerCase().includes('usage')));
  });

  test('a passing harness run against a fixtures file returns 0', async () => {
    const dir = tmpDir('magi-main-calibrate-verify-');
    const fixturesFile = path.join(dir, 'fixtures.json');
    fs.writeFileSync(
      fixturesFile,
      JSON.stringify([
        {
          id: 'divergent-1',
          kind: 'divergent',
          severity: 'critical',
          action: {
            source: 'coding_agent',
            actor: 'test',
            actionType: 'shell_exec',
            target: 'repo',
            environment: 'local',
            mode: 'shadow',
            command: 'git push --force origin main',
          },
        },
      ]),
    );

    const { io } = capturingIO();
    const code = await runMain(['calibrate', 'verify', '--fixtures', fixturesFile], {
      io,
      evaluators: [fixedEvaluator('melchior', 'allow'), fixedEvaluator('balthasar', 'deny'), fixedEvaluator('casper', 'allow')],
    });
    assert.equal(code, 0);
  });
});
