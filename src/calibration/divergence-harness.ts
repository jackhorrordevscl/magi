import { collectVotes } from '../gating/evaluator-port.ts';
import type { EvaluatorPort } from '../gating/evaluator-port.ts';
import type { Vote } from '../gating/consensus.ts';
import type { ProposedAction, SeverityTier } from '../gating/proposed-action.ts';

/**
 * Validates that the three evaluator calibration facets actually disagree
 * on designed-divergent fixtures (proving they are not three cosmetically
 * collapsed copies of one generic judge) and agree unanimously on
 * designed-control fixtures (proving they don't just disagree at random
 * either). Backs the `magi calibrate verify` CLI command (see
 * `src/cli/calibrate.ts`).
 *
 * This module is evaluator-agnostic: it drives any `EvaluatorPort` triple
 * via `collectVotes` (the same Promise.allSettled dispatch Phase 7 uses),
 * so it never fabricates or depends on the real Anthropic API's behavior —
 * tests exercise it with fake evaluators (see
 * `tests/calibration/divergence-harness.test.ts`); real usage against
 * `melchior`/`balthasar`/`casper` is the CLI's job, not this module's.
 *
 * The 40% divergence floor and fixture set are explicit placeholders (per
 * design) pending the first real calibration corpus — this harness is the
 * generic engine, not the judgment about what "enough" divergence is.
 */
export interface DivergenceFixture {
  id: string;
  /** Human-readable label for reporting; optional since `id` alone is sufficient for the harness logic. */
  label?: string;
  /** `divergent` fixtures are designed so evaluators SHOULD disagree; `control` fixtures are designed so they SHOULD agree. */
  kind: 'divergent' | 'control';
  action: ProposedAction;
  severity: SeverityTier;
}

export interface DivergenceCheckResult {
  fixtureId: string;
  kind: DivergenceFixture['kind'];
  votes: [Vote, Vote, Vote];
  /** True only when all three votes are the exact same decision (allow/deny/abstain). */
  unanimous: boolean;
}

export interface DivergenceReport {
  results: DivergenceCheckResult[];
  /** Fraction (0-1) of `divergent` fixtures where the evaluators did NOT vote unanimously. Vacuously 1 (trivially met) when there are no divergent fixtures. */
  divergentFixturesDivergenceRate: number;
  /** Fraction (0-1) of `control` fixtures that DID vote unanimously. Vacuously 1 when there are no control fixtures. */
  controlFixturesUnanimityRate: number;
  /** `divergentFixturesDivergenceRate * 100 >= divergenceFloorPercent`. */
  divergenceFloorMet: boolean;
  /** `controlFixturesUnanimityRate === 1`. */
  controlsAllUnanimous: boolean;
  /** `divergenceFloorMet && controlsAllUnanimous`. */
  pass: boolean;
}

function isUnanimous(votes: [Vote, Vote, Vote]): boolean {
  return votes[0].vote === votes[1].vote && votes[1].vote === votes[2].vote;
}

/**
 * Runs every fixture against `evaluators` (in parallel per-fixture via
 * `collectVotes`) and aggregates the divergence/unanimity rates.
 * `divergenceFloorPercent` is 0-100 (matches `magi.config.json`'s
 * `tiers.divergenceFloorPercent`, currently 40).
 */
export async function runDivergenceHarness(
  evaluators: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort],
  fixtures: readonly DivergenceFixture[],
  divergenceFloorPercent: number,
): Promise<DivergenceReport> {
  const results: DivergenceCheckResult[] = [];
  for (const fixture of fixtures) {
    const votes = await collectVotes(evaluators, fixture.action, fixture.severity);
    results.push({
      fixtureId: fixture.id,
      kind: fixture.kind,
      votes,
      unanimous: isUnanimous(votes),
    });
  }

  const divergentResults = results.filter((r) => r.kind === 'divergent');
  const controlResults = results.filter((r) => r.kind === 'control');

  const divergentFixturesDivergenceRate =
    divergentResults.length === 0
      ? 1
      : divergentResults.filter((r) => !r.unanimous).length / divergentResults.length;

  const controlFixturesUnanimityRate =
    controlResults.length === 0 ? 1 : controlResults.filter((r) => r.unanimous).length / controlResults.length;

  const divergenceFloorMet = divergentFixturesDivergenceRate * 100 >= divergenceFloorPercent;
  const controlsAllUnanimous = controlFixturesUnanimityRate === 1;

  return {
    results,
    divergentFixturesDivergenceRate,
    controlFixturesUnanimityRate,
    divergenceFloorMet,
    controlsAllUnanimous,
    pass: divergenceFloorMet && controlsAllUnanimous,
  };
}
