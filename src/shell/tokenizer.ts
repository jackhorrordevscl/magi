/**
 * Pure, deterministic shell-string tokenizer helpers. No I/O, no model
 * calls — shared by `src/shell/command-parser.ts`.
 *
 * These are intentionally small and conservative: this is NOT a full
 * POSIX shell grammar. The goal is only to reliably (a) split top-level
 * compound commands on `&&`, `||`, `;`, `|` while respecting quoting, and
 * (b) split an individual segment into whitespace-separated words while
 * respecting quoting — and to fail closed (report "unbalanced") whenever
 * quoting can't be resolved, rather than guessing.
 */

const TOP_LEVEL_SEPARATORS = ['&&', '||'] as const;

export interface TopLevelSplitResult {
  /** Raw segments between top-level separators, in order, untrimmed. */
  segments: string[];
  /** True when quoting could not be balanced across the whole input. */
  unbalancedQuotes: boolean;
}

/**
 * Splits `input` on top-level `&&`, `||`, `;`, `|` separators, ignoring
 * anything inside single or double quotes.
 */
export function splitTopLevel(input: string): TopLevelSplitResult {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < input.length) {
    const ch = input[i] as string;

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    const two = input.slice(i, i + 2);
    if ((TOP_LEVEL_SEPARATORS as readonly string[]).includes(two)) {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }

    if (ch === ';' || ch === '|') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  segments.push(current);

  return { segments, unbalancedQuotes: quote !== null };
}

export interface WordSplitResult {
  words: string[];
  unbalancedQuotes: boolean;
}

/**
 * Splits a single command segment into words on whitespace, stripping
 * (but respecting) single/double quotes. Quote characters themselves are
 * removed from the resulting word text.
 */
export function splitWords(segment: string): WordSplitResult {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      inWord = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }

    current += ch;
    inWord = true;
  }

  if (inWord) words.push(current);

  return { words, unbalancedQuotes: quote !== null };
}
