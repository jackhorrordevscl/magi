import { z } from 'zod';
import { AuditRecordSchema } from '../audit/record.ts';
import { resolveConsensus } from './consensus.ts';
import type { Vote } from './consensus.ts';
import type { ProposedAction, SeverityTier } from './proposed-action.ts';

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
 * Structural subset of `ExemplarSelection`
 * (`src/calibration/exemplar-injection.ts`) — declared locally, deliberately
 * NOT imported, so `verdict.ts` never pulls in that fs-bearing module
 * (which is only ever imported by `runHook`, per
 * `sdd/magi-calibration-live-wiring/design`). Any real `ExemplarSelection`
 * value returned by `resolveExemplarSelection` satisfies this shape
 * structurally, so `runHook` passing one through unchanged still
 * typechecks.
 */
interface ExemplarSelectionLike {
  readonly exemplars: readonly { readonly contentHash: string }[];
  readonly corpusHash: string;
  readonly degraded: boolean;
}

const EMPTY_EXEMPLAR_SELECTION: ExemplarSelectionLike = { exemplars: [], corpusHash: '', degraded: false };

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
  selection: ExemplarSelectionLike = EMPTY_EXEMPLAR_SELECTION,
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
