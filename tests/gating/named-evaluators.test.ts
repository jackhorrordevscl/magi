import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMelchior, MELCHIOR_FACET } from '../../src/gating/melchior.ts';
import { createBalthasar, BALTHASAR_FACET } from '../../src/gating/balthasar.ts';
import { createCasper, CASPER_FACET } from '../../src/gating/casper.ts';
import type { AnthropicMessagesClient } from '../../src/gating/anthropic-evaluator.ts';
import type { CodingAgentAction } from '../../src/gating/proposed-action.ts';

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

function toolUseResponse(input: unknown) {
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

describe('Named evaluator instances — identity and distinct calibration facets', () => {
  test('melchior has evaluator name "melchior" and casts votes end-to-end', async () => {
    let capturedSystem: unknown;
    const client: AnthropicMessagesClient = {
      create: async (body) => {
        capturedSystem = body.system;
        return toolUseResponse({ vote: 'allow', rationale: 'consistent' }) as never;
      },
    };
    const evaluator = createMelchior({ client });
    assert.equal(evaluator.name, 'melchior');
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.evaluator, 'melchior');
    assert.equal(vote.vote, 'allow');
    assert.match(String(capturedSystem), /fact\/consistency/);
  });

  test('balthasar has evaluator name "balthasar" and casts votes end-to-end', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'deny', rationale: 'too broad' }) as never,
    };
    const evaluator = createBalthasar({ client });
    assert.equal(evaluator.name, 'balthasar');
    const vote = await evaluator.castVote(action(), 'high');
    assert.equal(vote.evaluator, 'balthasar');
    assert.equal(vote.vote, 'deny');
  });

  test('casper has evaluator name "casper" and casts votes end-to-end', async () => {
    const client: AnthropicMessagesClient = {
      create: async () => toolUseResponse({ vote: 'abstain', rationale: 'unclear' }) as never,
    };
    const evaluator = createCasper({ client });
    assert.equal(evaluator.name, 'casper');
    const vote = await evaluator.castVote(action(), 'medium');
    assert.equal(vote.evaluator, 'casper');
    assert.equal(vote.vote, 'abstain');
  });

  test('the three facets are textually distinct (not cosmetic copies of one generic persona)', () => {
    const descriptions = [MELCHIOR_FACET.description, BALTHASAR_FACET.description, CASPER_FACET.description];
    assert.equal(new Set(descriptions).size, 3);

    const guidances = [MELCHIOR_FACET.guidance, BALTHASAR_FACET.guidance, CASPER_FACET.guidance];
    assert.equal(new Set(guidances).size, 3);
  });

  test('each facet description matches its spec-defined role (fact/consistency, blast radius+policy, actor risk/anomaly)', () => {
    assert.equal(MELCHIOR_FACET.description, 'fact/consistency');
    assert.equal(BALTHASAR_FACET.description, 'blast radius to others + policy');
    assert.equal(CASPER_FACET.description, 'actor risk/anomaly');
  });
});
