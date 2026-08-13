import type { CalibrationEntry } from './corpus-schema.ts';
import type { SeverityTier } from '../gating/proposed-action.ts';

/**
 * Deterministic lexical tag+severity retrieval over the calibration corpus
 * — no vector DB, no model call, for reproducibility and audit replay (per
 * `sdd/magi/design`). The same `(entries, query, k)` input always returns
 * the same top-K exemplars, in the same order, regardless of the input
 * `entries` array's own order.
 *
 * `k` is caller-supplied rather than read from config here (this module
 * performs no I/O): callers pass `magi.config.json`'s `tiers.sync.k` (5) or
 * `tiers.async.k` (12, currently unused/placeholder) depending on which
 * tier is invoking it.
 */
export interface ExemplarQuery {
  tag: string;
  severity: SeverityTier;
}

/**
 * Lexical similarity score between an entry's tag and the query tag: exact
 * match scores highest, substring containment next, then token overlap,
 * with a floor of 0 for no relation at all. Pure/deterministic — the same
 * two strings always produce the same score.
 */
function tagScore(entryTag: string, queryTag: string): number {
  const a = entryTag.toLowerCase();
  const b = queryTag.toLowerCase();
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;

  const aTokens = new Set(a.split(/[^a-z0-9]+/).filter(Boolean));
  const bTokens = new Set(b.split(/[^a-z0-9]+/).filter(Boolean));
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap;
}

const SEVERITY_MATCH_BONUS = 5;

/**
 * Selects the top-`k` calibration exemplars for `query`, ranked by
 * (severity match bonus + lexical tag score) descending, tie-broken by
 * ascending `contentHash` for full determinism independent of any
 * unstable iteration order.
 */
export function selectExemplars(
  entries: readonly CalibrationEntry[],
  query: ExemplarQuery,
  k: number,
): CalibrationEntry[] {
  if (k <= 0) return [];

  const scored = entries.map((entry) => ({
    entry,
    score: tagScore(entry.tag, query.tag) + (entry.severity === query.severity ? SEVERITY_MATCH_BONUS : 0),
  }));

  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return x.entry.contentHash.localeCompare(y.entry.contentHash);
  });

  return scored.slice(0, k).map((s) => s.entry);
}
