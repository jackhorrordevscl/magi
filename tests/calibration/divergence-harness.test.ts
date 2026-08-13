import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDivergenceHarness } from '../../src/calibration/divergence-harness.ts';
import type { DivergenceFixture } from '../../src/calibration/divergence-harness.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import type { Vote } from '../../src/gating/consensus.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

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

/** A fake evaluator that always votes the fixed decision it was constructed with. */
function fixedEvaluator(name: Vote['evaluator'], vote: Vote['vote']): EvaluatorPort {
  return {
    name,
    async castVote(): Promise<Vote> {
      return { evaluator: name, vote, rationale: `${name}-fixed-${vote}` };
    },
  };
}

/** A fake evaluator whose vote is chosen per-fixture by `decide(fixtureId)`. */
function perFixtureEvaluator(name: Vote['evaluator'], decide: (fixtureId: string) => Vote['vote']): EvaluatorPort {
  return {
    name,
    async castVote(action: CodingAgentAction): Promise<Vote> {
      return { evaluator: name, vote: decide(action.command), rationale: `${name}-decided` };
    },
  };
}

describe('runDivergenceHarness — designed-control fixtures must be unanimous', () => {
  test('three evaluators that always agree -> 100% control unanimity, harness passes controls', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'control-1', kind: 'control', action: action('git status'), severity: 'low' },
      { id: 'control-2', kind: 'control', action: action('cat README.md'), severity: 'low' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);

    assert.equal(report.controlFixturesUnanimityRate, 1);
    assert.equal(report.controlsAllUnanimous, true);
  });

  test('a control fixture where evaluators disagree fails the controlsAllUnanimous check', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'deny'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'control-1', kind: 'control', action: action('git status'), severity: 'low' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);
    assert.equal(report.controlsAllUnanimous, false);
    assert.equal(report.pass, false);
  });
});

describe('runDivergenceHarness — designed-divergent fixtures must diverge >= floor', () => {
  test('facets that genuinely disagree on every divergent fixture -> 100% divergence, meets the 40% floor', async () => {
    // melchior (fact/consistency) always allows; casper (actor risk) always denies on
    // this designed-divergent set; balthasar splits — every fixture is non-unanimous.
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'deny'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'divergent-1', kind: 'divergent', action: action('git push --force origin main'), severity: 'critical' },
      { id: 'divergent-2', kind: 'divergent', action: action('rm -rf build/'), severity: 'high' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);

    assert.equal(report.divergentFixturesDivergenceRate, 1);
    assert.equal(report.divergenceFloorMet, true);
  });

  test('facets that always agree, even on designed-divergent fixtures, fail the divergence floor (cosmetic-collapse detection)', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'divergent-1', kind: 'divergent', action: action('git push --force origin main'), severity: 'critical' },
      { id: 'divergent-2', kind: 'divergent', action: action('rm -rf build/'), severity: 'high' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);

    assert.equal(report.divergentFixturesDivergenceRate, 0);
    assert.equal(report.divergenceFloorMet, false);
    assert.equal(report.pass, false);
  });

  test('a mix meeting exactly the 40% floor (2 of 5 divergent) passes; just under it fails', async () => {
    const decisions: Record<string, Vote['vote']> = {
      d1: 'deny',
      d2: 'allow',
      d3: 'allow',
      d4: 'allow',
      d5: 'allow',
    };
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      perFixtureEvaluator('casper', (fixtureId) => decisions[fixtureId] ?? 'allow'),
    ];
    const fixtures: DivergenceFixture[] = ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => ({
      id,
      kind: 'divergent',
      action: action(id),
      severity: 'high',
    }));

    // only d1 is non-unanimous among 5 -> 20%, below the 40% floor.
    const belowFloor = await runDivergenceHarness(evaluators, fixtures, 40);
    assert.equal(belowFloor.divergentFixturesDivergenceRate, 0.2);
    assert.equal(belowFloor.divergenceFloorMet, false);

    // lowering the floor to 20% should now pass.
    const atFloor = await runDivergenceHarness(evaluators, fixtures, 20);
    assert.equal(atFloor.divergenceFloorMet, true);
  });

  test('overall pass requires BOTH the divergence floor met AND all controls unanimous', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'deny'),
      fixedEvaluator('casper', 'deny'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'divergent-1', kind: 'divergent', action: action('git push --force origin main'), severity: 'critical' },
      { id: 'control-1', kind: 'control', action: action('git status'), severity: 'low' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);
    // divergent fixture is non-unanimous (good), but control fixture is ALSO
    // non-unanimous (bad, since these fixed evaluators never agree at all) -> overall fail.
    assert.equal(report.divergenceFloorMet, true);
    assert.equal(report.controlsAllUnanimous, false);
    assert.equal(report.pass, false);
  });
});

describe('runDivergenceHarness — result detail', () => {
  test('report.results carries one entry per fixture with its votes and unanimity', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const fixtures: DivergenceFixture[] = [
      { id: 'control-1', kind: 'control', action: action('git status'), severity: 'low' },
    ];

    const report = await runDivergenceHarness(evaluators, fixtures, 40);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.fixtureId, 'control-1');
    assert.equal(report.results[0]?.unanimous, true);
    assert.equal(report.results[0]?.votes.length, 3);
  });

  test('an empty fixture set trivially meets both checks (0/0 -> vacuously true) and passes', async () => {
    const evaluators: [EvaluatorPort, EvaluatorPort, EvaluatorPort] = [
      fixedEvaluator('melchior', 'allow'),
      fixedEvaluator('balthasar', 'allow'),
      fixedEvaluator('casper', 'allow'),
    ];
    const report = await runDivergenceHarness(evaluators, [], 40);
    assert.equal(report.divergenceFloorMet, true);
    assert.equal(report.controlsAllUnanimous, true);
    assert.equal(report.pass, true);
  });
});
