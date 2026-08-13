import { GroqEvaluator } from './groq-evaluator.ts';
import type { GroqEvaluatorOptions } from './groq-evaluator.ts';
import type { CalibrationFacet } from './anthropic-evaluator.ts';

/**
 * Balthasar — the blast-radius-to-others + policy evaluator, per spec
 * Requirement: Evaluator Vote Contract. This facet is grounded in the real
 * question a reviewer asks about impact on shared/production state and
 * organizational policy, not a fabricated generic persona — see
 * `sdd/magi/design` decision on calibration (#1009).
 */
export const BALTHASAR_FACET: CalibrationFacet = {
  description: 'blast radius to others + policy',
  guidance:
    'Judge how far the consequences of the proposed action reach beyond the actor themselves — other ' +
    'developers, shared branches, production/shared state, secrets, or infrastructure — and whether it ' +
    'respects the severity tier the orchestrator already assigned (low/medium/high/critical). Vote deny when ' +
    'the action reaches further than its stated severity would suggest, is irreversible on shared state ' +
    'without clear justification, or conflicts with a policy a careful operator would apply (e.g. no direct ' +
    'force-pushes to a protected branch, no unreviewed production changes). A narrowly-scoped, easily-reversible ' +
    'action confined to the actor\'s own workspace should not be denied on this facet alone.',
};

/** Creates a Balthasar evaluator instance. `options` allows test/DI overrides (client, model, timeoutMs, apiKey). */
export function createBalthasar(options: GroqEvaluatorOptions = {}): GroqEvaluator {
  return new GroqEvaluator('balthasar', BALTHASAR_FACET, { model: 'llama-3.3-70b-versatile', ...options });
}

/** Default Balthasar instance, backed by Groq's free tier (`GROQ_API_KEY`), model: llama-3.3-70b-versatile. */
export const balthasar: GroqEvaluator = createBalthasar();
