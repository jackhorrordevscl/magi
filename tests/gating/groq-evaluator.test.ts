import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GroqEvaluator } from '../../src/gating/groq-evaluator.ts';
import type { GroqChatClient } from '../../src/gating/groq-evaluator.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

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

function toolCallResponse(input: unknown, toolName = 'cast_vote') {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  };
}

describe('GroqEvaluator — conforming responses', () => {
  test('a well-formed cast_vote tool call produces the corresponding vote', async () => {
    let callCount = 0;
    const client: GroqChatClient = {
      create: async () => {
        callCount += 1;
        return toolCallResponse({ vote: 'allow', rationale: 'looks fine' }) as never;
      },
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.evaluator, 'melchior');
    assert.equal(vote.vote, 'allow');
    assert.equal(vote.rationale, 'looks fine');
    assert.equal(callCount, 1);
  });

  test('forces tool_choice to cast_vote and exposes no other tools', async () => {
    let capturedBody: unknown;
    const client: GroqChatClient = {
      create: async (body) => {
        capturedBody = body;
        return toolCallResponse({ vote: 'deny', rationale: 'nope' }) as never;
      },
    };
    const evaluator = new GroqEvaluator('balthasar', FACET, { client });
    await evaluator.castVote(action(), 'medium');

    const body = capturedBody as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: { type: string; function: { name: string } };
    };
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0]?.function.name, 'cast_vote');
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'cast_vote' } });
  });

  test('passes an AbortSignal through to the client call', async () => {
    let sawSignal = false;
    const client: GroqChatClient = {
      create: async (_body, options) => {
        sawSignal = options?.signal instanceof AbortSignal;
        return toolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new GroqEvaluator('casper', FACET, { client });
    await evaluator.castVote(action(), 'low');
    assert.equal(sawSignal, true);
  });
});

describe('GroqEvaluator — non-conforming output is denied, never repaired/retried', () => {
  test('no tool_calls at all -> deny, single call (no retry)', async () => {
    let callCount = 0;
    const client: GroqChatClient = {
      create: async () => {
        callCount += 1;
        return { choices: [{ message: {} }] } as never;
      },
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.vote, 'deny');
    assert.equal(vote.evaluator, 'melchior');
    assert.equal(callCount, 1);
  });

  test('wrong tool name -> deny, single call', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'allow', rationale: 'ok' }, 'some_other_tool') as never,
    };
    const evaluator = new GroqEvaluator('balthasar', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('non-JSON tool call arguments -> deny, single call', async () => {
    const client: GroqChatClient = {
      create: async () =>
        ({
          choices: [
            {
              message: {
                tool_calls: [{ type: 'function', function: { name: 'cast_vote', arguments: 'not json' } }],
              },
            },
          ],
        }) as never,
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('invalid vote enum value -> deny, single call', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'maybe', rationale: 'unsure' }) as never,
    };
    const evaluator = new GroqEvaluator('casper', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('missing rationale -> deny, single call', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'allow' }) as never,
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('empty rationale string -> deny, single call', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'allow', rationale: '' }) as never,
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });
});

describe('GroqEvaluator — fail-closed on timeout/error/non-2xx, never allow', () => {
  test('client throws synchronously/rejects -> deny', async () => {
    const client: GroqChatClient = {
      create: async () => {
        throw new Error('network down');
      },
    };
    const evaluator = new GroqEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'critical');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /fail-closed/);
  });

  test('non-2xx response (e.g. 429) -> deny', async () => {
    const client: GroqChatClient = {
      create: async () => {
        throw new Error('Groq API responded with non-2xx status 429');
      },
    };
    const evaluator = new GroqEvaluator('balthasar', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /429/);
  });

  test('client never resolves before the AbortSignal fires -> deny (timeout)', async () => {
    const client: GroqChatClient = {
      create: (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }) as never,
    };
    const evaluator = new GroqEvaluator('balthasar', FACET, { client, timeoutMs: 15 });
    const start = Date.now();
    const vote = await evaluator.castVote(action(), 'high');
    const elapsed = Date.now() - start;

    assert.equal(vote.vote, 'deny');
    assert.ok(elapsed < 500, `expected fast timeout-driven deny, took ${elapsed}ms`);
  });

  test('a timeout deny is never repaired into an allow, even if the client eventually would have allowed', async () => {
    const client: GroqChatClient = {
      create: (_body, options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(toolCallResponse({ vote: 'allow', rationale: 'late' }) as never), 200);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    };
    const evaluator = new GroqEvaluator('casper', FACET, { client, timeoutMs: 15 });
    const vote = await evaluator.castVote(action(), 'high');
    assert.equal(vote.vote, 'deny');
  });
});

describe('GroqEvaluator — evaluator identity', () => {
  test('name reflects the constructor argument', () => {
    const client: GroqChatClient = { create: async () => toolCallResponse({ vote: 'allow', rationale: 'ok' }) as never };
    const evaluator = new GroqEvaluator('casper', FACET, { client });
    assert.equal(evaluator.name, 'casper');
  });
});
