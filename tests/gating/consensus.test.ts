import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConsensus } from '../../src/gating/consensus.ts';
import type { Vote, VoteDecision, Evaluator } from '../../src/gating/consensus.ts';
import type { SeverityTier } from '../../src/gating/proposed-action.ts';

const EVALUATORS: Evaluator[] = ['melchior', 'balthasar', 'casper'];
const DECISIONS: VoteDecision[] = ['allow', 'deny', 'abstain'];
const TIERS: SeverityTier[] = ['low', 'medium', 'high', 'critical'];

function vote(evaluator: Evaluator, decision: VoteDecision): Vote {
  return { evaluator, vote: decision, rationale: `${evaluator}-${decision}-test-rationale` };
}

/**
 * Independent reference implementation of the quorum rule under test —
 * deliberately NOT calling resolveConsensus, so this actually proves
 * something rather than asserting the implementation against itself.
 *
 * Rule: Low/Medium requires at least 2-of-3 `allow` votes. High/Critical
 * requires unanimous 3-of-3 `allow`. `abstain` never counts toward allow,
 * in any tier, at any count.
 */
function expectedDecision(decisions: VoteDecision[], tier: SeverityTier): 'allow' | 'deny' {
  const allowCount = decisions.filter((d) => d === 'allow').length;
  const requiredAllow = tier === 'high' || tier === 'critical' ? 3 : 2;
  return allowCount >= requiredAllow ? 'allow' : 'deny';
}

describe('resolveConsensus — full quorum matrix (27 vote combinations x 4 severity tiers)', () => {
  for (const d0 of DECISIONS) {
    for (const d1 of DECISIONS) {
      for (const d2 of DECISIONS) {
        const decisions: VoteDecision[] = [d0, d1, d2];
        const votes: Vote[] = decisions.map((d, i) => vote(EVALUATORS[i] as Evaluator, d));

        for (const tier of TIERS) {
          const expected = expectedDecision(decisions, tier);
          test(`[${decisions.join(',')}] @ ${tier} -> ${expected}`, () => {
            assert.equal(resolveConsensus(votes, tier), expected);
          });
        }
      }
    }
  }
});

describe('resolveConsensus — abstain never counts as allow (explicit spot checks)', () => {
  test('low tier: 1 allow + 2 abstain -> deny (below 2-of-3)', () => {
    const votes = [vote('melchior', 'allow'), vote('balthasar', 'abstain'), vote('casper', 'abstain')];
    assert.equal(resolveConsensus(votes, 'low'), 'deny');
  });

  test('medium tier: 2 allow + 1 abstain -> allow (2-of-3 met, abstain irrelevant beyond that)', () => {
    const votes = [vote('melchior', 'allow'), vote('balthasar', 'allow'), vote('casper', 'abstain')];
    assert.equal(resolveConsensus(votes, 'medium'), 'allow');
  });

  test('critical tier: 2 allow + 1 abstain -> deny (unanimity required; abstain blocks it)', () => {
    const votes = [vote('melchior', 'allow'), vote('balthasar', 'allow'), vote('casper', 'abstain')];
    assert.equal(resolveConsensus(votes, 'critical'), 'deny');
  });

  test('high tier: 3-of-3 allow -> allow (true unanimity)', () => {
    const votes = [vote('melchior', 'allow'), vote('balthasar', 'allow'), vote('casper', 'allow')];
    assert.equal(resolveConsensus(votes, 'high'), 'allow');
  });

  test('critical tier: 3-of-3 abstain -> deny', () => {
    const votes = [vote('melchior', 'abstain'), vote('balthasar', 'abstain'), vote('casper', 'abstain')];
    assert.equal(resolveConsensus(votes, 'critical'), 'deny');
  });
});
