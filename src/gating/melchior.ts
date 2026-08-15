import { GroqEvaluator } from './groq-evaluator.ts';
import type { GroqEvaluatorOptions } from './groq-evaluator.ts';
import type { CalibrationFacet } from './anthropic-evaluator.ts';
import { resolveNamedEvaluator } from './evaluator-config.ts';
import type { NamedEvaluatorDefaults } from './evaluator-config.ts';
import type { EvaluatorPort } from './evaluator-port.ts';

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

/** Melchior's hardcoded baseline backend/model — the fallback whenever config is absent or a field is omitted. */
export const MELCHIOR_DEFAULTS: NamedEvaluatorDefaults = { backend: 'groq', model: 'openai/gpt-oss-120b' };

/** Creates a Melchior evaluator instance. `options` allows test/DI overrides (client, model, timeoutMs, apiKey). */
export function createMelchior(options: GroqEvaluatorOptions = {}): GroqEvaluator {
  return new GroqEvaluator('melchior', MELCHIOR_FACET, { model: MELCHIOR_DEFAULTS.model, ...options });
}

/**
 * Default Melchior instance. Backend/model/timeoutMs/maxTokens are resolved
 * from `magi.config.json`'s `evaluators.melchior` section (see
 * `src/gating/evaluator-config.ts`) when present, falling back field-by-field
 * to the hardcoded Groq defaults above (`GROQ_API_KEY`, model:
 * openai/gpt-oss-120b) exactly as before this capability existed.
 */
export const melchior: EvaluatorPort = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS);
