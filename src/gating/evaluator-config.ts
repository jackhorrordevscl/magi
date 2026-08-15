import fs from 'node:fs';
import { z } from 'zod';
import type { Evaluator as EvaluatorName } from './consensus.ts';
import type { CalibrationFacet } from './anthropic-evaluator.ts';
import type { EvaluatorPort } from './evaluator-port.ts';
import { GroqEvaluator } from './groq-evaluator.ts';
import type { GroqChatClient } from './groq-evaluator.ts';
import { AnthropicEvaluator } from './anthropic-evaluator.ts';
import type { AnthropicMessagesClient } from './anthropic-evaluator.ts';
import { GeminiEvaluator } from './gemini-evaluator.ts';
import type { GeminiClient } from './gemini-evaluator.ts';

/**
 * Shared config layer consumed by `melchior.ts`/`balthasar.ts`/`casper.ts`
 * (their **module-level default exports only**, never their `create*`
 * factories — see `sdd/magi-evaluator-config-layer/design` decision 2) and,
 * transitively, by `src/cli/main.ts` and `claude-code-hook/index.ts`, which
 * both already type those exports as `EvaluatorPort` and require zero edits.
 *
 * `magi.config.json` MAY carry an optional top-level `evaluators` key,
 * itself an object keyed by evaluator name (`melchior`/`balthasar`/
 * `casper`), each entry independently and optionally specifying `backend`
 * (`"anthropic" | "groq" | "gemini"`), `model`, `timeoutMs`, `maxTokens`.
 * Every field falls back to that evaluator's hardcoded default
 * independently of its siblings — an invalid/missing field never
 * invalidates the rest of the entry, and an invalid/missing entry never
 * invalidates the rest of the file. Nothing here ever throws: a missing
 * file, unreadable file, invalid JSON, or wrong shape all resolve to `{}`
 * (i.e. every evaluator falls back to its hardcoded default), unlike
 * `src/cli/main.ts`'s `loadConfig()`, which still throws on invalid JSON —
 * that throwing behavior is deliberately NOT replicated here.
 */

export const EvaluatorBackendSchema = z.enum(['anthropic', 'groq', 'gemini']);
export type EvaluatorBackend = z.infer<typeof EvaluatorBackendSchema>;

/**
 * Every field independently recoverable via zod's per-field `.catch()`.
 * `apiKey`/`baseUrl`/`client` are deliberately absent from this schema:
 * unknown keys are stripped by zod's default (non-strict) object parsing,
 * so none of them can ever reach an evaluator's constructor via config.
 * `apiKey` additionally gets its own explicit own-property warning — see
 * `warnOnRejectedApiKey` below — because a silently-stripped `apiKey` would
 * otherwise give an operator no signal that it was ignored.
 */
const EvaluatorSettingsSchema = z
  .object({
    backend: EvaluatorBackendSchema.optional().catch(undefined),
    model: z.string().min(1).optional().catch(undefined),
    timeoutMs: z.number().int().positive().optional().catch(undefined),
    maxTokens: z.number().int().positive().optional().catch(undefined),
  })
  .catch({});

export type EvaluatorSettings = z.infer<typeof EvaluatorSettingsSchema>;

/**
 * Test-only seam: `resolveNamedEvaluator`'s explicit `settings` argument
 * (never `loadEvaluatorConfig()`'s output — the schema above has no
 * `client` key, so a config-file-derived `EvaluatorSettings` can never
 * carry one) MAY additionally carry a `client`, forwarded verbatim to the
 * resolved backend's constructor. This lets tests inject a fake transport
 * and capture the constructed instance's outgoing `model` (mirroring the
 * existing `createMelchior({ client })` pattern) without a live network
 * call, while config-driven construction can never set `client`/`apiKey`
 * (per the Backend Resolution Table in design.md — those always stay
 * `undefined` so each evaluator's own env-var default applies).
 */
export interface EvaluatorSettingsOverride extends EvaluatorSettings {
  client?: unknown;
}

export const EvaluatorsConfigSchema = z
  .object({
    melchior: EvaluatorSettingsSchema.optional().catch(undefined),
    balthasar: EvaluatorSettingsSchema.optional().catch(undefined),
    casper: EvaluatorSettingsSchema.optional().catch(undefined),
  })
  .catch({});

export type EvaluatorsConfig = z.infer<typeof EvaluatorsConfigSchema>;

/** Named-evaluator baseline: today's hardcoded construction, as data. */
export interface NamedEvaluatorDefaults {
  backend: EvaluatorBackend;
  model: string;
}

const EVALUATOR_NAMES = ['melchior', 'balthasar', 'casper'] as const;
const SETTINGS_FIELDS = ['backend', 'model', 'timeoutMs', 'maxTokens'] as const;

const DEFAULT_CONFIG_PATH = 'magi.config.json';

/** Module-level cache: at most one read of a given path per process (design decision 7). */
const configCache = new Map<string, EvaluatorsConfig>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnOnRejectedApiKey(name: (typeof EVALUATOR_NAMES)[number], rawEntry: Record<string, unknown>, configPath: string): void {
  if (Object.prototype.hasOwnProperty.call(rawEntry, 'apiKey')) {
    warn(
      `magi: evaluator config: evaluators.${name}.apiKey in ${configPath} is not a valid config field — ` +
        'API keys are environment-variable-only (e.g. GROQ_API_KEY/ANTHROPIC_API_KEY/GEMINI_API_KEY); ignored.',
    );
  }
}

/**
 * Warns for any field that was present (and not `undefined`) on the raw
 * parsed entry but dropped by schema validation — the per-field `.catch()`
 * fallback in `EvaluatorSettingsSchema` is silent by itself, so this is
 * where the corresponding operator-facing warning actually gets emitted,
 * once, at load time (never duplicated at resolution time).
 */
function warnOnDroppedFields(
  name: (typeof EVALUATOR_NAMES)[number],
  rawEntry: Record<string, unknown>,
  parsedEntry: EvaluatorSettings,
  configPath: string,
): void {
  for (const field of SETTINGS_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(rawEntry, field) &&
      rawEntry[field] !== undefined &&
      parsedEntry[field] === undefined
    ) {
      warn(
        `magi: evaluator config: evaluators.${name}.${field} in ${configPath} is invalid ` +
          `(${JSON.stringify(rawEntry[field])}), falling back to ${name}'s hardcoded default.`,
      );
    }
  }
}

function readAndParseEvaluatorConfig(configPath: string): EvaluatorsConfig {
  if (!fs.existsSync(configPath)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    warn(
      `magi: evaluator config: failed to parse ${configPath} as JSON, using hardcoded defaults for all ` +
        `evaluators: ${describeError(error)}`,
    );
    return {};
  }

  const evaluatorsRaw = isRecord(raw) ? raw.evaluators : undefined;
  if (evaluatorsRaw === undefined) return {};

  if (!isRecord(evaluatorsRaw)) {
    warn(
      `magi: evaluator config: "evaluators" in ${configPath} is not an object, using hardcoded defaults ` +
        'for all evaluators.',
    );
    return {};
  }

  const parseResult = EvaluatorsConfigSchema.safeParse(evaluatorsRaw);
  const parsed: EvaluatorsConfig = parseResult.success ? parseResult.data : {};

  for (const name of EVALUATOR_NAMES) {
    const rawEntry = evaluatorsRaw[name];
    if (rawEntry === undefined) continue;

    if (!isRecord(rawEntry)) {
      warn(
        `magi: evaluator config: evaluators.${name} in ${configPath} is not an object, using ${name}'s ` +
          'hardcoded defaults.',
      );
      continue;
    }

    warnOnRejectedApiKey(name, rawEntry, configPath);
    warnOnDroppedFields(name, rawEntry, parsed[name] ?? {}, configPath);
  }

  return parsed;
}

/**
 * NEVER throws. Missing file / unreadable / invalid JSON / wrong shape all
 * resolve to `{}` (every evaluator falls back to its hardcoded default).
 * Reads and resolves synchronously, mirroring `main.ts`'s existing
 * `fs.existsSync`/`fs.readFileSync` pattern, and is memoized per resolved
 * path so a given path is read at most once per process (no hot-reload).
 */
export function loadEvaluatorConfig(configPath: string = DEFAULT_CONFIG_PATH): EvaluatorsConfig {
  const cached = configCache.get(configPath);
  if (cached !== undefined) return cached;

  const result = readAndParseEvaluatorConfig(configPath);
  configCache.set(configPath, result);
  return result;
}

interface ConstructorOptions {
  client?: unknown;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/**
 * Copies only the keys of `obj` whose value is not `undefined`. Required
 * under `tsconfig`'s `exactOptionalPropertyTypes: true`: every downstream
 * `*EvaluatorOptions` declares its fields as plain optional (`model?: string`,
 * not `model?: string | undefined`), so explicitly assigning `undefined` to
 * an optional key is a type error — omitting the key entirely is required
 * instead, which is exactly what an omitted/invalid config field means here.
 */
type WithoutUndefined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function omitUndefined<T extends Record<string, unknown>>(obj: T): WithoutUndefined<T> {
  const result: WithoutUndefined<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value !== undefined) result[key] = value as Exclude<T[typeof key], undefined>;
  }
  return result;
}

/**
 * `apiKey` and `client` are never set from config-driven settings — always
 * absent unless a caller explicitly passes `client` via the test-only
 * `settings` seam — so each evaluator's constructor applies its own env-var
 * default (`GROQ_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) unchanged.
 */
const BACKEND_TABLE: Record<
  EvaluatorBackend,
  (name: EvaluatorName, facet: CalibrationFacet, options: ConstructorOptions) => EvaluatorPort
> = {
  groq: (name, facet, options) =>
    new GroqEvaluator(name, facet, {
      ...omitUndefined({ model: options.model, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens }),
      ...(options.client !== undefined ? { client: options.client as GroqChatClient } : {}),
    }),
  anthropic: (name, facet, options) =>
    new AnthropicEvaluator(name, facet, {
      ...omitUndefined({ model: options.model, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens }),
      ...(options.client !== undefined ? { client: options.client as AnthropicMessagesClient } : {}),
    }),
  gemini: (name, facet, options) =>
    new GeminiEvaluator(name, facet, {
      ...omitUndefined({ model: options.model, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens }),
      ...(options.client !== undefined ? { client: options.client as GeminiClient } : {}),
    }),
};

/**
 * Builds the configured instance, or `defaults`' hardcoded construction
 * when unconfigured. `settings` defaults to `loadEvaluatorConfig()[name]`
 * when omitted; explicit `settings` is a test seam (see
 * `EvaluatorSettingsOverride`).
 *
 * Model default is backend-aware (design decision 4): when the resolved
 * `backend` differs from `defaults.backend` (today always `'groq'`) and no
 * `model` override is given, `model` is left `undefined` so the target
 * concrete evaluator's OWN built-in default model applies — never carrying
 * a Groq-specific hardcoded model string across a backend switch.
 */
export function resolveNamedEvaluator(
  name: EvaluatorName,
  facet: CalibrationFacet,
  defaults: NamedEvaluatorDefaults,
  settings?: EvaluatorSettingsOverride,
): EvaluatorPort {
  const resolved: EvaluatorSettingsOverride = settings ?? loadEvaluatorConfig()[name] ?? {};
  const backend = resolved.backend ?? defaults.backend;
  const model = resolved.model ?? (backend === defaults.backend ? defaults.model : undefined);

  const options: ConstructorOptions = {
    ...omitUndefined({ model, timeoutMs: resolved.timeoutMs, maxTokens: resolved.maxTokens }),
    ...(resolved.client !== undefined ? { client: resolved.client } : {}),
  };

  return BACKEND_TABLE[backend](name, facet, options);
}
