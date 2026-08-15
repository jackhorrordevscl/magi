import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicEvaluator } from '../../src/gating/anthropic-evaluator.ts';
import type { AnthropicMessagesClient } from '../../src/gating/anthropic-evaluator.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';
import type { CalibrationEntry } from '../../src/calibration/corpus-schema.ts';

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

function toolUseResponse(input: unknown, toolName = 'cast_vote') {
  return {
    id: 'msg_1',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-3-5-haiku-latest',
    content: [{ type: 'tool_use' as const, id: 'tool_1', name: toolName, input }],
    stop_reason: 'tool_use' as const,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('AnthropicEvaluator — conforming responses', () => {
  test('a well-formed cast_vote tool_use block produces the corresponding vote', async () => {
    let callCount = 0;
    const client: AnthropicMessagesClient = {
      create: async () => {
        callCount += 1;
        return toolUseResponse({ vote: 'allow', rationale: 'looks fine' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.evaluator, 'melchior');
    assert.equal(vote.vote, 'allow');
    assert.equal(vote.rationale, 'looks fine');
    assert.equal(callCount, 1);
  });

  test('forces tool_choice to cast_vote and exposes no other tools', async () => {
    let capturedBody: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedBody = body;
        return toolUseResponse({ vote: 'deny', rationale: 'nope' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('balthasar', FACET, { client });
    await evaluator.castVote(action(), 'medium');

    const body = capturedBody as {
      tools: Array<{ name: string }>;
      tool_choice: { type: string; name: string };
    };
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0]?.name, 'cast_vote');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'cast_vote' });
  });

  test('passes an AbortSignal through to the client call', async () => {
    let sawSignal = false;
    const client: AnthropicMessagesClient = {
      create: async (_body, options) => {
        sawSignal = options?.signal instanceof AbortSignal;
        return toolUseResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('casper', FACET, { client });
    await evaluator.castVote(action(), 'low');
    assert.equal(sawSignal, true);
  });
});

describe('AnthropicEvaluator — non-conforming output is denied, never repaired/retried', () => {
  test('no tool_use block at all -> deny, single call (no retry)', async () => {
    let callCount = 0;
    const client: AnthropicMessagesClient = {
      create: async () => {
        callCount += 1;
        return {
          id: 'msg_1',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'claude-3-5-haiku-latest',
          content: [{ type: 'text' as const, text: 'I refuse to vote.' }],
          stop_reason: 'end_turn' as const,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never;
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });

    const vote = await evaluator.castVote(action(), 'high');

    assert.equal(vote.vote, 'deny');
    assert.equal(vote.evaluator, 'melchior');
    assert.equal(callCount, 1);
  });

  test('wrong tool name -> deny, single call', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'allow', rationale: 'ok' }, 'some_other_tool') as never,
    };
    const evaluator = new AnthropicEvaluator('balthasar', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('invalid vote enum value -> deny, single call', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'maybe', rationale: 'unsure' }) as never,
    };
    const evaluator = new AnthropicEvaluator('casper', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('missing rationale -> deny, single call', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'allow' }) as never,
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });

  test('empty rationale string -> deny, single call', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'allow', rationale: '' }) as never,
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.vote, 'deny');
  });
});

describe('AnthropicEvaluator — fail-closed on timeout/error, never allow', () => {
  test('client throws synchronously/rejects -> deny', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => {
        throw new Error('network down');
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const vote = await evaluator.castVote(action(), 'critical');
    assert.equal(vote.vote, 'deny');
    assert.match(vote.rationale, /fail-closed/);
  });

  test('client never resolves before the AbortSignal fires -> deny (timeout)', async () => {
    const client: AnthropicMessagesClient = {
      create: (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }) as never,
    };
    const evaluator = new AnthropicEvaluator('balthasar', FACET, { client, timeoutMs: 15 });
    const start = Date.now();
    const vote = await evaluator.castVote(action(), 'high');
    const elapsed = Date.now() - start;

    assert.equal(vote.vote, 'deny');
    assert.ok(elapsed < 500, `expected fast timeout-driven deny, took ${elapsed}ms`);
  });

  test('a timeout deny is never repaired into an allow, even if the client eventually would have allowed', async () => {
    const client: AnthropicMessagesClient = {
      create: (_body, options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(toolUseResponse({ vote: 'allow', rationale: 'late' }) as never), 200);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    };
    const evaluator = new AnthropicEvaluator('casper', FACET, { client, timeoutMs: 15 });
    const vote = await evaluator.castVote(action(), 'high');
    assert.equal(vote.vote, 'deny');
  });
});

function calibrationEntry(overrides: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    tag: 'force-push-protected-branch',
    severity: 'critical',
    exemplar: 'Force-pushing to main destroys shared history for everyone else on the team; always deny.',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function baselineUserPrompt(a: CodingAgentAction, severity: string): string {
  return [
    `Actor: ${a.actor}`,
    `Action type: ${a.actionType}`,
    `Target: ${a.target}`,
    `Environment: ${a.environment}`,
    `Severity (orchestrator-classified): ${severity}`,
    `Command: ${a.command}`,
    'Cast your vote (allow / deny / abstain) with a rationale via the cast_vote tool.',
  ].join('\n');
}

describe('AnthropicEvaluator — exemplar injection (byte-identical-prompt guarantee)', () => {
  test('empty/absent exemplars produce a prompt byte-identical to the pre-change baseline', async () => {
    let capturedContent: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedContent = body.messages[0]?.content;
        return toolUseResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const a = action();
    await evaluator.castVote(a, 'high', []);

    const baseline = baselineUserPrompt(a, 'high');
    // Raw byte comparison (not a trimmed-string comparison), per the
    // byte-identical-prompt guarantee.
    assert.equal(capturedContent, baseline);
    assert.equal((capturedContent as string).length, baseline.length);
  });

  test('omitting the exemplars parameter entirely is identical to passing an empty array', async () => {
    let capturedContent: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedContent = body.messages[0]?.content;
        return toolUseResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const a = action();
    await evaluator.castVote(a, 'high');

    assert.equal(capturedContent, baselineUserPrompt(a, 'high'));
  });

  test('non-empty exemplars append the formatted block before the cast-vote instruction', async () => {
    let capturedContent: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedContent = body.messages[0]?.content;
        return toolUseResponse({ vote: 'allow', rationale: 'ok' }) as never;
      },
    };
    const evaluator = new AnthropicEvaluator('melchior', FACET, { client });
    const a = action();
    await evaluator.castVote(a, 'high', [calibrationEntry()]);

    const content = capturedContent as string;
    assert.match(content, /Operator calibration exemplars/);
    assert.match(content, /\[1\] tag: force-push-protected-branch \| severity: critical/);
    assert.match(content, /Force-pushing to main destroys shared history/);
    assert.ok(
      content.indexOf('Operator calibration exemplars') < content.indexOf('Cast your vote'),
      'exemplar block must appear before the cast-vote instruction',
    );
  });
});

describe('AnthropicEvaluator — evaluator identity', () => {
  test('name reflects the constructor argument', () => {
    const client: AnthropicMessagesClient = { create: async () => toolUseResponse({ vote: 'allow', rationale: 'ok' }) as never };
    const evaluator = new AnthropicEvaluator('casper', FACET, { client });
    assert.equal(evaluator.name, 'casper');
  });
});
