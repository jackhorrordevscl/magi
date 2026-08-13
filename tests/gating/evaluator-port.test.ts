import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectVotes } from '../../src/gating/evaluator-port.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

function action(): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git status',
  };
}

function fakeEvaluator(
  name: Vote['evaluator'],
  behavior:
    | { kind: 'resolve'; vote: Vote['vote'] }
    | { kind: 'reject'; reason: unknown }
    | { kind: 'delay'; ms: number; vote: Vote['vote'] },
): EvaluatorPort {
  return {
    name,
    async castVote(): Promise<Vote> {
      if (behavior.kind === 'resolve') {
        return { evaluator: name, vote: behavior.vote, rationale: `${name}-rationale` };
      }
      if (behavior.kind === 'reject') {
        throw behavior.reason;
      }
      await new Promise((resolve) => setTimeout(resolve, behavior.ms));
      return { evaluator: name, vote: behavior.vote, rationale: `${name}-rationale` };
    },
  };
}

describe('collectVotes — Promise.allSettled dispatch across all 3 evaluators', () => {
  test('all three fulfilled -> returns their votes in evaluator order', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fakeEvaluator('melchior', { kind: 'resolve', vote: 'allow' }),
      fakeEvaluator('balthasar', { kind: 'resolve', vote: 'deny' }),
      fakeEvaluator('casper', { kind: 'resolve', vote: 'abstain' }),
    ];

    const votes = await collectVotes(evaluators, action(), 'low');

    assert.equal(votes.length, 3);
    assert.equal(votes[0]?.evaluator, 'melchior');
    assert.equal(votes[0]?.vote, 'allow');
    assert.equal(votes[1]?.evaluator, 'balthasar');
    assert.equal(votes[1]?.vote, 'deny');
    assert.equal(votes[2]?.evaluator, 'casper');
    assert.equal(votes[2]?.vote, 'abstain');
  });

  test('a rejected evaluator promise is substituted with a deny vote, at its own slot only', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fakeEvaluator('melchior', { kind: 'resolve', vote: 'allow' }),
      fakeEvaluator('balthasar', { kind: 'reject', reason: new Error('boom') }),
      fakeEvaluator('casper', { kind: 'resolve', vote: 'allow' }),
    ];

    const votes = await collectVotes(evaluators, action(), 'high');

    assert.equal(votes[0]?.vote, 'allow');
    assert.equal(votes[1]?.evaluator, 'balthasar');
    assert.equal(votes[1]?.vote, 'deny');
    assert.match(votes[1]?.rationale ?? '', /fail-closed/);
    assert.equal(votes[2]?.vote, 'allow');
  });

  test('a non-Error rejection reason is still captured in the substituted deny rationale', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fakeEvaluator('melchior', { kind: 'reject', reason: 'plain string reason' }),
      fakeEvaluator('balthasar', { kind: 'resolve', vote: 'allow' }),
      fakeEvaluator('casper', { kind: 'resolve', vote: 'allow' }),
    ];

    const votes = await collectVotes(evaluators, action(), 'low');
    assert.equal(votes[0]?.vote, 'deny');
    assert.match(votes[0]?.rationale ?? '', /plain string reason/);
  });

  test('all three evaluators are dispatched concurrently, not sequentially', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fakeEvaluator('melchior', { kind: 'delay', ms: 40, vote: 'allow' }),
      fakeEvaluator('balthasar', { kind: 'delay', ms: 40, vote: 'allow' }),
      fakeEvaluator('casper', { kind: 'delay', ms: 40, vote: 'allow' }),
    ];

    const start = Date.now();
    await collectVotes(evaluators, action(), 'low');
    const elapsed = Date.now() - start;

    // Sequential dispatch would take >=120ms; parallel dispatch should stay
    // well under that even with scheduler jitter.
    assert.ok(elapsed < 100, `expected concurrent dispatch (<100ms), took ${elapsed}ms`);
  });

  test('all three evaluators reject -> all three votes are deny', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fakeEvaluator('melchior', { kind: 'reject', reason: new Error('a') }),
      fakeEvaluator('balthasar', { kind: 'reject', reason: new Error('b') }),
      fakeEvaluator('casper', { kind: 'reject', reason: new Error('c') }),
    ];

    const votes = await collectVotes(evaluators, action(), 'critical');
    assert.ok(votes.every((v) => v.vote === 'deny'));
  });
});
