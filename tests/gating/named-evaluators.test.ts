import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMelchior, MELCHIOR_FACET } from '../../src/gating/melchior.ts';
import { createBalthasar, BALTHASAR_FACET } from '../../src/gating/balthasar.ts';
import { createCasper, CASPER_FACET } from '../../src/gating/casper.ts';
import type { GroqChatClient } from '../../src/gating/groq-evaluator.ts';
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

function toolCallResponse(input: unknown) {
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

describe('Named evaluator instances — identity and distinct calibration facets', () => {
  test('melchior has evaluator name "melchior" and casts votes end-to-end', async () => {
    let capturedMessages: unknown;
    const client: GroqChatClient = {
      create: async (body) => {
        capturedMessages = body.messages;
        return toolCallResponse({ vote: 'allow', rationale: 'consistent' }) as never;
      },
    };
    const evaluator = createMelchior({ client });
    assert.equal(evaluator.name, 'melchior');
    const vote = await evaluator.castVote(action(), 'low');
    assert.equal(vote.evaluator, 'melchior');
    assert.equal(vote.vote, 'allow');
    assert.match(String(JSON.stringify(capturedMessages)), /fact\/consistency/);
  });

  test('balthasar has evaluator name "balthasar" and casts votes end-to-end', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'deny', rationale: 'too broad' }) as never,
    };
    const evaluator = createBalthasar({ client });
    assert.equal(evaluator.name, 'balthasar');
    const vote = await evaluator.castVote(action(), 'high');
    assert.equal(vote.evaluator, 'balthasar');
    assert.equal(vote.vote, 'deny');
  });

  test('casper has evaluator name "casper" and casts votes end-to-end', async () => {
    const client: GroqChatClient = {
      create: async () => toolCallResponse({ vote: 'abstain', rationale: 'unclear' }) as never,
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

  test('each named evaluator uses its own confirmed free-tier Groq model by default', async () => {
    let melchiorModel: unknown;
    let balthasarModel: unknown;
    let casperModel: unknown;

    const melchior = createMelchior({
      client: {
        create: async (body) => {
          melchiorModel = body.model;
          return toolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
        },
      },
    });
    const balthasar = createBalthasar({
      client: {
        create: async (body) => {
          balthasarModel = body.model;
          return toolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
        },
      },
    });
    const casper = createCasper({
      client: {
        create: async (body) => {
          casperModel = body.model;
          return toolCallResponse({ vote: 'allow', rationale: 'ok' }) as never;
        },
      },
    });

    await melchior.castVote(action(), 'low');
    await balthasar.castVote(action(), 'low');
    await casper.castVote(action(), 'low');

    assert.equal(melchiorModel, 'openai/gpt-oss-120b');
    assert.equal(balthasarModel, 'llama-3.3-70b-versatile');
    assert.equal(casperModel, 'llama-3.1-8b-instant');
  });
});
