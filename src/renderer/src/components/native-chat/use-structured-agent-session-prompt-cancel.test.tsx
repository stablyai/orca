// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  promptCancelSupported: vi.fn(),
  operationId: vi.fn(() => 'operation-1')
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: mocks.promptCancelSupported
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
import { useStructuredAgentSession } from './use-structured-agent-session'

let items: AgentJournalRenderItem[] = []
const target = { kind: 'local' } as const

function pendingApproval(): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: 2,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'approval',
      title: 'Allow Bash?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
}

function runningTurn(): AgentJournalRenderItem {
  return {
    itemId: 'turn-status',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      text: 'Waiting',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    }
  }
}

describe('desktop structured prompt cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    items = [runningTurn(), pendingApproval()]
    mocks.promptCancelSupported.mockResolvedValue(false)
    mocks.call.mockResolvedValue({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
  })

  it('sends item identity and revision on capable hosts', async () => {
    mocks.promptCancelSupported.mockResolvedValue(true)
    const { result } = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )

    await act(async () => {
      await result.current.cancel('turn-1', { itemId: 'approval-1', expectedRevision: 2 })
    })

    expect(mocks.promptCancelSupported).toHaveBeenCalledWith(target)
    const call = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.cancel')
    expect(call?.[2]).toMatchObject({
      turnId: 'turn-1',
      prompt: { itemId: 'approval-1', expectedRevision: 2 }
    })
  })

  it('omits strict prompt identity on old hosts', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )

    await act(async () => {
      await result.current.cancel('turn-1', { itemId: 'approval-1', expectedRevision: 2 })
    })

    const call = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.cancel')
    expect(call?.[2]).toMatchObject({ turnId: 'turn-1' })
    expect(call?.[2]).not.toHaveProperty('prompt')
  })

  it('keeps ordinary composer stop turn-only without a capability probe', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )

    await act(async () => {
      await result.current.cancel('turn-1')
    })

    expect(mocks.promptCancelSupported).not.toHaveBeenCalled()
    const call = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.cancel')
    expect(call?.[2]).toMatchObject({ turnId: 'turn-1' })
    expect(call?.[2]).not.toHaveProperty('prompt')
  })

  it('keeps a conversation claim when cancellation is not accepted', async () => {
    items = []
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.conversationCommand') {
        return new Promise(() => {})
      }
      if (method === 'agentSession.cancel') {
        return Promise.reject(new Error('connection lost'))
      }
      return Promise.resolve({ ok: true, value: { models: [], current: { model: 'test' } } })
    })
    const view = renderHook(() =>
      useStructuredAgentSession({ sessionId: 'session-1', target, agent: 'codex', isVisible: true })
    )

    let pending!: ReturnType<typeof view.result.current.runConversationCommand>
    act(() => {
      pending = view.result.current.runConversationCommand('compact')
    })
    await act(async () => {
      await expect(view.result.current.cancel('compact:operation-1')).resolves.toBeNull()
    })

    await act(async () => {
      await expect(view.result.current.runConversationCommand('compact')).resolves.toMatchObject({
        accepted: false,
        error: expect.stringContaining('Wait for the conversation operation to finish')
      })
    })
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.conversationCommand')
    ).toHaveLength(1)

    act(() => view.unmount())
    await pending
  })
})
