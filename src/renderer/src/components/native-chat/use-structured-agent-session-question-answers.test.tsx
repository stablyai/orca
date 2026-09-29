// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  promptCancelSupported: vi.fn(),
  questionAnswersSupported: vi.fn(),
  operationId: vi.fn(() => 'operation-1')
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: mocks.promptCancelSupported,
  supportsStructuredAgentSessionQuestionAnswers: mocks.questionAnswersSupported
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))
vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: mocks.operationId,
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import {
  useStructuredAgentSession,
  type StructuredPromptItem
} from './use-structured-agent-session'

let items: AgentJournalRenderItem[] = []
const target = { kind: 'local' } as const

const question: StructuredPromptItem = {
  itemId: 'question-1',
  revision: 2,
  sequence: 2,
  observedAt: 2,
  body: {
    kind: 'question',
    question: '1 grouped question from Claude',
    options: [],
    questions: [
      {
        id: 'q1',
        question: 'Which option?',
        multiSelect: false,
        options: [{ id: 'q1:choice-1', label: 'Alpha' }],
        freeTextQuestionId: 'q1'
      }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

const approval: StructuredPromptItem = {
  itemId: 'approval-1',
  revision: 3,
  sequence: 3,
  observedAt: 3,
  body: {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

const answers = [{ questionId: 'q1', optionIds: [], other: 'Wait for the capture. '.repeat(80) }]

function respondCall(): Record<string, unknown> | undefined {
  return mocks.call.mock.calls.find(([, method]) =>
    String(method).startsWith('agentSession.respondTo')
  )?.[2]
}

describe('desktop structured prompt answers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    items = [question, approval]
    mocks.call.mockResolvedValue({ ok: true, value: { itemId: 'question-1', revision: 3 } })
  })

  it('sends structured answers to a host that takes them', async () => {
    mocks.questionAnswersSupported.mockResolvedValue(true)
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await result.current.respond(question, { kind: 'answers', answers })
    })

    expect(mocks.questionAnswersSupported).toHaveBeenCalledWith(target)
    expect(respondCall()).toMatchObject({ itemId: 'question-1', expectedRevision: 2, answers })
    expect(respondCall()).not.toHaveProperty('optionId')
  })

  it('packs the answer into an option id for a host that predates structured answers', async () => {
    mocks.questionAnswersSupported.mockResolvedValue(false)
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await result.current.respond(question, { kind: 'answers', answers })
    })

    expect(respondCall()).toMatchObject({
      itemId: 'question-1',
      optionId: encodeAgentSessionQuestionAnswers(answers)
    })
    expect(respondCall()).not.toHaveProperty('answers')
  })

  it('sends an approval decision without probing the host', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await result.current.respond(approval, { kind: 'option', optionId: 'allow' })
    })

    expect(mocks.questionAnswersSupported).not.toHaveBeenCalled()
    expect(respondCall()).toMatchObject({ itemId: 'approval-1', optionId: 'allow' })
  })
})
