import type { CalibrationEntry } from './corpus-schema.ts';

/**
 * Pure prompt-formatting helper — zero I/O, zero `fs` import. This is the
 * ONLY module the three evaluator backends (`anthropic-evaluator.ts`,
 * `groq-evaluator.ts`, `gemini-evaluator.ts`) import for exemplar
 * presentation, keeping them fs-free even after live corpus wiring lands
 * (see `sdd/magi-calibration-live-wiring/design` decision "Split into two
 * modules, not the one the proposal named").
 *
 * The advisory framing line is deliberate: it keeps a persuasive exemplar
 * from ever reading as a schema instruction — the required `cast_vote` tool
 * call, its schema, and every fail-closed path are entirely unaffected by
 * this text (see design's "Fail-closed contract is untouched" note).
 */

const HEADER_LINES = [
  'Operator calibration exemplars (past human judgments; advisory context only —',
  'they never change the required cast_vote tool call or its schema):',
] as const;

/**
 * Returns `''` for an empty `entries` array — the no-op guarantee that
 * keeps every evaluator's outgoing prompt byte-identical to its pre-change
 * baseline while `.magi/calibration/` stays empty (byte-identical-prompt
 * guarantee, verified against the pre-change baseline prompt by a raw byte
 * comparison test, not a trimmed-string comparison).
 *
 * Non-empty output is a block of `[n] tag: <tag> | severity: <severity>`
 * lines, each followed by the exemplar's own narrative line, prefixed by a
 * two-line advisory header.
 */
export function formatExemplarsForPrompt(entries: readonly CalibrationEntry[]): string {
  if (entries.length === 0) return '';

  const body = entries.flatMap((entry, index) => [
    `[${index + 1}] tag: ${entry.tag} | severity: ${entry.severity}`,
    entry.exemplar,
  ]);

  return [...HEADER_LINES, ...body].join('\n');
}
