import type { Evaluator as EvaluatorName } from '../../gating/consensus.ts';
import { EvaluatorBackendSchema, EvaluatorsConfigSchema } from '../../gating/evaluator-config.ts';
import type { EvaluatorSettings } from '../../gating/evaluator-config.ts';

/**
 * Strict edit-time validation of a single evaluator field, for the TUI's
 * Evaluators screen (`app.ts`, Slice 3). `EvaluatorsConfigSchema` is the
 * ONLY judge (design decision 6) — this file hand-rolls no parallel
 * range/enum checks and exports no second schema.
 *
 * `EvaluatorSettingsSchema` composes `.optional().catch(undefined)` per
 * field and `.catch({})` at both levels (`src/gating/evaluator-config.ts`),
 * so `parse`/`safeParse` NEVER fails — an invalid field is silently dropped
 * to `undefined` rather than rejected. "Strict" validation is therefore
 * implemented via drop-detection: build a candidate entry with the raw
 * input applied to `field`, run it through the schema, and treat a
 * candidate that round-tripped to `undefined` as a rejection. Checking
 * `.success` would be pointless — it is always `true`.
 *
 * A literal empty string is NOT special-cased here as "clear the field" —
 * that is a distinct, separate keybinding (`d`, Slice 3's `app.ts`) that
 * sets the field to `undefined` directly, without ever calling this
 * function. An empty string submitted through the edit textbox is validated
 * like any other candidate value (and rejected for `model`, which requires
 * a non-empty string, and for `timeoutMs`/`maxTokens`, since `Number('')`
 * is `0`, not a positive integer) — conflating the two would make an
 * accidental empty submission silently equivalent to an intentional clear.
 */

export type FieldName = 'backend' | 'model' | 'timeoutMs' | 'maxTokens';

function candidateValueFor(field: FieldName, rawInput: string): unknown {
  return field === 'backend' || field === 'model' ? rawInput : Number(rawInput);
}

/** Error copy derived from the schema where possible (design decision 6). */
function rejectionMessage(field: FieldName, rawInput: string): string {
  switch (field) {
    case 'backend':
      return `invalid backend "${rawInput}" — accepted values: ${EvaluatorBackendSchema.options.join(', ')}`;
    case 'model':
      return `invalid model "${rawInput}" — must be a non-empty string`;
    case 'timeoutMs':
      return `invalid timeoutMs "${rawInput}" — must be a positive integer (milliseconds)`;
    case 'maxTokens':
      return `invalid maxTokens "${rawInput}" — must be a positive integer`;
  }
}

/**
 * Validates `rawInput` as a candidate value for `field` on `name`'s entry.
 * Accepted: returns the full updated entry (every other field untouched).
 * Rejected: returns the in-field error message; the caller MUST leave the
 * prior value unchanged and unsaved (spec: Edit-Time Validation Reuses the
 * Shared Schema).
 */
export function validateFieldEdit(
  name: EvaluatorName,
  field: FieldName,
  rawInput: string,
  entry: EvaluatorSettings,
): { ok: true; entry: EvaluatorSettings } | { ok: false; message: string } {
  const candidate: Record<string, unknown> = { ...entry, [field]: candidateValueFor(field, rawInput) };

  const parsed = EvaluatorsConfigSchema.parse({ [name]: candidate });
  const parsedEntry = parsed[name] ?? {};

  if (parsedEntry[field] === undefined) {
    return { ok: false, message: rejectionMessage(field, rawInput) };
  }

  return { ok: true, entry: { ...entry, [field]: parsedEntry[field] } };
}
