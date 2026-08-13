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
 * Combines the orchestrator-owned severity classification
 * (`src/gating/severity.ts`) with quorum consensus resolution
 * (`src/gating/consensus.ts`) into a single verdict record.
 *
 * `calibrationCorpusHash` and `exemplarIds` are passthrough placeholders in
 * this PR — real calibration-corpus lookup lands with the calibration
 * corpus itself in a later PR (Phase 8). This function only proves the
 * verdict shape carries those fields through unchanged; it does not
 * perform any real calibration lookup.
 */
export function assembleVerdict(
  action: ProposedAction,
  severity: SeverityTier,
  votes: [Vote, Vote, Vote],
): Verdict {
  return {
    actor: action.actor,
    mode: action.mode,
    action: describeAction(action),
    severity,
    votes,
    decision: resolveConsensus(votes, severity),
    calibrationCorpusHash: '',
    exemplarIds: [],
  };
}
