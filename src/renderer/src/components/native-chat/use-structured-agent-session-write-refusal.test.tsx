// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
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

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => 'operation-1'
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: vi.fn(),
    stopSends: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { i18n } from '@/i18n/i18n'

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

  it('says to update Orca for a Stop refused on a journal a newer Orca wrote', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: false,
            // As the host answers it (pinned in `journal-open-failure.test.ts`).
            refusal: {
              code: 'agent_session_journal_unreadable',
              message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
              details: { reason: 'journalWrittenByNewerOrca' }
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

    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      "Chats were saved by a newer Orca. The agent wasn't stopped. Update Orca to keep using them."
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
        error: "Claude is still working. Run /compact when it's done."
      })
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      "The agent is still starting. The agent wasn't stopped. Wait for the agent to finish starting."
    )
  })

  it("words a failed /clear the host ran with the chat's own agent, in the reader's language", async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: {
              command: 'clear',
              state: 'completed',
              error: "Codex couldn't start. Run /clear again.",
              failure: { kind: 'startFailed' }
            }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )

    await i18n.changeLanguage('fr')
    try {
      await act(async () => {
        await expect(result.current.runConversationCommand('clear')).resolves.toEqual({
          accepted: false,
          error: "Codex n'a pas pu démarrer. Relancez /clear."
        })
      })
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
