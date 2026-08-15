import { z } from 'zod';
import { AuditRecordSchema } from '../audit/record.ts';
import { resolveConsensus } from './consensus.ts';
import type { Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';
import type { ExemplarSelection } from '../calibration/exemplar-injection.ts';

/**
 * A verdict is the subset of `AuditRecordSchema` known at the moment
 * severity classification + consensus resolution are combined — everything
 * except the audit sink's own chain bookkeeping (`seq`/`prevHash`/`hash`/
 * `timestamp`), which is only assigned once the record is actually
 * appended (see `src/audit/*`, PR2). Overrides are a distinct record kind
 * entirely (`OverrideRecordSchema`, `src/audit/record.ts`) appended by a
 * later, separate human action — never produced by verdict assembly.
 */
export const VerdictSchema = AuditRecordSchema.omit({
  seq: true,
  prevHash: true,
  hash: true,
  timestamp: true,
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A short, stable description of what the action actually does, used for
 * the audit record's `action` field.
 */
function describeAction(action: ProposedAction): string {
  switch (action.source) {
    case 'coding_agent':
      return action.command;
    case 'infra_pipeline':
      // STUB (PR1/PR2 scope): the CI adapter itself is deferred; pipelineId
      // is the only stable identifier this stub shape carries.
      return action.pipelineId;
    default: {
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}

/**
 * Default when no selection is supplied (e.g. every pre-existing 3-arg
 * `assembleVerdict` call). Deliberately distinct from `EMPTY_SELECTION`
 * (`src/calibration/exemplar-injection.ts`), which flags a genuine
 * corpus-read failure (`degraded: true`) — this default means "no
 * calibration attempt was made at all", so `degraded` stays `false`.
 *
 * `ExemplarSelection` itself is imported `type`-only above: with
 * `verbatimModuleSyntax: true` (`tsconfig.json`) a type-only import is
 * erased entirely at emit/strip time, so this does NOT pull the fs-bearing
 * `exemplar-injection.ts` module (transitively `corpus.ts`/`tiers-config.ts`)
 * into `verdict.ts`'s runtime import graph — the concern the previous
 * locally-duplicated `ExemplarSelectionLike` type existed to avoid was
 * never actually at risk.
 */
const EMPTY_EXEMPLAR_SELECTION: ExemplarSelection = { exemplars: [], corpusHash: '', degraded: false };

/**
 * Combines the orchestrator-owned severity classification
 * (`src/gating/severity.ts`) with quorum consensus resolution
 * (`src/gating/consensus.ts`) into a single verdict record.
 *
 * `selection` is an additive 4th param (default `EMPTY_EXEMPLAR_SELECTION`)
 * populating `calibrationCorpusHash`/`exemplarIds` with the real,
 * once-per-action corpus snapshot hash and retrieved-exemplar content
 * hashes `runHook` resolves via `resolveExemplarSelection` — replacing the
 * previous `''`/`[]` placeholders. Every existing 3-arg call site (e.g.
 * `tests/gating/verdict.test.ts`) keeps compiling and behaving unchanged
 * against this default.
 */
export function assembleVerdict(
  action: ProposedAction,
  severity: SeverityTier,
  votes: [Vote, Vote, Vote],
  selection: ExemplarSelection = EMPTY_EXEMPLAR_SELECTION,
): Verdict {
  return {
    actor: action.actor,
    mode: action.mode,
    action: describeAction(action),
    severity,
    votes,
    decision: resolveConsensus(votes, severity),
    calibrationCorpusHash: selection.corpusHash,
    exemplarIds: selection.exemplars.map((exemplar) => exemplar.contentHash),
    corpusDegraded: selection.degraded,
  };
}
