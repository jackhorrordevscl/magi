/**
 * Shared stderr logging helpers. Was re-declared verbatim in 8 files
 * (`evaluator-config.ts`, `tiers-config.ts`, `exemplar-injection.ts`,
 * `corpus.ts`, `groq-evaluator.ts`, `anthropic-evaluator.ts`,
 * `gemini-evaluator.ts`, `config-file.ts`) before this module existed —
 * a single copy stops those from re-diverging as more modules pick up
 * the same non-fatal-degrade-and-warn pattern.
 */

export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
