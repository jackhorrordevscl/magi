import fs from 'node:fs';
import path from 'node:path';
import { describeError } from '../../shared/log.ts';
import type { Evaluator as EvaluatorName } from '../../gating/consensus.ts';
import type { EvaluatorsConfig, EvaluatorSettings } from '../../gating/evaluator-config.ts';

/**
 * Read/parse/atomic-write of `magi.config.json` for the TUI (`app.ts`).
 * Deliberately independent of `src/gating/evaluator-config.ts`'s
 * `loadEvaluatorConfig()`: that loader is memoized per resolved path
 * (design decision 7 of `sdd/magi-evaluator-config-layer/design`), which is
 * correct for a one-shot CLI process but would show stale data after a TUI
 * save-then-reread in the same long-lived process. `readConfigFile` below
 * always re-reads and re-parses the file from disk — no caching, ever.
 *
 * Writes replace only the top-level `evaluators` key, preserving every
 * other key (`tiers`, `paths`, `_note`, ...) byte-for-byte in meaning, and
 * NEVER open the target file for writing when it is missing or unparseable
 * — see `writeEvaluatorsSection` below (design decisions 3, 4, 5).
 */

const EVALUATOR_NAMES: readonly EvaluatorName[] = ['melchior', 'balthasar', 'casper'];
const SETTINGS_FIELDS = ['backend', 'model', 'timeoutMs', 'maxTokens'] as const;

export type ConfigFileRead =
  | { status: 'missing'; path: string }
  | { status: 'unparseable'; path: string; message: string }
  | { status: 'ok'; path: string; raw: Record<string, unknown>; text: string; indent: string | number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * First indented line of `text` determines the indent unit: an all-tab
 * run of leading whitespace returns `'\t'`, an all-space run returns its
 * length as a number. No indented line found (e.g. minified JSON) falls
 * back to `2`, matching `JSON.stringify`'s own common default.
 */
export function detectIndent(text: string): string | number {
  for (const line of text.split('\n')) {
    const match = /^([\t ]+)\S/.exec(line);
    if (match) {
      const whitespace = match[1] ?? '';
      return whitespace.includes('\t') ? '\t' : whitespace.length;
    }
  }
  return 2;
}

/**
 * NEVER throws. Missing file -> `missing`; invalid JSON or a non-object
 * top-level value -> `unparseable` (with the parse/shape failure message);
 * otherwise -> `ok` with the parsed object, the raw text, and the detected
 * indent. Always reads the file fresh — no memoization.
 */
export function readConfigFile(configPath: string): ConfigFileRead {
  if (!fs.existsSync(configPath)) {
    return { status: 'missing', path: configPath };
  }

  const text = fs.readFileSync(configPath, 'utf8');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'unparseable', path: configPath, message: describeError(error) };
  }

  if (!isRecord(raw)) {
    return { status: 'unparseable', path: configPath, message: 'top-level JSON value is not an object' };
  }

  return { status: 'ok', path: configPath, raw, text, indent: detectIndent(text) };
}

function hasAnySetField(entry: EvaluatorSettings): boolean {
  return SETTINGS_FIELDS.some((field) => entry[field] !== undefined);
}

/**
 * Per-evaluator entries with no set field are omitted from the result; if
 * every evaluator ends up empty, returns `undefined` so the caller deletes
 * the `evaluators` key entirely rather than writing `"evaluators": {}`
 * (design decision 5 — keeps "unset means default" true on disk).
 */
export function normalizeEvaluators(pending: EvaluatorsConfig): EvaluatorsConfig | undefined {
  const result: EvaluatorsConfig = {};
  for (const name of EVALUATOR_NAMES) {
    const entry = pending[name];
    if (entry !== undefined && hasAnySetField(entry)) {
      result[name] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Atomic tmp+rename write of the `evaluators` key only. Re-reads and
 * re-parses `configPath` at write time (never trusts a prior `readConfigFile`
 * result), and never opens the target file for writing on a refusal path
 * (missing / unparseable) — every refusal leaves the file byte-identical.
 * On any failure after the tmp file was created, it is removed.
 */
export function writeEvaluatorsSection(
  configPath: string,
  evaluators: EvaluatorsConfig,
): { ok: true } | { ok: false; message: string } {
  const current = readConfigFile(configPath);

  if (current.status === 'missing') {
    return { ok: false, message: `${configPath} does not exist — nothing to save into.` };
  }
  if (current.status === 'unparseable') {
    return {
      ok: false,
      message: `${configPath} is not valid JSON, refusing to overwrite: ${current.message}`,
    };
  }

  const obj = current.raw;
  const normalized = normalizeEvaluators(evaluators);
  if (normalized === undefined) {
    delete obj.evaluators;
  } else {
    obj.evaluators = normalized;
  }

  const text = `${JSON.stringify(obj, null, current.indent)}\n`;
  const dir = path.dirname(configPath);
  const tmpPath = path.join(dir, `.magi.config.json.tmp-${process.pid}`);

  try {
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, configPath);
    return { ok: true };
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only — the write already failed.
    }
    return { ok: false, message: `failed to write ${configPath}: ${describeError(error)}` };
  }
}
