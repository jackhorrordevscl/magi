import type { Evaluator as EvaluatorName } from '../../gating/consensus.ts';
import type { EvaluatorBackend, EvaluatorSettings } from '../../gating/evaluator-config.ts';
import { MELCHIOR_DEFAULTS } from '../../gating/melchior.ts';
import { BALTHASAR_DEFAULTS } from '../../gating/balthasar.ts';
import { CASPER_DEFAULTS } from '../../gating/casper.ts';
import { GROQ_BUILTIN_DEFAULTS } from '../../gating/groq-evaluator.ts';
import { ANTHROPIC_BUILTIN_DEFAULTS } from '../../gating/anthropic-evaluator.ts';
import { GEMINI_BUILTIN_DEFAULTS } from '../../gating/gemini-evaluator.ts';

/**
 * Computes the *displayed* effective value of every field on an evaluator's
 * settings entry — this is display-only and must NEVER be called from the
 * TUI's save path, and must NEVER call `loadEvaluatorConfig()` or
 * `resolveNamedEvaluator()` (see `src/gating/evaluator-config.ts`).
 * It reimplements design decision 4 of the archived
 * `sdd/magi-evaluator-config-layer/design` (backend-aware model default) for
 * display purposes only: when the resolved `backend` differs from the named
 * evaluator's own baseline backend, an unset `model` shows the target
 * backend's own built-in default model, never the named evaluator's literal.
 */

export interface EffectiveField<T> {
  value: T;
  source: 'config' | 'default';
}

export interface EffectiveSettings {
  backend: EffectiveField<EvaluatorBackend>;
  model: EffectiveField<string>;
  timeoutMs: EffectiveField<number>;
  maxTokens: EffectiveField<number>;
}

interface NamedDefaults {
  backend: EvaluatorBackend;
  model: string;
}

interface BuiltinDefaults {
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

/**
 * Named-evaluator baselines, as already exported from `melchior.ts`/
 * `balthasar.ts`/`casper.ts` (already imported by `main.ts`, so importing
 * them here introduces no new import-time side effect).
 */
const NAMED_DEFAULTS: Record<EvaluatorName, NamedDefaults> = {
  melchior: MELCHIOR_DEFAULTS,
  balthasar: BALTHASAR_DEFAULTS,
  casper: CASPER_DEFAULTS,
};

/** Each concrete evaluator backend's own built-in defaults (additive exports, no behavior change). */
const BUILTIN_DEFAULTS: Record<EvaluatorBackend, BuiltinDefaults> = {
  groq: GROQ_BUILTIN_DEFAULTS,
  anthropic: ANTHROPIC_BUILTIN_DEFAULTS,
  gemini: GEMINI_BUILTIN_DEFAULTS,
};

export function effectiveSettings(name: EvaluatorName, entry: EvaluatorSettings): EffectiveSettings {
  const named = NAMED_DEFAULTS[name];
  const backendValue = entry.backend ?? named.backend;
  const builtin = BUILTIN_DEFAULTS[backendValue];

  // Model default is backend-aware: only the resolved backend matching the
  // evaluator's own named-default backend uses the named literal; any other
  // backend shows that backend's own built-in default model.
  const modelValue = entry.model ?? (backendValue === named.backend ? named.model : builtin.model);

  return {
    backend: { value: backendValue, source: entry.backend !== undefined ? 'config' : 'default' },
    model: { value: modelValue, source: entry.model !== undefined ? 'config' : 'default' },
    timeoutMs: {
      value: entry.timeoutMs ?? builtin.timeoutMs,
      source: entry.timeoutMs !== undefined ? 'config' : 'default',
    },
    maxTokens: {
      value: entry.maxTokens ?? builtin.maxTokens,
      source: entry.maxTokens !== undefined ? 'config' : 'default',
    },
  };
}
