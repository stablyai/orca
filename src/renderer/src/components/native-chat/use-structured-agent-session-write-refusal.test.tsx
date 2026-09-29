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
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

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

  it('does not say a Stop failed when its request timed out after it may have run', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(
            new RuntimeRpcCallError({
              id: 'request-1',
              ok: false,
              error: {
                code: 'runtime_timeout',
                message: 'Timed out waiting for the remote Orca runtime to respond.'
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          )
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

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Orca couldn't confirm what happened. Check the chat."
    )
  })

  it('words a refusal the host threw from its data, never the bare code it carries as its message', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(
            new RuntimeRpcCallError({
              id: 'request-1',
              ok: false,
              error: {
                code: 'runtime_error',
                message: 'agent_session_journal_unreadable',
                data: {
                  refusal: {
                    code: 'agent_session_journal_unreadable',
                    details: { reason: 'journalUnavailable' }
                  }
                }
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          )
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

    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      "Orca couldn't open this chat's history right now. The agent wasn't stopped. Try again."
    )
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

  it('says the reason the host named, for a Stop and for a command', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: false,
            refusal:
              method === 'agentSession.cancel'
                ? {
                    code: 'agent_session_conflict',
                    message: 'The chat is still starting.',
                    details: { reason: 'chatStarting' }
                  }
                : {
                    code: 'agent_session_operation_invalid',
                    message: 'Wait for the current turn to finish before using this command.',
                    details: { reason: 'turnActive' }
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
      await expect(result.current.runConversationCommand('compact')).resolves.toEqual({
        accepted: false,
        error:
          "The agent is still responding. The command didn't run. Wait for the agent to finish responding, or stop it."
      })
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      "The agent is still starting. The agent wasn't stopped. Wait for the agent to finish starting."
    )
  })
})
