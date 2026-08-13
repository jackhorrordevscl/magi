import { z } from 'zod';
import { SeverityTierSchema } from '../gating/proposed-action.ts';

/**
 * One calibration exemplar: a real judgment call the human operator made,
 * grounding evaluator facets in the operator's own decision-making
 * criteria (per `sdd/magi/design` decision #1009), never a generic
 * fabricated persona.
 *
 * Entries are NEVER auto-labeled by a model. See `src/cli/calibrate.ts`:
 * both the interview flow and the import flow require an explicit human
 * confirmation step before an entry is ever written to the corpus (see
 * `src/calibration/corpus.ts`).
 */
export const CalibrationEntrySchema = z.object({
  /** Free-text topical tag used for deterministic lexical retrieval (see `src/calibration/selector.ts`). */
  tag: z.string().min(1),
  severity: SeverityTierSchema,
  /** The operator's own judgment/decision narrative for this exemplar. */
  exemplar: z.string().min(1),
  /**
   * SHA-256 hex digest over (tag, severity, exemplar) — the content-hashed
   * store's key (see `computeContentHash` / `CalibrationCorpus` in
   * `src/calibration/corpus.ts`). Also used for de-duplication: re-adding
   * identical content is a no-op.
   */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'contentHash must be a lowercase sha256 hex digest'),
  createdAt: z.string(),
});
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;

/**
 * Fields a caller supplies when adding an entry. `contentHash` and
 * `createdAt` are always derived by `CalibrationCorpus.add()`, never
 * accepted as caller input — this keeps the content-hash key trustworthy
 * (a caller can't forge it) and the timestamp honest (always the actual
 * write time, injected explicitly for determinism, same convention as
 * `src/audit/fs-append-sink.ts`).
 */
export const CalibrationEntryInputSchema = CalibrationEntrySchema.omit({
  contentHash: true,
  createdAt: true,
});
export type CalibrationEntryInput = z.infer<typeof CalibrationEntryInputSchema>;
