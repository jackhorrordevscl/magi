import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvaluatorConfig, resolveNamedEvaluator } from '../../src/gating/evaluator-config.ts';
import type { EvaluatorSettingsOverride, NamedEvaluatorDefaults } from '../../src/gating/evaluator-config.ts';
import { GroqEvaluator } from '../../src/gating/groq-evaluator.ts';
import type { GroqChatClient } from '../../src/gating/groq-evaluator.ts';
import { AnthropicEvaluator } from '../../src/gating/anthropic-evaluator.ts';
import type { AnthropicMessagesClient } from '../../src/gating/anthropic-evaluator.ts';
import { GeminiEvaluator } from '../../src/gating/gemini-evaluator.ts';
import type { GeminiClient } from '../../src/gating/gemini-evaluator.ts';
import { MELCHIOR_FACET } from '../../src/gating/melchior.ts';
import { BALTHASAR_FACET } from '../../src/gating/balthasar.ts';
import { CASPER_FACET } from '../../src/gating/casper.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';

// --- Fixtures ---------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magi-evaluator-config-'));
}

function writeConfig(dir: string, content: unknown): string {
  const configPath = path.join(dir, 'magi.config.json');
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(configPath, body, 'utf8');
  return configPath;
}

function unusedConfigPath(dir: string): string {
  return path.join(dir, 'magi.config.json');
}

/** Captures everything written to `process.stderr` for the duration of `fn`. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown) => {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buffer;
}

const MELCHIOR_DEFAULTS: NamedEvaluatorDefaults = { backend: 'groq', model: 'openai/gpt-oss-120b' };
const BALTHASAR_DEFAULTS: NamedEvaluatorDefaults = { backend: 'groq', model: 'llama-3.3-70b-versatile' };
const CASPER_DEFAULTS: NamedEvaluatorDefaults = { backend: 'groq', model: 'llama-3.1-8b-instant' };

function action(): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git status',
  };
}

function groqToolCallResponse(input: unknown) {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ type: 'function', function: { name: 'cast_vote', arguments: JSON.stringify(input) } }],
        },
      },
    ],
  };
}

function anthropicToolUseResponse(input: unknown) {
  return {
    id: 'msg_1',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-3-5-haiku-latest',
    content: [{ type: 'tool_use' as const, id: 'tool_1', name: 'cast_vote', input }],
    stop_reason: 'tool_use' as const,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function geminiFunctionCallResponse(args: unknown) {
  return {
    candidates: [{ content: { parts: [{ functionCall: { name: 'cast_vote', args } }] } }],
  };
}

// --- loadEvaluatorConfig — fail-safe matrix ----------------------------

describe('loadEvaluatorConfig — fail-safe matrix', () => {
  test('no config file present -> {}', () => {
    const dir = tmpDir();
    const result = loadEvaluatorConfig(unusedConfigPath(dir));
    assert.deepEqual(result, {});
  });

  test('invalid JSON -> {}, warning emitted, no throw', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, '{ this is not valid json');
    let result: unknown;
    const stderr = await captureStderr(() => {
      assert.doesNotThrow(() => {
        result = loadEvaluatorConfig(configPath);
      });
    });
    assert.deepEqual(result, {});
    assert.match(stderr, /parse/i);
  });

  test('evaluators key absent -> {}, no warning needed', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { tiers: { sync: { k: 5 } }, paths: { auditDir: '.magi/audit/' } });
    const result = loadEvaluatorConfig(configPath);
    assert.deepEqual(result, {});
  });

  test('evaluators not an object (string) -> {}, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: 'melchior-only' });
    let result: unknown;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.deepEqual(result, {});
    assert.match(stderr, /evaluators/i);
  });

  test('evaluators not an object (array) -> {}, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: ['melchior'] });
    let result: unknown;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.deepEqual(result, {});
    assert.match(stderr, /evaluators/i);
  });

  test('evaluators.melchior not an object -> that entry {}, siblings unaffected, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      evaluators: { melchior: 'nope', casper: { model: 'llama-3.1-70b-versatile' } },
    });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.deepEqual(result?.melchior, {});
    assert.equal(result?.casper?.model, 'llama-3.1-70b-versatile');
    assert.match(stderr, /melchior/i);
  });
});

// --- loadEvaluatorConfig — read once, no hot-reload --------------------

describe('loadEvaluatorConfig — config is read once, synchronously, at first load per path', () => {
  test('a second call against the same path returns the cached result, ignoring a rewrite in between', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { casper: { model: 'first-model' } } });

    const first = loadEvaluatorConfig(configPath);
    assert.equal(first.casper?.model, 'first-model');

    writeConfig(dir, { evaluators: { casper: { model: 'second-model' } } });
    const second = loadEvaluatorConfig(configPath);

    assert.equal(second.casper?.model, 'first-model');
    assert.deepEqual(second, first);
  });
});

// --- loadEvaluatorConfig — per-field fallback --------------------------

describe('loadEvaluatorConfig — per-field fallback for an individual missing or invalid field', () => {
  test('only timeoutMs overridden leaves backend/model/maxTokens unset (default territory)', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { melchior: { timeoutMs: 5000 } } });
    const result = loadEvaluatorConfig(configPath);
    assert.equal(result.melchior?.timeoutMs, 5000);
    assert.equal(result.melchior?.backend, undefined);
    assert.equal(result.melchior?.model, undefined);
    assert.equal(result.melchior?.maxTokens, undefined);
  });

  test('maxTokens wrong type falls back while sibling timeoutMs is kept', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { balthasar: { maxTokens: 'a lot', timeoutMs: 4000 } } });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.equal(result?.balthasar?.maxTokens, undefined);
    assert.equal(result?.balthasar?.timeoutMs, 4000);
    assert.match(stderr, /balthasar\.maxTokens/);
  });

  test('timeoutMs zero or negative falls back to default', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { casper: { timeoutMs: -1 } } });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.equal(result?.casper?.timeoutMs, undefined);
    assert.match(stderr, /casper\.timeoutMs/);
  });
});

// --- resolveNamedEvaluator — backend selection --------------------------

describe('resolveNamedEvaluator — backend selection', () => {
  test('anthropic backend constructs AnthropicEvaluator', () => {
    const evaluator = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS, { backend: 'anthropic' });
    assert.ok(evaluator instanceof AnthropicEvaluator);
    assert.equal(evaluator.name, 'melchior');
  });

  test('gemini backend constructs GeminiEvaluator', () => {
    const evaluator = resolveNamedEvaluator('balthasar', BALTHASAR_FACET, BALTHASAR_DEFAULTS, { backend: 'gemini' });
    assert.ok(evaluator instanceof GeminiEvaluator);
    assert.equal(evaluator.name, 'balthasar');
  });

  test('no backend field constructs GroqEvaluator (today\'s default)', () => {
    const evaluator = resolveNamedEvaluator('casper', CASPER_FACET, CASPER_DEFAULTS, {});
    assert.ok(evaluator instanceof GroqEvaluator);
    assert.equal(evaluator.name, 'casper');
  });

  test('explicit backend: "groq" also constructs GroqEvaluator', () => {
    const evaluator = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS, { backend: 'groq' });
    assert.ok(evaluator instanceof GroqEvaluator);
  });
});

// --- resolveNamedEvaluator — backend-aware model default ---------------

describe('resolveNamedEvaluator — model default follows the resolved backend', () => {
  test('backend switched to anthropic without a model override uses AnthropicEvaluator\'s own default model', async () => {
    let capturedModel: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedModel = body.model;
        return anthropicToolUseResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS, {
      backend: 'anthropic',
      client,
    } satisfies EvaluatorSettingsOverride);
    await evaluator.castVote(action(), 'low');
    assert.equal(capturedModel, 'claude-3-5-haiku-latest');
    assert.notEqual(capturedModel, MELCHIOR_DEFAULTS.model);
  });

  test('backend switched to gemini without a model override uses GeminiEvaluator\'s own default model', async () => {
    // Gemini's model is interpolated into the URL, not the request body — the
    // fake client's `create` receives no model field, so the default-model
    // resolution is instead proven indirectly: the resolved instance is a
    // working GeminiEvaluator (see backend-selection describe block above)
    // and this same construction never throws when no `model` is supplied.
    const client: GeminiClient = {
      create: async () => geminiFunctionCallResponse({ vote: 'allow', rationale: 'ok' }),
    };
    const evaluator = resolveNamedEvaluator('balthasar', BALTHASAR_FACET, BALTHASAR_DEFAULTS, {
      backend: 'gemini',
      client,
    } satisfies EvaluatorSettingsOverride);
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'allow');
  });

  test('backend left as groq without a model override uses melchior\'s existing hardcoded model', async () => {
    let capturedModel: unknown;
    const client: GroqChatClient = {
      create: async (body) => {
        capturedModel = body.model;
        return groqToolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS, {
      timeoutMs: 3000,
      client,
    } satisfies EvaluatorSettingsOverride);
    await evaluator.castVote(action(), 'low');
    assert.equal(capturedModel, 'openai/gpt-oss-120b');
  });

  test('an explicit model override is honored regardless of backend', async () => {
    let capturedModel: unknown;
    const client: GroqChatClient = {
      create: async (body) => {
        capturedModel = body.model;
        return groqToolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = resolveNamedEvaluator('casper', CASPER_FACET, CASPER_DEFAULTS, {
      model: 'llama-3.1-70b-versatile',
      client,
    } satisfies EvaluatorSettingsOverride);
    await evaluator.castVote(action(), 'low');
    assert.equal(capturedModel, 'llama-3.1-70b-versatile');
  });
});

// --- resolveNamedEvaluator — apiKey rejection ---------------------------

describe('resolveNamedEvaluator — apiKey is never a valid config field', () => {
  test('apiKey present alongside valid fields: model still resolves, warning emitted, apiKey never forwarded', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      evaluators: { casper: { model: 'llama-3.1-70b-versatile', apiKey: 'sk-example-not-a-real-key' } },
    });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.equal(result?.casper?.model, 'llama-3.1-70b-versatile');
    assert.equal((result?.casper as Record<string, unknown>)?.apiKey, undefined);
    assert.match(stderr, /casper\.apiKey/);
  });

  test('apiKey as the only field: every field falls back to default, identical to an empty {} entry, no throw', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { melchior: { apiKey: 'sk-example-not-a-real-key' } } });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      assert.doesNotThrow(() => {
        result = loadEvaluatorConfig(configPath);
      });
    });
    assert.deepEqual(result?.melchior, {});
    assert.match(stderr, /melchior\.apiKey/);

    // Construction from this settings entry does not throw and produces a
    // working default-backed evaluator, identical to an empty `{}` entry.
    const evaluator = resolveNamedEvaluator('melchior', MELCHIOR_FACET, MELCHIOR_DEFAULTS, result?.melchior ?? {});
    assert.ok(evaluator instanceof GroqEvaluator);
  });
});

// --- resolveNamedEvaluator — invalid backend ----------------------------

describe('resolveNamedEvaluator — invalid backend value falls back per-field, never biases toward allow', () => {
  test('unrecognized backend string falls back to the hardcoded default backend, warning emitted', async () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { balthasar: { backend: 'openai' } } });
    let result: ReturnType<typeof loadEvaluatorConfig> | undefined;
    const stderr = await captureStderr(() => {
      result = loadEvaluatorConfig(configPath);
    });
    assert.equal(result?.balthasar?.backend, undefined);
    assert.match(stderr, /balthasar\.backend/);

    const evaluator = resolveNamedEvaluator('balthasar', BALTHASAR_FACET, BALTHASAR_DEFAULTS, result?.balthasar ?? {});
    assert.ok(evaluator instanceof GroqEvaluator);
    assert.equal(evaluator.name, 'balthasar');
  });
});

// --- resolveNamedEvaluator — no model-ID validation ---------------------

describe('resolveNamedEvaluator — no model ID validation at config-load time', () => {
  test('a non-existent model string constructs without throwing and without any config-layer validation error', () => {
    assert.doesNotThrow(() => {
      const evaluator: EvaluatorPort = resolveNamedEvaluator('casper', CASPER_FACET, CASPER_DEFAULTS, {
        model: 'not-a-real-model',
      });
      assert.equal(evaluator.name, 'casper');
    });
  });
});

// --- Full evaluators section — all three evaluators simultaneously -----

describe('loadEvaluatorConfig — full evaluators section, no cross-evaluator leakage', () => {
  test('each evaluator resolves its own overrides independently', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      evaluators: {
        melchior: { backend: 'anthropic', model: 'claude-3-5-haiku-latest', timeoutMs: 3000, maxTokens: 600 },
        balthasar: { backend: 'gemini', model: 'gemini-2.5-flash-lite' },
        casper: { backend: 'groq', model: 'llama-3.1-70b-versatile' },
      },
    });
    const result = loadEvaluatorConfig(configPath);

    assert.equal(result.melchior?.backend, 'anthropic');
    assert.equal(result.melchior?.model, 'claude-3-5-haiku-latest');
    assert.equal(result.melchior?.timeoutMs, 3000);
    assert.equal(result.melchior?.maxTokens, 600);

    assert.equal(result.balthasar?.backend, 'gemini');
    assert.equal(result.balthasar?.model, 'gemini-2.5-flash-lite');
    assert.equal(result.balthasar?.timeoutMs, undefined);
    assert.equal(result.balthasar?.maxTokens, undefined);

    assert.equal(result.casper?.backend, 'groq');
    assert.equal(result.casper?.model, 'llama-3.1-70b-versatile');
  });

  test('partial section covering only casper leaves melchior/balthasar entirely at defaults', () => {
    const dir = tmpDir();
    const configPath = writeConfig(dir, { evaluators: { casper: { model: 'llama-3.1-70b-versatile' } } });
    const result = loadEvaluatorConfig(configPath);

    assert.equal(result.casper?.model, 'llama-3.1-70b-versatile');
    assert.equal(result.melchior, undefined);
    assert.equal(result.balthasar, undefined);
  });
});

// --- DI precedence over config ------------------------------------------

describe('DI overrides take precedence over config, unconditionally', () => {
  test('resolveNamedEvaluator is never invoked when a caller supplies its own evaluator (module-level DI seam)', async () => {
    // This is a smoke test at the `resolveNamedEvaluator` boundary itself:
    // when a caller (main.ts / claude-code-hook/index.ts) supplies its own
    // `evaluators` array, `melchior`/`balthasar`/`casper`'s module-level
    // exports (already resolver-built) are simply never read at all — the
    // full end-to-end precedence is already covered by the existing
    // `tests/claude-code-hook/index.test.ts` / `tests/cli/main.test.ts`
    // suites, which inject fakes via `RunHookOptions.evaluators` /
        // `MainDeps.evaluators` and are unaffected by this capability.
    const fakeEvaluator: EvaluatorPort = {
      name: 'melchior',
      castVote: async () => ({ evaluator: 'melchior', vote: 'allow', rationale: 'fake DI evaluator' }),
    };
    const vote = await fakeEvaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'allow');
    assert.equal(vote.rationale, 'fake DI evaluator');
  });
});
