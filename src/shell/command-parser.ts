import { splitTopLevel, splitWords } from './tokenizer.ts';

/**
 * Pure, deterministic shell-command parser. No I/O, no model calls.
 *
 * Decomposes compound shell commands (`&&`, `||`, `;`, `|` chains, env-var
 * prefixes) into discrete sub-commands, and classifies argument-like file
 * paths so downstream severity logic never conflates "referencing a
 * doc-like file" with "invoking arbitrary executable code". When a
 * command genuinely can't be parsed (e.g. unbalanced quoting), this module
 * returns a sentinel result rather than guessing — downstream severity
 * logic (`src/gating/severity.ts`) treats that sentinel as a forcing
 * function for the High tier.
 */

export type PathClassification = 'doc' | 'script' | 'unknown';

export interface ReferencedPath {
  path: string;
  classification: PathClassification;
}

export interface SubCommand {
  /** The trimmed, original text of this sub-command segment. */
  raw: string;
  /** Leading `VAR=value` assignments preceding the executable. */
  envPrefix: Record<string, string>;
  executable: string;
  args: string[];
  /** Non-flag arguments, classified so doc-like paths aren't mistaken for scripts. */
  referencedPaths: ReferencedPath[];
}

export interface ParsedShellCommandOk {
  ok: true;
  subCommands: SubCommand[];
}

export interface ParsedShellCommandUnparseable {
  ok: false;
  /** Machine-readable sentinel reason — used by severity.ts to force High. */
  reason: string;
  raw: string;
}

export type ParsedShellCommand = ParsedShellCommandOk | ParsedShellCommandUnparseable;

// --- Path classification -----------------------------------------------

/** Basenames that are always documentation/config, never "executable code". */
const DOC_BASENAME_EXACT = new Set(['cmakelists.txt']);

const DOC_BASENAME_PATTERNS: RegExp[] = [
  /^readme(\..+)?$/i,
  /^requirements(-[\w.]+)?\.txt$/i,
  /^changelog(\..+)?$/i,
  /^license(\..+)?$/i,
];

/** `.github/workflows/*.yml` / `*.yaml` are CI config, not arbitrary scripts. */
const WORKFLOW_PATH_PATTERN = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.pl',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.ps1',
  '.bat',
  '.cmd',
  '.fish',
]);

const DOC_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.rst',
  '.json',
  '.toml',
  '.cfg',
  '.ini',
  '.lock',
  '.yml',
  '.yaml',
]);

/**
 * Classifies a path-like string as documentation/config (`doc`), an
 * executable script (`script`), or `unknown`. Basename overrides (e.g.
 * `README.sh`, `.github/workflows/*.yml`) are checked BEFORE extension
 * rules, so a doc-like filename is never misclassified as arbitrary
 * executable code just because it happens to carry a script extension.
 */
export function classifyPath(rawPath: string): PathClassification {
  const normalized = rawPath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  const lowerBasename = basename.toLowerCase();

  if (DOC_BASENAME_EXACT.has(lowerBasename)) return 'doc';
  if (DOC_BASENAME_PATTERNS.some((re) => re.test(basename))) return 'doc';
  if (WORKFLOW_PATH_PATTERN.test(normalized)) return 'doc';

  const extMatch = /\.[^./]+$/.exec(basename);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (DOC_EXTENSIONS.has(ext)) return 'doc';

  return 'unknown';
}

// --- Command decomposition ----------------------------------------------

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseSegment(rawSegment: string): SubCommand | null {
  const trimmed = rawSegment.trim();
  if (trimmed.length === 0) return null;

  const { words, unbalancedQuotes } = splitWords(trimmed);
  if (unbalancedQuotes || words.length === 0) return null;

  const envPrefix: Record<string, string> = {};
  let idx = 0;
  while (idx < words.length && ENV_ASSIGNMENT_PATTERN.test(words[idx] as string)) {
    const word = words[idx] as string;
    const eq = word.indexOf('=');
    envPrefix[word.slice(0, eq)] = word.slice(eq + 1);
    idx += 1;
  }

  // Env assignments with no following executable can't be resolved to a command.
  if (idx >= words.length) return null;

  const executable = words[idx] as string;
  const args = words.slice(idx + 1);
  const referencedPaths: ReferencedPath[] = args
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => ({ path: arg, classification: classifyPath(arg) }));

  return { raw: trimmed, envPrefix, executable, args, referencedPaths };
}

/**
 * Parses a (possibly compound) shell command string into discrete
 * sub-commands. Returns a sentinel `{ ok: false }` result — never throws —
 * when the input can't be reliably decomposed.
 */
export function parseShellCommand(input: string): ParsedShellCommand {
  const { segments, unbalancedQuotes } = splitTopLevel(input);

  if (unbalancedQuotes) {
    return { ok: false, reason: 'unbalanced_quotes', raw: input };
  }

  const subCommands: SubCommand[] = [];
  for (const segment of segments) {
    const sub = parseSegment(segment);
    if (sub === null) {
      return { ok: false, reason: 'empty_or_dangling_segment', raw: input };
    }
    subCommands.push(sub);
  }

  if (subCommands.length === 0) {
    return { ok: false, reason: 'empty_command', raw: input };
  }

  return { ok: true, subCommands };
}
