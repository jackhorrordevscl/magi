import readline from 'node:readline/promises';
import { CalibrationCorpus } from '../calibration/corpus.ts';
import { runDivergenceHarness } from '../calibration/divergence-harness.ts';
import { SeverityTierSchema } from '../gating/proposed-action.ts';
import type { CalibrationEntry, CalibrationEntryInput } from '../calibration/corpus-schema.ts';
import type { DivergenceFixture, DivergenceReport } from '../calibration/divergence-harness.ts';
import type { EvaluatorPort } from '../gating/evaluator-port.ts';

/**
 * Library functions backing the `magi calibrate` / `magi calibrate import`
 * / `magi calibrate verify` CLI commands. Argv parsing and binary/exit-code
 * wiring (`src/cli/main.ts`) are deferred to the Phase 9 hook-adapter PR —
 * same pattern already established by `src/audit/verify.ts`'s
 * `verifyChain()` (backing `magi audit verify`) in PR2: this PR proves the
 * command's real behavior directly, without shipping an unrelated binary
 * entrypoint file.
 *
 * Every write path here requires an explicit human confirmation — corpus
 * entries are NEVER auto-labeled by a model (per design decision #1009).
 */

/** Minimal I/O surface the interview/import flows depend on, so tests never touch real stdin/stdout. */
export interface CalibrateIO {
  ask(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  write(line: string): void;
}

/** Real stdin/stdout-backed `CalibrateIO`, for actual interactive use (not exercised by tests). */
export function createStdioCalibrateIO(): CalibrateIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question: string): Promise<string> {
      return rl.question(`${question} `);
    },
    async confirm(question: string): Promise<boolean> {
      const answer = await rl.question(`${question} (y/n) `);
      return answer.trim().toLowerCase().startsWith('y');
    },
    write(line: string): void {
      process.stdout.write(`${line}\n`);
    },
  };
}

export interface CalibrateInterviewOptions {
  corpus?: CalibrationCorpus;
  io: CalibrateIO;
  now?: Date;
}

/**
 * `magi calibrate` — interviews the human operator for one calibration
 * exemplar (tag, severity, judgment narrative), then asks for explicit
 * confirmation before writing it to the corpus. Returns `null` (nothing
 * written) when the operator declines.
 */
export async function runCalibrateInterview(options: CalibrateInterviewOptions): Promise<CalibrationEntry | null> {
  const corpus = options.corpus ?? new CalibrationCorpus();
  const now = options.now ?? new Date();
  const { io } = options;

  const tag = await io.ask('Tag for this exemplar (e.g. "force-push-protected-branch"):');
  const severityRaw = await io.ask('Severity (low/medium/high/critical):');
  const severityResult = SeverityTierSchema.safeParse(severityRaw.trim());
  if (!severityResult.success) {
    io.write(`Invalid severity "${severityRaw}" — expected one of low/medium/high/critical. Aborted, nothing added.`);
    return null;
  }
  const exemplar = await io.ask('Describe the judgment call, in your own words:');

  io.write('---');
  io.write(`Tag: ${tag}`);
  io.write(`Severity: ${severityResult.data}`);
  io.write(`Exemplar: ${exemplar}`);
  io.write('---');

  const confirmed = await io.confirm('Add this entry to the calibration corpus?');
  if (!confirmed) {
    io.write('Declined — nothing added.');
    return null;
  }

  const entry = corpus.add({ tag, severity: severityResult.data, exemplar }, now);
  io.write(`Added (contentHash ${entry.contentHash}).`);
  return entry;
}

export interface CalibrateImportOptions {
  /** Candidate entries to review one at a time, e.g. parsed from past review comments. Never written without per-entry confirmation. */
  candidates: CalibrationEntryInput[];
  corpus?: CalibrationCorpus;
  io: CalibrateIO;
  now?: Date;
}

/**
 * `magi calibrate import` — reviews each candidate entry and asks for
 * explicit per-entry confirmation before writing it to the corpus, exactly
 * like the interview flow. Returns only the entries that were actually
 * confirmed and added; declined candidates are skipped, never written.
 */
export async function runCalibrateImport(options: CalibrateImportOptions): Promise<CalibrationEntry[]> {
  const corpus = options.corpus ?? new CalibrationCorpus();
  const now = options.now ?? new Date();
  const { io } = options;

  const added: CalibrationEntry[] = [];
  for (const candidate of options.candidates) {
    io.write('---');
    io.write(`Tag: ${candidate.tag}`);
    io.write(`Severity: ${candidate.severity}`);
    io.write(`Exemplar: ${candidate.exemplar}`);
    io.write('---');

    if (corpus.has(candidate)) {
      io.write('Already present in the corpus (identical content) — skipping.');
      continue;
    }

    const confirmed = await io.confirm('Import this entry into the calibration corpus?');
    if (!confirmed) {
      io.write('Declined — skipped.');
      continue;
    }

    added.push(corpus.add(candidate, now));
  }

  io.write(`Imported ${added.length} of ${options.candidates.length} candidate(s).`);
  return added;
}

export interface CalibrateVerifyOptions {
  evaluators: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort];
  fixtures: readonly DivergenceFixture[];
  divergenceFloorPercent: number;
  write?: (line: string) => void;
}

/**
 * `magi calibrate verify` — runs the divergence harness (see
 * `src/calibration/divergence-harness.ts`) against real evaluators and
 * designed fixtures, and prints a human-readable pass/fail summary.
 * Callers (the eventual Phase 9 `main.ts`) map `report.pass` to the
 * process exit code; this function itself never calls `process.exit`.
 */
export async function runCalibrateVerify(options: CalibrateVerifyOptions): Promise<DivergenceReport> {
  const write = options.write ?? (() => {});
  const report = await runDivergenceHarness(options.evaluators, options.fixtures, options.divergenceFloorPercent);

  write(
    `Divergent fixtures: ${(report.divergentFixturesDivergenceRate * 100).toFixed(1)}% diverged ` +
      `(floor ${options.divergenceFloorPercent}%) — ${report.divergenceFloorMet ? 'MET' : 'NOT MET'}`,
  );
  write(
    `Control fixtures: ${(report.controlFixturesUnanimityRate * 100).toFixed(1)}% unanimous — ` +
      `${report.controlsAllUnanimous ? 'ALL UNANIMOUS' : 'NOT ALL UNANIMOUS'}`,
  );
  write(report.pass ? 'PASS' : 'FAIL');

  return report;
}
