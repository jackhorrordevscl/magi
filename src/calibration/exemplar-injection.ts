import { CalibrationCorpus, computeCorpusSnapshotHash } from './corpus.ts';
import { selectExemplars } from './selector.ts';
import { loadSyncExemplarK } from './tiers-config.ts';
import { warn, describeError } from '../shared/log.ts';
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
  /**
   * True when the corpus read was degraded: either the directory itself was
   * unreadable, or one or more entry files were skipped as corrupt. False
   * for a genuinely empty-but-valid corpus. Without this, an empty corpus
   * and a corpus quietly losing real entries to corruption are otherwise
   * indistinguishable in the resulting `exemplars`/`corpusHash` — both are
   * `[]`/`''`. Carried through to `Verdict.corpusDegraded`
   * (`src/gating/verdict.ts`) so the distinction lands in the durable audit
   * record, not just a transient stderr warning.
   */
  readonly degraded: boolean;
}

/** The selection resolution degrades to when the corpus directory itself is unreadable (a directory-level failure, not a per-file one — see `listWithDiagnostics()`). */
export const EMPTY_SELECTION: ExemplarSelection = { exemplars: [], corpusHash: '', degraded: true };

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
 * constructed), never a `deny`. Both a directory-level read failure and a
 * per-file corrupt-entry skip warn at `stderr` (the latter from inside
 * `CalibrationCorpus.listWithDiagnostics()` itself); either way `degraded`
 * is `true` on the returned selection, so the distinction between "no
 * calibration data yet" and "corpus is silently losing entries" survives
 * past the stderr line into the audit record (spec scenario
 * "Distinguishing empty corpus from failed read").
 */
export function resolveExemplarSelection(
  action: ProposedAction,
  severity: SeverityTier,
  options: { corpus?: CalibrationCorpus; configPath?: string } = {},
): ExemplarSelection {
  const corpus = options.corpus ?? new CalibrationCorpus();

  let entries: CalibrationEntry[];
  let skippedCount: number;
  try {
    ({ entries, skippedCount } = corpus.listWithDiagnostics());
  } catch (error) {
    warn(`magi: calibration corpus unavailable, voting without exemplars: ${describeError(error)}`);
    return EMPTY_SELECTION;
  }

  const corpusHash = computeCorpusSnapshotHash(entries);
  const k = loadSyncExemplarK(options.configPath);
  const exemplars = selectExemplars(entries, { tag: deriveExemplarTag(action), severity }, k);

  return { exemplars, corpusHash, degraded: skippedCount > 0 };
}
