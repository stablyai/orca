// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  toast: vi.fn(),
  promptCancelSupported: vi.fn(),
  questionAnswersSupported: vi.fn(),
  operationId: vi.fn(() => 'operation-1')
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: async () => true,
  supportsStructuredAgentSessionPromptCancel: mocks.promptCancelSupported,
  supportsStructuredAgentSessionQuestionAnswers: mocks.questionAnswersSupported
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
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
vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: mocks.operationId
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: vi.fn(),
    stopSends: vi.fn()
  })
}))

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import {
  useStructuredAgentSession,
  type StructuredPromptItem
} from './use-structured-agent-session'

let fence = 3
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
    fence = 3
    items = [question, approval]
    mocks.call.mockResolvedValue({ ok: true, value: { itemId: 'question-1', revision: 3 } })
  })

  it.each(['answers', 'cancel'] as const)('owns %s through preparation', async (kind) => {
    const support = Promise.withResolvers<boolean>()
    mocks.questionAnswersSupported.mockReturnValue(support.promise)
    mocks.promptCancelSupported.mockReturnValue(support.promise)
    const original = { kind: 'environment' as const, environmentId: 'host-A' }
    const view = renderHook(
      ({ target }) =>
        useStructuredAgentSession({
          sessionId: 'session-1',
          target,
          agent: 'claude',
          isVisible: true
        }),
      { initialProps: { target: original } }
    )
    const prompt = { itemId: question.itemId, expectedRevision: question.revision }
    const pending =
      kind === 'answers'
        ? view.result.current.respond(question, { kind: 'answers', answers })
        : view.result.current.cancel('turn-1', prompt)
    expect(
      mocks.call.mock.calls.filter(
        ([, method]) =>
          method === (kind === 'answers' ? 'agentSession.respondToQuestion' : 'agentSession.cancel')
      )
    ).toEqual([])
    fence = 4
    view.rerender({ target: { ...original, environmentId: 'host-B' } })
    view.unmount()
    if (kind === 'cancel') {
      mocks.call.mockResolvedValue({ ok: false, refusal: { code: 'agent_session_conflict' } })
    }
    support.resolve(true)
    expect(await pending).toEqual(kind === 'answers' ? { itemId: 'question-1', revision: 3 } : null)
    const calls = mocks.call.mock.calls.filter(
      ([, method]) =>
        method === (kind === 'answers' ? 'agentSession.respondToQuestion' : 'agentSession.cancel')
    )
    expect(calls).toHaveLength(1)
    const [rpcTarget, method, params] = calls[0]
    expect(rpcTarget).toEqual(original)
    expect(method).toBe(
      kind === 'answers' ? 'agentSession.respondToQuestion' : 'agentSession.cancel'
    )
    expect(params).toEqual({
      envelope: expect.objectContaining({ sessionId: 'session-1', expectedRuntimeFence: 3 }),
      ...(kind === 'answers' ? { ...prompt, answers } : { turnId: 'turn-1', prompt })
    })
    expect(mocks.toast).not.toHaveBeenCalled()
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
