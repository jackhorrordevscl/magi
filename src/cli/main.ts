#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCalibrateImport, runCalibrateInterview, runCalibrateVerify, createStdioCalibrateIO } from './calibrate.ts';
import { computeAuditStats, formatAuditStats } from './audit-stats.ts';
import { runAuditOverride } from './audit-override.ts';
import { verifyChain } from '../audit/verify.ts';
import { CalibrationCorpus } from '../calibration/corpus.ts';
import { melchior } from '../gating/melchior.ts';
import { balthasar } from '../gating/balthasar.ts';
import { casper } from '../gating/casper.ts';
import type { CalibrateIO } from './calibrate.ts';
import type { CalibrationEntryInput } from '../calibration/corpus-schema.ts';
import type { DivergenceFixture } from '../calibration/divergence-harness.ts';
import type { EvaluatorPort } from '../gating/evaluator-port.ts';

/**
 * The `magi` CLI binary — argv-parsing entrypoint wiring the library
 * functions PR3 already built and tested (`src/cli/calibrate.ts`,
 * `src/audit/verify.ts`) plus this PR's `src/cli/audit-stats.ts`.
 *
 * Commands:
 *   magi calibrate                        — interview flow (magi calibrate)
 *   magi calibrate import <file>          — import candidates from a JSON file
 *   magi calibrate verify --fixtures <f>  — run the divergence harness
 *   magi audit verify                     — replay + verify the hash chain
 *   magi audit stats                      — verdict distribution / deny-rate proxy
 *   magi audit override <hash> --reason "<why>" — document that a deny should be disregarded (append-only, non-mutating)
 *   magi tui                              — interactive evaluator-config / audit-summary TUI (src/cli/tui/app.ts)
 *
 * `runMain` is the testable dispatch function (returns an exit code rather
 * than calling `process.exit` itself); the bottom-of-file guard is the real
 * process entrypoint, same separation as `claude-code-hook/index.ts`.
 */

export interface MainIO {
  write(line: string): void;
  error(line: string): void;
}

const stdioMainIO: MainIO = {
  write: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

/**
 * `mode` is deliberately NOT a field here — per `sdd/magi-p3-enforcing-
 * override/spec` Requirement: Single Mode Source, the operating mode
 * resolves exclusively from the `MAGI_MODE` environment variable
 * (`claude-code-hook/index.ts`'s `resolveMode()`); `magi.config.json` MUST
 * NOT carry a `mode` key, and this type MUST NOT expose one.
 */
interface MagiConfig {
  tiers: { sync: { k: number }; async: { k: number }; divergenceFloorPercent: number };
  paths: { calibrationDir: string; auditDir: string };
}

const DEFAULT_CONFIG: MagiConfig = {
  tiers: { sync: { k: 5 }, async: { k: 12 }, divergenceFloorPercent: 40 },
  paths: { calibrationDir: '.magi/calibration/', auditDir: '.magi/audit/' },
};

/**
 * Loads `magi.config.json` (default: repo-root-relative `magi.config.json`)
 * for the CLI's own config-driven defaults (audit dir, divergence floor).
 * Falls back to `DEFAULT_CONFIG` when the file is missing — this mirrors
 * the same values `magi.config.json` ships with, so behavior is identical
 * either way; it just avoids a hard failure on an unusual working directory.
 */
function loadConfig(configPath = 'magi.config.json'): MagiConfig {
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as MagiConfig;
}

/** `magi tui`'s entrypoint options — `src/cli/tui/app.ts`'s `runTui`. */
export interface TuiOptions {
  configPath: string;
  auditDir: string;
}

export interface MainDeps {
  io?: MainIO;
  configPath?: string;
  auditDir?: string;
  corpus?: CalibrationCorpus;
  calibrateIO?: CalibrateIO;
  evaluators?: readonly [EvaluatorPort, EvaluatorPort, EvaluatorPort];
  /**
   * Testability seam for `magi tui` (design decision 10,
   * `sdd/magi-evaluator-config-tui/design`): when provided, `runMain`
   * dispatches to this instead of `await import('./tui/app.ts')`'s real
   * `runTui`, so `tests/cli/main.test.ts` can prove the dispatch branch —
   * including that nothing above it ever loads `blessed` — with no tty.
   */
  tui?: (options: TuiOptions) => Promise<number>;
}

/**
 * Argv-parsing dispatch for the `magi` CLI binary. All real I/O
 * (audit dir, calibration corpus, evaluators, stdio) is dependency-injected
 * via `deps`, defaulting to the real filesystem/network-backed
 * implementations — this is what makes every branch here directly
 * unit-testable (see `tests/cli/main.test.ts`) without touching the
 * network or a fixed on-disk path.
 */
export async function runMain(argv: string[], deps: MainDeps = {}): Promise<number> {
  const io = deps.io ?? stdioMainIO;
  const config = loadConfig(deps.configPath);
  const auditDir = deps.auditDir ?? config.paths.auditDir;
  const [command, subcommand, ...rest] = argv;

  if (command === 'calibrate') {
    return runCalibrateCommand(subcommand, rest, deps, io, config);
  }

  if (command === 'audit') {
    return runAuditCommand(subcommand, rest, auditDir, io);
  }

  if (command === 'tui') {
    // Lazily imported here so `blessed` (loaded inside `runTui()` itself —
    // see `src/cli/tui/app.ts`) never touches any other `magi` subcommand.
    const runTui = deps.tui ?? (await import('./tui/app.ts')).runTui;
    return runTui({ configPath: deps.configPath ?? 'magi.config.json', auditDir });
  }

  io.error(
    'Usage: magi <calibrate [import <file> | verify --fixtures <file>] | ' +
      'audit <verify | stats | override <hash> --reason "<why>"> | tui>',
  );
  return 1;
}

async function runCalibrateCommand(
  subcommand: string | undefined,
  rest: string[],
  deps: MainDeps,
  io: MainIO,
  config: MagiConfig,
): Promise<number> {
  // `corpus`/`calibrateIO` are constructed lazily, only inside the branches
  // that actually need them: `createStdioCalibrateIO()` opens a real
  // readline interface on stdin, which must never be created for a branch
  // (e.g. an unknown subcommand, or `verify`, which doesn't use it) that
  // never reaches it — an unused open stdin interface keeps the process
  // alive indefinitely instead of returning.
  if (subcommand === undefined) {
    const corpus = deps.corpus ?? new CalibrationCorpus(config.paths.calibrationDir);
    const calibrateIO = deps.calibrateIO ?? createStdioCalibrateIO();
    await runCalibrateInterview({ corpus, io: calibrateIO });
    return 0;
  }

  if (subcommand === 'import') {
    const filePath = rest[0];
    if (!filePath) {
      io.error('Usage: magi calibrate import <candidates.json>');
      return 1;
    }
    const corpus = deps.corpus ?? new CalibrationCorpus(config.paths.calibrationDir);
    const calibrateIO = deps.calibrateIO ?? createStdioCalibrateIO();
    const candidates = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CalibrationEntryInput[];
    await runCalibrateImport({ candidates, corpus, io: calibrateIO });
    return 0;
  }

  if (subcommand === 'verify') {
    const fixturesFlagIndex = rest.indexOf('--fixtures');
    const fixturesPath = fixturesFlagIndex >= 0 ? rest[fixturesFlagIndex + 1] : undefined;
    if (!fixturesPath) {
      io.error('Usage: magi calibrate verify --fixtures <fixtures.json>');
      io.error(
        'No built-in fixture set is shipped yet — author designed divergent/control fixtures from your own ' +
          'calibration corpus first (see the divergence-harness placeholder note in README.md).',
      );
      return 1;
    }
    const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as DivergenceFixture[];
    const evaluators = deps.evaluators ?? [melchior, balthasar, casper];
    const report = await runCalibrateVerify({
      evaluators,
      fixtures,
      divergenceFloorPercent: config.tiers.divergenceFloorPercent,
      write: io.write,
    });
    return report.pass ? 0 : 1;
  }

  io.error(`Unknown calibrate subcommand: ${subcommand}`);
  return 1;
}

function runAuditCommand(subcommand: string | undefined, rest: string[], auditDir: string, io: MainIO): number {
  if (subcommand === 'verify') {
    const result = verifyChain(auditDir);
    if (result.valid) {
      io.write('Audit chain valid.');
      return 0;
    }
    io.error(`Audit chain broken at seq ${result.brokenAtSeq ?? '?'}: ${result.reason ?? 'unknown reason'}`);
    return 1;
  }

  if (subcommand === 'stats') {
    const stats = computeAuditStats(auditDir);
    for (const line of formatAuditStats(stats)) io.write(line);
    return 0;
  }

  if (subcommand === 'override') {
    const targetHash = rest[0];
    if (!targetHash) {
      io.error('Usage: magi audit override <hash> --reason "<why>"');
      return 1;
    }
    const reasonFlagIndex = rest.indexOf('--reason');
    const reason = reasonFlagIndex >= 0 ? rest[reasonFlagIndex + 1] : undefined;

    const result = runAuditOverride({ auditDir, targetHash, reason: reason ?? '' });
    if (!result.ok) {
      io.error(`magi audit override failed: ${result.error ?? 'unknown error'}`);
      return 1;
    }
    io.write(`Override recorded: ${result.record?.hash ?? '(unknown hash)'} (targets ${targetHash})`);
    return 0;
  }

  io.error(`Unknown audit subcommand: ${subcommand}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`magi: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
