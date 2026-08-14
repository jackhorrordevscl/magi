import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiEvaluator } from '../../src/gating/gemini-evaluator.ts';
import type { GeminiClient } from '../../src/gating/gemini-evaluator.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';
import type { EvaluatorPort } from '../../src/gating/evaluator-port.ts';
import { BALTHASAR_FACET } from '../../src/gating/balthasar.ts';

function action(overrides: Partial<CodingAgentAction> = {}): CodingAgentAction {
  return {
    source: 'coding_agent',
    actor: 'test-agent',
    actionType: 'shell_exec',
    target: 'repo',
    environment: 'local',
    mode: 'shadow',
    command: 'git push --force origin main',
    ...overrides,
  };
}

const FACET = { description: 'fact/consistency', guidance: 'test guidance' };

function functionCallResponse(args: unknown, toolName = 'cast_vote') {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { name: toolName, args },
            },
          ],
        },
      },
    ],
  };
}

describe('GeminiEvaluator — conforming responses', () => {
  test('a well-formed cast_vote function call produces the corresponding vote', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return functionCallResponse({ vote: 'allow', rationale: 'looks fine' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.evaluator, 'melchior');
    assert.equal(vote.vote, 'allow');
    assert.equal(vote.rationale, 'looks fine');
    assert.equal(callCount, 1);
  });

  test('forces functionCallingConfig.mode to ANY and exposes only the cast_vote declaration', async () => {
    let capturedBody: unknown;
    const client: GeminiClient = {
      create: async (body) => {
        capturedBody = body;
        return functionCallResponse({ vote: 'deny', rationale: 'nope' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('balthasar', FACET, { client });
    await evaluator.castVote(action(), 'medium');

    const body = capturedBody as {
      tools: [{ functionDeclarations: Array<{ name: string }> }];
      toolConfig: { functionCallingConfig: { mode: string } };
    };
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0]?.functionDeclarations.length, 1);
    assert.equal(body.tools[0]?.functionDeclarations[0]?.name, 'cast_vote');
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  });

  test('passes an AbortSignal through to the client call', async () => {
    let sawSignal = false;
    const client: GeminiClient = {
      create: async (_body, options) => {
        sawSignal = options?.signal instanceof AbortSignal;
        return functionCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('casper', FACET, { client });
    await evaluator.castVote(action(), 'low');
    assert.equal(sawSignal, true);
  });

  test('new GeminiEvaluator with an unrecognized model id does not throw at construction', () => {
    assert.doesNotThrow(() => {
      new GeminiEvaluator('melchior', FACET, { model: 'not-a-real-model' });
    });
  });
});

describe('GeminiEvaluator — auth and URL', () => {
  test('default client sends x-goog-api-key, omits Authorization, and hits the interpolated model URL', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => functionCallResponse({ vote: 'allow', rationale: 'ok' }),
      } as Response;
    }) as typeof fetch;

    try {
      const evaluator = new GeminiEvaluator('melchior', FACET, { apiKey: 'test-key' });
      const vote = await evaluator.castVote(action(), 'low');

      assert.equal(vote.vote, 'allow');
      assert.ok(capturedUrl?.endsWith('/v1beta/models/gemini-2.5-flash-lite:generateContent'), capturedUrl);
      assert.equal(capturedHeaders?.['x-goog-api-key'], 'test-key');
      assert.equal((capturedHeaders as Record<string, string> | undefined)?.['authorization'], undefined);
      assert.equal((capturedHeaders as Record<string, string> | undefined)?.['Authorization'], undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a custom baseUrl is treated as a base path with the model interpolated into it', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;

    globalThis.fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => functionCallResponse({ vote: 'allow', rationale: 'ok' }),
      } as Response;
    }) as typeof fetch;

    try {
      const evaluator = new GeminiEvaluator('balthasar', FACET, {
        apiKey: 'test-key',
        baseUrl: 'https://example.test',
        model: 'gemini-custom-model',
      });
      await evaluator.castVote(action(), 'low');

      assert.equal(capturedUrl, 'https://example.test/v1beta/models/gemini-custom-model:generateContent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('GeminiEvaluator — evaluator identity', () => {
  test('name reflects the constructor argument', () => {
    const client: GeminiClient = {
      create: async () => functionCallResponse({ vote: 'allow', rationale: 'ok' }) as never,
    };
    const evaluator = new GeminiEvaluator('casper', FACET, { client });
    assert.equal(evaluator.name, 'casper');
  });

  test('new GeminiEvaluator is a drop-in EvaluatorPort implementation', async () => {
    const evaluator: EvaluatorPort = new GeminiEvaluator('balthasar', BALTHASAR_FACET, { apiKey: 'test-key' });
    assert.equal(evaluator.name, 'balthasar');
    assert.equal(typeof evaluator.castVote, 'function');
  });
});

describe('GeminiEvaluator — non-conforming output is denied, never repaired/retried', () => {
  test('no functionCall part at all -> deny, single call (no retry)', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return { candidates: [{ content: { parts: [] } }] } as never;
      },
    };
    const evaluator = new GeminiEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.vote, 'deny');
    assert.equal(vote.evaluator, 'melchior');
    assert.match(vote.rationale, /no cast_vote function call/);
    assert.equal(callCount, 1);
  });

  test('wrong functionCall name -> deny, single call', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return functionCallResponse({ vote: 'allow', rationale: 'ok' }, 'some_other_tool') as never;
      },
    };
    const evaluator = new GeminiEvaluator('balthasar', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.equal(callCount, 1);
  });

  test('args missing rationale -> deny, single call', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return functionCallResponse({ vote: 'allow' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /schema validation/);
    assert.equal(callCount, 1);
  });

  test('args.vote outside the enum -> deny, single call', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return functionCallResponse({ vote: 'maybe', rationale: 'unsure' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('casper', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.equal(callCount, 1);
  });

  test('empty-string rationale -> deny, single call', async () => {
    let callCount = 0;
    const client: GeminiClient = {
      create: async () => {
        callCount += 1;
        return functionCallResponse({ vote: 'allow', rationale: '' }) as never;
      },
    };
    const evaluator = new GeminiEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.equal(callCount, 1);
  });
});

describe('GeminiEvaluator — fail-closed on timeout/error/non-2xx, never allow', () => {
  test('client throws synchronously/rejects -> deny', async () => {
    const client: GeminiClient = {
      create: async () => {
        throw new Error('network down');
      },
    };
    const evaluator = new GeminiEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'critical');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /fail-closed/);
  });

  test('non-2xx response (e.g. 429) -> deny with rationale mentioning the status', async () => {
    const client: GeminiClient = {
      create: async () => {
        throw new Error('Gemini API responded with non-2xx status 429');
      },
    };
    const evaluator = new GeminiEvaluator('balthasar', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /429/);
  });

  test('client never resolves before the AbortSignal fires -> deny (timeout)', async () => {
    const client: GeminiClient = {
      create: (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }) as never,
    };
    const evaluator = new GeminiEvaluator('balthasar', FACET, { client, timeoutMs: 15 });
    const start = Date.now();
    const vote = await evaluator.castVote(action(), 'high');
    const elapsed = Date.now() - start;

    assert.equal(vote.vote, 'deny');
    assert.ok(elapsed < 500, `expected fast timeout-driven deny, took ${elapsed}ms`);
  });

  test('a timeout deny is never repaired into an allow, even if the client eventually would have allowed', async () => {
    const client: GeminiClient = {
      create: (_body, options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(functionCallResponse({ vote: 'allow', rationale: 'late' }) as never),
            200,
          );
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    };
    const evaluator = new GeminiEvaluator('casper', FACET, { client, timeoutMs: 15 });
    const vote = await evaluator.castVote(action(), 'high');
    assert.equal(vote.vote, 'deny');
  });
});
