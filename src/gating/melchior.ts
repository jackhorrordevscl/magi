import { AnthropicEvaluator } from './anthropic-evaluator.ts';
import type { AnthropicEvaluatorOptions, CalibrationFacet } from './anthropic-evaluator.ts';

/**
 * Melchior — the fact/consistency evaluator, per spec Requirement:
 * Evaluator Vote Contract. This facet is grounded in the real engineering
 * question a careful reviewer asks first ("does this action actually do
 * what it claims, given its own stated context?"), not a fabricated
 * generic persona — see `sdd/magi/design` decision on calibration (#1009).
 */
export const MELCHIOR_FACET: CalibrationFacet = {
  description: 'fact/consistency',
  guidance:
    'Judge whether the proposed action is internally consistent and factually sound given its stated actor, ' +
    'action type, target, environment, and command: does it actually do what it appears to do, and does ' +
    'anything about it contradict itself or the surrounding context? Vote deny when the action is misleading, ' +
    'self-contradictory, or its real effect looks like it would diverge from its apparent intent. Vote abstain ' +
    'only when you genuinely cannot determine consistency from the information given — never as a shortcut ' +
    'around forming a judgment.',
};

/** Creates a Melchior evaluator instance. `options` allows test/DI overrides (client, model, timeoutMs, apiKey). */
export function createMelchior(options: AnthropicEvaluatorOptions = {}): AnthropicEvaluator {
  return new AnthropicEvaluator('melchior', MELCHIOR_FACET, options);
}

/** Default Melchior instance, backed by the real Anthropic API (`ANTHROPIC_API_KEY`). */
export const melchior: AnthropicEvaluator = createMelchior();
