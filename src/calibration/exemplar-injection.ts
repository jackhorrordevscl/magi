import { CalibrationCorpus, computeCorpusSnapshotHash } from './corpus.ts';
import { selectExemplars } from './selector.ts';
import { loadSyncExemplarK } from './tiers-config.ts';
import type { CalibrationEntry } from './corpus-schema.ts';
import type { ProposedAction, SeverityTier } from '../gating/proposed-action.ts';

/**
 * Orchestration layer for live calibration exemplar injection — fs-bearing
 * (transitively, via `CalibrationCorpus`/`corpus.ts`), and ONLY ever
 * imported by `runHook` (`claude-code-hook/index.ts`), the sole production
 * orchestrator that calls `classify` -> `collectVotes` -> `assembleVerdict`
 * (per `sdd/magi-calibration-live-wiring/design`). This keeps the three
 * evaluator backends fs-free — they only ever import the pure
 * `formatExemplarsForPrompt` from `./exemplar-prompt.ts`.
 */

/** One resolved exemplar selection, shared unchanged by every evaluator and by `assembleVerdict`. */
export interface ExemplarSelection {
  readonly exemplars: readonly CalibrationEntry[];
  /** Digest-of-digests over the FULL corpus snapshot (not just the retrieved exemplars). `''` when empty or degraded. */
  readonly corpusHash: string;
}

/** The selection every non-trivial action degrades to when the corpus is empty, unreadable, or corrupt. */
export const EMPTY_SELECTION: ExemplarSelection = { exemplars: [], corpusHash: '' };

/**
 * Derives the lexical query tag `selectExemplars` matches against, from
 * `action` text alone — per spec Requirement: Minimal Tag Derivation, no
 * new `tag` field is added to `ProposedAction`. Mirrors `describeAction`
 * (`src/gating/verdict.ts`): `coding_agent` -> `action.command`;
 * `infra_pipeline` -> `` `${action.pipelineId} ${action.target}` `` (a bare
 * `pipelineId` is opaque, `target` adds matchable tokens).
 */
export function deriveExemplarTag(action: ProposedAction): string {
  switch (action.source) {
    case 'coding_agent':
      return action.command;
    case 'infra_pipeline':
      return `${action.pipelineId} ${action.target}`;
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves ONE `ExemplarSelection` for `action`/`severity`, shared by every
 * evaluator and by `assembleVerdict` (spec Requirement: Single Shared
 * Exemplar Selection Per Action). Reads the corpus and applies
 * `tiers.sync.k` (spec Requirement: k Resolved From Configured Tier
 * Setting) with no relevance floor and no tier-conditional gating (spec
 * Requirements: No Relevance Floor / Uniform Injection Across Severity
 * Tiers) — `selectExemplars`'s own top-k ranking is trusted unfiltered.
 *
 * NEVER throws (spec Requirement: Non-Fatal Degrade On Corpus Read
 * Failure). The try/catch here is CONTAINED and architecturally disjoint
 * from any evaluator's fail-closed catch: this one lives upstream of
 * `collectVotes` and produces empty CONTEXT (no gating signal, no `Vote`
 * constructed), never a `deny`. On failure it warns at `stderr` and returns
 * `EMPTY_SELECTION` — the same value a genuinely empty (but valid) corpus
 * produces, EXCEPT only the failure path emits the warn-level log (spec
 * scenario "Distinguishing empty corpus from failed read").
 */
export function resolveExemplarSelection(
  action: ProposedAction,
  severity: SeverityTier,
  options: { corpus?: CalibrationCorpus; configPath?: string } = {},
): ExemplarSelection {
  const corpus = options.corpus ?? new CalibrationCorpus();

  let entries: CalibrationEntry[];
  try {
    entries = corpus.list();
  } catch (error) {
    warn(`magi: calibration corpus unavailable, voting without exemplars: ${describeError(error)}`);
    return EMPTY_SELECTION;
  }

  const corpusHash = computeCorpusSnapshotHash(entries);
  const k = loadSyncExemplarK(options.configPath);
  const exemplars = selectExemplars(entries, { tag: deriveExemplarTag(action), severity }, k);

  return { exemplars, corpusHash };
}
