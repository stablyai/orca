// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supportsPromptCancel: vi.fn(),
  operationId: vi.fn(() => 'cancel-operation')
}))
let items: AgentJournalRenderItem[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  structuredAgentSessionSupportsPromptCancel: mocks.supportsPromptCancel
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 31
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      commands: undefined,
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

import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const

function pendingPrompt(
  kind: 'approval' | 'question',
  itemId: string,
  revision: number
): AgentJournalRenderItem {
  const resolution = {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
  return {
    itemId,
    revision,
    sequence: 2,
    observedAt: 2,
    body:
      kind === 'approval'
        ? {
            kind,
            title: 'Allow?',
            detail: null,
            options: [{ id: 'allow', label: 'Allow' }],
            resolution
          }
        : {
            kind,
            question: 'Which approach?',
            options: [{ id: 'focused', label: 'Focused' }],
            resolution
          }
  }
}

function renderSession(target: RuntimeClientTarget = LOCAL_TARGET) {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target,
      isVisible: true
    })
  )
}

describe('useStructuredAgentSession prompt cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    items = []
    mocks.call.mockResolvedValue(null)
    mocks.supportsPromptCancel.mockResolvedValue(true)
  })

  it('cancels the exact displayed prompt revision on a capable host', async () => {
    items = [pendingPrompt('question', 'question-1', 4)]
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.cancel'
        ? Promise.resolve({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
        : Promise.resolve(null)
    )
    const { result } = renderSession()

    await act(async () => void (await result.current.cancel('turn-1', result.current.prompts[0])))

    expect(mocks.call).toHaveBeenCalledWith(
      LOCAL_TARGET,
      'agentSession.cancel',
      expect.objectContaining({
        turnId: 'turn-1',
        prompt: { itemId: 'question-1', expectedRevision: 4 }
      })
    )
  })

  it('lets a durable prompt identify its turn after foreground lifecycle settlement', async () => {
    items = [pendingPrompt('approval', 'approval-restored', 3)]
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.cancel'
        ? Promise.resolve({ ok: true, value: { turnId: 'provider-child-turn', cancelled: true } })
        : Promise.resolve(null)
    )
    const { result } = renderSession()

    await act(async () => void (await result.current.cancel(null, result.current.prompts[0])))

    const call = mocks.call.mock.calls.find((candidate) => candidate[1] === 'agentSession.cancel')
    expect(call?.[2]).not.toHaveProperty('turnId')
    expect(call?.[2]).toMatchObject({
      prompt: { itemId: 'approval-restored', expectedRevision: 3 }
    })
  })

  it('refuses prompt cancellation on an older remote host', async () => {
    items = [pendingPrompt('approval', 'approval-1', 2)]
    mocks.supportsPromptCancel.mockResolvedValue(false)
    const target = { kind: 'environment', environmentId: 'legacy-host' } as const
    const { result } = renderSession(target)

    await act(async () => void (await result.current.cancel('turn-1', result.current.prompts[0])))

    expect(mocks.call.mock.calls.some((call) => call[1] === 'agentSession.cancel')).toBe(false)
    expect(mocks.supportsPromptCancel).toHaveBeenCalledWith(target, 31)
    expect(result.current.error).toBe(
      'Cancelling a pending prompt requires a newer Orca server. Update the server and try again.'
    )
  })

  it('keeps generic turn cancellation available on an older remote host', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.cancel'
        ? Promise.resolve({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
        : Promise.resolve(null)
    )
    const target = { kind: 'environment', environmentId: 'legacy-host' } as const
    const { result } = renderSession(target)

    await act(async () => void (await result.current.cancel('turn-1')))

    const call = mocks.call.mock.calls.find((candidate) => candidate[1] === 'agentSession.cancel')
    expect(call?.[2]).toMatchObject({ turnId: 'turn-1' })
    expect(call?.[2]).not.toHaveProperty('prompt')
    expect(call?.[3]).toBe(31)
    expect(mocks.supportsPromptCancel).not.toHaveBeenCalled()
  })

  it('does not cancel when remote prompt-cancel support cannot be verified', async () => {
    items = [pendingPrompt('approval', 'approval-1', 2)]
    mocks.supportsPromptCancel.mockRejectedValue(new Error('Host unreachable'))
    const { result } = renderSession({ kind: 'environment', environmentId: 'offline-host' })

    await act(async () => {
      await expect(result.current.cancel('turn-1', result.current.prompts[0])).resolves.toBeNull()
    })

    expect(mocks.call.mock.calls.some((call) => call[1] === 'agentSession.cancel')).toBe(false)
    expect(result.current.error).toBe('Host unreachable')
  })
})
