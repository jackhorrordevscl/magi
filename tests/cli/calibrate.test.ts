import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCalibrateInterview, runCalibrateImport, runCalibrateVerify } from '../../src/cli/calibrate.ts';
import type { CalibrateIO } from '../../src/cli/calibrate.ts';
import { CalibrationCorpus } from '../../src/calibration/corpus.ts';
import type { DivergenceFixture } from '../../src/calibration/divergence-harness.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-cli-calibrate-'));
}

function scriptedIO(answers: string[], confirmations: boolean[]): { io: CalibrateIO; lines: string[] } {
  const lines: string[] = [];
  let askIndex = 0;
  let confirmIndex = 0;
  const io: CalibrateIO = {
    async ask(): Promise<string> {
      const answer = answers[askIndex];
      askIndex += 1;
      return answer ?? '';
    },
    async confirm(): Promise<boolean> {
      const confirmation = confirmations[confirmIndex];
      confirmIndex += 1;
      return confirmation ?? false;
    },
    write(line: string): void {
      lines.push(line);
    },
  };
  return { io, lines };
}

describe('runCalibrateInterview — never auto-labeled, human must confirm', () => {
  test('confirmed interview writes exactly one entry to the corpus', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const { io } = scriptedIO(
      ['force-push-protected-branch', 'critical', 'Force-pushing to main destroys shared history.'],
      [true],
    );

    const entry = await runCalibrateInterview({ corpus, io, now: new Date('2026-08-12T10:00:00.000Z') });

    assert.ok(entry);
    assert.equal(entry?.tag, 'force-push-protected-branch');
    assert.equal(entry?.severity, 'critical');
    assert.equal(corpus.list().length, 1);
  });

  test('declining confirmation writes nothing to the corpus', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const { io } = scriptedIO(['some-tag', 'low', 'some narrative'], [false]);

    const entry = await runCalibrateInterview({ corpus, io, now: new Date('2026-08-12T10:00:00.000Z') });

    assert.equal(entry, null);
    assert.equal(corpus.list().length, 0);
  });

  test('an invalid severity aborts the interview without writing anything', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const { io, lines } = scriptedIO(['some-tag', 'catastrophic', 'some narrative'], [true]);

    const entry = await runCalibrateInterview({ corpus, io, now: new Date('2026-08-12T10:00:00.000Z') });

    assert.equal(entry, null);
    assert.equal(corpus.list().length, 0);
    assert.ok(lines.some((l) => l.includes('Invalid severity')));
  });
});

describe('runCalibrateImport — per-entry human confirmation required', () => {
  test('only confirmed candidates are added; declined ones are skipped', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const { io } = scriptedIO([], [true, false, true]);

    const added = await runCalibrateImport({
      candidates: [
        { tag: 'a', severity: 'low', exemplar: 'exemplar-a' },
        { tag: 'b', severity: 'medium', exemplar: 'exemplar-b' },
        { tag: 'c', severity: 'high', exemplar: 'exemplar-c' },
      ],
      corpus,
      io,
      now: new Date('2026-08-12T10:00:00.000Z'),
    });

    assert.equal(added.length, 2);
    assert.deepEqual(
      added.map((e) => e.tag),
      ['a', 'c'],
    );
    assert.equal(corpus.list().length, 2);
  });

  test('a candidate already present (identical content) is skipped without prompting', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const now = new Date('2026-08-12T10:00:00.000Z');
    corpus.add({ tag: 'dup', severity: 'low', exemplar: 'already here' }, now);

    const { io } = scriptedIO([], []); // no confirm() calls expected for the duplicate
    const added = await runCalibrateImport({
      candidates: [{ tag: 'dup', severity: 'low', exemplar: 'already here' }],
      corpus,
      io,
      now,
    });

    assert.equal(added.length, 0);
    assert.equal(corpus.list().length, 1);
  });

  test('an empty candidate list adds nothing and never calls confirm', async () => {
    const dir = tmpDir();
    const corpus = new CalibrationCorpus(dir);
    const { io } = scriptedIO([], []);
    const added = await runCalibrateImport({ candidates: [], corpus, io, now: new Date() });
    assert.deepEqual(added, []);
  });
});

describe('runCalibrateVerify — wraps the divergence harness with a printed summary', () => {
  function action(command: string): CodingAgentAction {
    return {
      source: 'coding_agent',
      actor: 'test-agent',
      actionType: 'shell_exec',
      target: 'repo',
      environment: 'local',
      mode: 'shadow',
      command,
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

  test('a passing harness run reports PASS and returns report.pass = true', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'deny'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'divergent-1', kind: 'divergent', action: action('git push --force origin main'), severity: 'critical' },
    ];
    const lines: string[] = [];

    const report = await runCalibrateVerify({
      evaluators,
      fixtures,
      divergenceFloorPercent: 40,
      write: (line) => lines.push(line),
    });

    assert.equal(report.pass, true);
    assert.ok(lines.some((l) => l === 'PASS'));
  });

  test('a failing harness run reports FAIL and returns report.pass = false', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'divergent-1', kind: 'divergent', action: action('git push --force origin main'), severity: 'critical' },
    ];
    const lines: string[] = [];

    const report = await runCalibrateVerify({
      evaluators,
      fixtures,
      divergenceFloorPercent: 40,
      write: (line) => lines.push(line),
    });

    assert.equal(report.pass, false);
    assert.ok(lines.some((l) => l === 'FAIL'));
  });

  test('write is optional — omitting it does not throw', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const report = await runCalibrateVerify({ evaluators, fixtures: [], divergenceFloorPercent: 40 });
    assert.equal(report.pass, true);
  });
});
