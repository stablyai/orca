// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: [],
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
  structuredSessionOperationId: () => 'operation-1',
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
const OPTIONS = { models: [], current: {} }

describe('a chat write the host refused', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says a refused Stop once, in plain words, and leaves nothing latched', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: false,
            refusal: {
              code: 'agent_session_checkpoint_stale',
              message: 'Expected runtime fence 1; the session is at 3.'
            }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await expect(result.current.cancel('turn-1')).resolves.toBeNull()
    })

    expect(mocks.toastError).toHaveBeenCalledWith("The agent wasn't stopped.")
    expect(result.current.error).toBeNull()
  })

  it('answers a refused conversation command inline, where the command was typed', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: false,
            refusal: {
              code: 'agent_session_operation_invalid',
              message: 'agent_session_rewind:outcome-unknown'
            }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await expect(result.current.runConversationCommand('compact')).resolves.toEqual({
        accepted: false,
        // The code does not say why, so no next step is offered that could be false.
        error: "The command didn't run."
      })
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })
})
