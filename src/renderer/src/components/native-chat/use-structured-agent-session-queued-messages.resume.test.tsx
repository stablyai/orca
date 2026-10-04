// @vitest-environment happy-dom

// Resume lifts the queue's pause through its own RPC, over the same fenced write every card action
// uses: a refusal or a failure is one toast, and the Resume button is the way to try again.

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ResumeParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: ResumeParams) => Promise<unknown>>(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'

function renderController() {
  const stateRef = { current: { fence: 1 } }
  return renderHook(() => {
    const { mutate } = useStructuredAgentSessionMutate({
      sessionId: 'session-1',
      target: { kind: 'local' },
      stateRef
    })
    return useStructuredAgentSessionQueuedMessages({
      enabled: true,
      queuedMessages: [],
      queuePause: { reason: 'stopped' },
      submissions: [],
      hasPendingPrompt: false,
      composerScopeKey: undefined,
      mutate
    })
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('Resume on a paused queue', () => {
  it('calls queuedMessagesResume with only an envelope, and says nothing when it lands', async () => {
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { resumed: true }
    })
    const { result } = renderController()
    expect(result.current.pause).toEqual({ reason: 'stopped' })
    await act(() => result.current.resume())
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [, method, params] = mocks.call.mock.calls[0] ?? []
    expect(method).toBe('agentSession.queuedMessagesResume')
    expect(Object.keys(params ?? {})).toEqual(['envelope'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('a refused or failed Resume is one toast', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'The session moved on.' }
    })
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    const { result } = renderController()
    await act(() => result.current.resume())
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    await act(() => result.current.resume())
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('every press is its own operation: a failed Resume never pins the next one to its id', async () => {
    // Resume names no target, so a replayed id would answer `{ resumed: false }` or repeat the
    // same refusal instead of lifting whatever pause holds now.
    mocks.call.mockRejectedValueOnce(new Error('socket closed'))
    mocks.call.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message: 'Unknown operation.' }
    })
    mocks.call.mockResolvedValueOnce({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { resumed: true }
    })
    const { result } = renderController()
    for (let press = 0; press < 3; press += 1) {
      await act(() => result.current.resume())
    }
    const ids = mocks.call.mock.calls.map(([, , params]) => params.envelope.clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('reports a Resume in flight until it settles', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.resume()
    })
    expect(result.current.resuming).toBe(true)
    await act(async () => {
      answer.resolve({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { resumed: true }
      })
      await pending
    })
    expect(result.current.resuming).toBe(false)
  })
})
