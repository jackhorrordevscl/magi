import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assembleVerdict, VerdictSchema } from '../../src/gating/verdict.ts';
import type { Vote, VoteDecision } from '../../src/gating/consensus.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';
import type { ExemplarSelection } from '../../src/calibration/exemplar-injection.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

function action(overrides: Partial<CodingAgentAction> = {}): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git push --force origin main',
    ...overrides,
  };
}

function votes(decisions: [VoteDecision, VoteDecision, VoteDecision]): [Vote, Vote, Vote] {
  const evaluators = ['melchior', 'balthasar', 'casper'] as const;
  return [
    { evaluator: evaluators[0], vote: decisions[0], rationale: 'rationale-1' },
    { evaluator: evaluators[1], vote: decisions[1], rationale: 'rationale-2' },
    { evaluator: evaluators[2], vote: decisions[2], rationale: 'rationale-3' },
  ];
}

describe('assembleVerdict — combines severity classification + consensus resolution', () => {
  test('unanimous allow at high severity -> decision allow, carries severity/votes through', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const verdict = assembleVerdict(a, 'high', v);

    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.severity, 'high');
    assert.deepEqual(verdict.votes, v);
    assert.equal(verdict.actor, a.actor);
    assert.equal(verdict.mode, a.mode);
    assert.equal(verdict.action, a.command);
  });

  test('2-of-3 allow at high severity is NOT unanimous -> decision deny', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'deny']);
    const verdict = assembleVerdict(a, 'high', v);
    assert.equal(verdict.decision, 'deny');
  });

  test('2-of-3 allow at low severity meets quorum -> decision allow', () => {
    const a = action({ command: 'git status' });
    const v = votes(['allow', 'allow', 'abstain']);
    const verdict = assembleVerdict(a, 'low', v);
    assert.equal(verdict.decision, 'allow');
  });

  test('critical severity requires unanimity same as high', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'abstain']);
    const verdict = assembleVerdict(a, 'critical', v);
    assert.equal(verdict.decision, 'deny');
  });

  test('the existing 3-arg call (no selection) still defaults calibrationCorpusHash/exemplarIds to the empty placeholders', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const verdict = assembleVerdict(a, 'medium', v);
    assert.equal(verdict.calibrationCorpusHash, '');
    assert.deepEqual(verdict.exemplarIds, []);
  });

  test('verdict shape validates against VerdictSchema (subset of AuditRecordSchema)', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const verdict = assembleVerdict(a, 'critical', v);
    assert.doesNotThrow(() => VerdictSchema.parse(verdict));
  });

  test('infra_pipeline source produces a verdict too (uses pipelineId as the action descriptor)', () => {
    const infraAction = {
      source: 'infra_pipeline' as const,
      actor: 'ci-bot',
      actionType: 'pipeline_step',
      target: 'repo',
      environment: 'ci',
      mode: 'shadow' as const,
      pipelineId: 'build-42',
    };
    const v = votes(['allow', 'allow', 'allow']);
    const verdict = assembleVerdict(infraAction, 'low', v);
    assert.equal(verdict.action, 'build-42');
    assert.equal(verdict.decision, 'allow');
  });
});

function calibrationEntry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('assembleVerdict — 4th param populates real calibration audit fields (additive, default-backed)', () => {
  test('a populated corpus produces a real calibrationCorpusHash and exemplarIds equal to the retrieved exemplars\' contentHash[]', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const selection: ExemplarSelection = {
      exemplars: [calibrationEntry({ contentHash: 'a'.repeat(64) }), calibrationEntry({ contentHash: 'b'.repeat(64) })],
      corpusHash: 'c'.repeat(64),
    };

    const verdict = assembleVerdict(a, 'high', v, selection);

    assert.equal(verdict.calibrationCorpusHash, 'c'.repeat(64));
    assert.deepEqual(verdict.exemplarIds, ['a'.repeat(64), 'b'.repeat(64)]);
  });

  test('an empty selection still produces a real (non-"") empty-snapshot hash when the caller supplies one', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const selection: ExemplarSelection = { exemplars: [], corpusHash: 'd'.repeat(64) };

    const verdict = assembleVerdict(a, 'low', v, selection);

    assert.equal(verdict.calibrationCorpusHash, 'd'.repeat(64));
    assert.deepEqual(verdict.exemplarIds, []);
  });

  test('a genuinely empty corpus (selection with corpusHash "") produces "" and an empty exemplarIds array, not a placeholder bug', () => {
    const a = action();
    const v = votes(['allow', 'allow', 'allow']);
    const selection: ExemplarSelection = { exemplars: [], corpusHash: '' };

    const verdict = assembleVerdict(a, 'low', v, selection);

    assert.equal(verdict.calibrationCorpusHash, '');
    assert.deepEqual(verdict.exemplarIds, []);
  });
});
