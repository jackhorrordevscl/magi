import fs from 'node:fs';
import { z } from 'zod';
import { warn, describeError } from '../shared/log.ts';

/**
 * Standalone `tiers.sync.k` reader — deliberately NOT folded into
 * `src/gating/evaluator-config.ts` (per `sdd/magi-calibration-live-wiring/
 * design` decision "`tiers.sync.k` gets its own module, not
 * `evaluator-config.ts`"). `evaluator-config.ts` transitively imports all
 * three evaluator classes (including `@anthropic-ai/sdk`); reading
 * `tiers.sync.k` must not drag that graph in, and its own config cache is
 * typed `Map<string, EvaluatorsConfig>` — unrelated to a bare `number`.
 *
 * Mirrors `loadEvaluatorConfig`'s exact pattern: module-level `Map` cache,
 * `fs.existsSync` guard, zod `.catch()` per-field fallback, never throws,
 * stderr warn on an invalid value, default `5`.
 */

const DEFAULT_CONFIG_PATH = 'magi.config.json';
const DEFAULT_SYNC_K = 5;

const SyncTierSchema = z
  .object({
    k: z.number().int().positive().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

const TiersShapeSchema = z
  .object({
    sync: SyncTierSchema,
  })
  .optional()
  .catch(undefined);

const TiersConfigShapeSchema = z
  .object({
    tiers: TiersShapeSchema,
  })
  .catch({});

/** Module-level cache: at most one read of a given path per process. */
const kCache = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAndParseSyncK(configPath: string): number {
  if (!fs.existsSync(configPath)) return DEFAULT_SYNC_K;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    warn(
      `magi: tiers config: failed to parse ${configPath} as JSON, using default sync exemplar k=${DEFAULT_SYNC_K}: ${describeError(error)}`,
    );
    return DEFAULT_SYNC_K;
  }

  const parseResult = TiersConfigShapeSchema.safeParse(raw);
  const parsed = parseResult.success ? parseResult.data : {};
  const k = parsed.tiers?.sync?.k;
  if (k !== undefined) return k;

  // The schema's per-field `.catch()` is silent by itself — emit the
  // operator-facing warning here only when a `tiers.sync.k` value was
  // actually present but invalid (never for a genuinely absent key, which
  // is expected/quiet default territory, mirroring `evaluator-config.ts`'s
  // `warnOnDroppedFields`).
  const rawTiers = isRecord(raw) ? raw.tiers : undefined;
  const rawSync = isRecord(rawTiers) ? rawTiers.sync : undefined;
  const rawK = isRecord(rawSync) ? rawSync.k : undefined;
  if (rawK !== undefined) {
    warn(
      `magi: tiers config: tiers.sync.k in ${configPath} is invalid (${JSON.stringify(rawK)}), falling back to default k=${DEFAULT_SYNC_K}.`,
    );
  }
  return DEFAULT_SYNC_K;
}

/**
 * NEVER throws. Missing file / unreadable / invalid JSON / invalid value
 * (non-integer, zero, negative) all resolve to the default `k=5`. Memoized
 * per resolved path — read at most once per process (no hot-reload), same
 * convention as `loadEvaluatorConfig`.
 */
export function loadSyncExemplarK(configPath: string = DEFAULT_CONFIG_PATH): number {
  const cached = kCache.get(configPath);
  if (cached !== undefined) return cached;

  const result = readAndParseSyncK(configPath);
  kCache.set(configPath, result);
  return result;
}
