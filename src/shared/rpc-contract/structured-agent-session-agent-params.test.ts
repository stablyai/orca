import { describe, expect, it } from 'vitest'
import {
  AgentsParams,
  AttachParams,
  CreateIntentParams,
  CreateSupportParams,
  ModelCatalogParams,
  RespondToQuestionParams
} from './structured-agent-session-params'
import { AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES } from '../agent-session-question-answer'

const ENVELOPE = {
  sessionId: 'agent-session-0123456789abcdef0123456789abcdef',
  clientOperationId: 'op-1',
  expectedRuntimeFence: null,
  payloadFingerprint: 'a'.repeat(64)
}

describe('structured agent params', () => {
  it('keeps normal question answers valid and bounds the combined answer body after schema extraction', () => {
    const base = { envelope: ENVELOPE, itemId: 'question-1', expectedRevision: 1 }
    const ordinary = { ...base, answers: [{ questionId: 'q1', optionIds: ['yes'], other: 'why' }] }
    expect(() => RespondToQuestionParams.safeParse(ordinary)).not.toThrow()
    expect(RespondToQuestionParams.safeParse(ordinary).success).toBe(true)
    const oversized = {
      ...base,
      answers: Array.from({ length: 4 }, (_, index) => ({
        questionId: `q${index}`,
        optionIds: [],
        other: 'x'.repeat(AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES)
      }))
    }
    expect(RespondToQuestionParams.safeParse(oversized).success).toBe(false)
  })
  it('accepts only the same bounded user message a send accepts, with bounded options', () => {
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'opening text' }] }
    const params = {
      envelope: ENVELOPE,
      worktree: 'wt',
      agent: 'codex',
      firstMessage: { clientMessageId: 'message-1', body },
      options: { model: 'picked-model' }
    }
    expect(CreateIntentParams.safeParse(params).success).toBe(true)
    for (const firstMessage of [
      { clientMessageId: '', body },
      { clientMessageId: 'message-1', body: { ...body, role: 'assistant' } },
      { clientMessageId: 'message-1', body: { ...body, blocks: [] } },
      { clientMessageId: 'message-1', body, source: 'provider' },
      {
        clientMessageId: 'message-1',
        body: { ...body, blocks: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] }
      }
    ]) {
      expect(CreateIntentParams.safeParse({ ...params, firstMessage }).success).toBe(false)
    }
    expect(CreateIntentParams.safeParse({ ...params, options: { model: 1 } }).success).toBe(false)
    expect(
      CreateIntentParams.safeParse({
        ...params,
        options: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key-${index}`, 'value'])
        )
      }).success
    ).toBe(false)
  })
  it.each(['claude', 'codex', 'grok', 'qwen-code'])('accept the agent id %s', (agent) => {
    expect(CreateSupportParams.safeParse({ worktree: 'wt', agent }).success).toBe(true)
    expect(ModelCatalogParams.safeParse({ agent }).success).toBe(true)
    expect(
      CreateIntentParams.safeParse({ envelope: ENVELOPE, worktree: 'wt', agent }).success
    ).toBe(true)
  })

  it.each(['', ' claude', 'grok agent', '../codex', 'a'.repeat(65), 7])(
    'refuse what is not an agent id: %s',
    (agent) => {
      expect(CreateSupportParams.safeParse({ worktree: 'wt', agent }).success).toBe(false)
      expect(ModelCatalogParams.safeParse({ agent }).success).toBe(false)
    }
  )

  it('keeps attaching by a client-supplied handle to Claude and Codex', () => {
    const attach = {
      envelope: ENVELOPE,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'wt',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/u/.codex' },
      runtimeKind: 'native',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    }
    expect(AttachParams.safeParse(attach).success).toBe(true)
    expect(AttachParams.safeParse({ ...attach, provider: 'grok' }).success).toBe(false)
  })

  it('takes nothing for the agent list', () => {
    expect(AgentsParams.safeParse({}).success).toBe(true)
    expect(AgentsParams.safeParse({ agent: 'grok' }).success).toBe(false)
  })
})
