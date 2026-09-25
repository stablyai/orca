// @vitest-environment happy-dom

// A structured chat is a view on a terminal tab, so closing the tab is an unmount and nothing else.
// If that unmount does not reach main, the codex app-server behind the chat has no other way to
// learn the chat is gone.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn()
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'

const LOCAL_TARGET = { kind: 'local' } as const
const FOLDER_GONE =
  'The folder this chat ran in no longer exists: /gone/folder. Restore it to continue.'

function rpcError(code: string, message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'hold', ok: false, error: { code, message } })
}

function rejectHoldWith(error: unknown): void {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.hold' ? Promise.reject(error) : Promise.resolve()
  )
}

function callsTo(method: string): unknown[] {
  return mocks.call.mock.calls.filter((call) => call[1] === method).map((call) => call[2])
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(undefined)
})

describe('a mounted structured chat', () => {
  it('holds the session while it is on screen and releases it on unmount', async () => {
    const { unmount } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )

    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))
    const held = callsTo('agentSession.hold')[0] as { sessionId: string; holderId: string }
    expect(held.sessionId).toBe('session-alpha')
    expect(callsTo('agentSession.release')).toHaveLength(0)

    unmount()

    await waitFor(() =>
      expect(callsTo('agentSession.release')).toEqual([
        { sessionId: 'session-alpha', holderId: held.holderId }
      ])
    )
  })

  it('does not release a hold that has not landed yet', async () => {
    let settleHold = (): void => {}
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.hold'
        ? new Promise<void>((resolve) => {
            settleHold = resolve
          })
        : Promise.resolve()
    )
    const { unmount } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))

    unmount()
    // The hold is still in flight; releasing now would leave the late hold with nothing to undo it.
    expect(callsTo('agentSession.release')).toHaveLength(0)

    settleHold()

    await waitFor(() => expect(callsTo('agentSession.release')).toHaveLength(1))
  })

  it('reports a hold the host refused and still releases on unmount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = new Error('structured_agent_session_unsupported')
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.hold' ? Promise.reject(refused) : Promise.resolve()
    )
    const { unmount } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )

    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), refused))
    unmount()
    await waitFor(() => expect(callsTo('agentSession.release')).toHaveLength(1))
    warn.mockRestore()
  })

  it('keeps one hold across re-renders that rebuild the target object', async () => {
    const { rerender, unmount } = renderHook(
      (props: { sessionId: string }) =>
        useStructuredAgentSessionHold({
          sessionId: props.sessionId,
          target: { kind: 'local' },
          surface: 'desktop-chat'
        }),
      { initialProps: { sessionId: 'session-alpha' } }
    )
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))

    rerender({ sessionId: 'session-alpha' })
    rerender({ sessionId: 'session-alpha' })

    expect(callsTo('agentSession.hold')).toHaveLength(1)
    expect(callsTo('agentSession.release')).toHaveLength(0)
    unmount()
  })

  it('holds only while a retained pane is visible', async () => {
    const view = renderHook(
      ({ visible }: { visible: boolean }) =>
        useStructuredAgentSessionHold({
          sessionId: 'session-restored',
          target: LOCAL_TARGET,
          surface: 'desktop-chat',
          enabled: visible
        }),
      { initialProps: { visible: false } }
    )

    expect(callsTo('agentSession.hold')).toHaveLength(0)
    view.rerender({ visible: true })
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))

    view.rerender({ visible: false })
    await waitFor(() => expect(callsTo('agentSession.release')).toHaveLength(1))

    view.rerender({ visible: true })
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(2))
    expect(callsTo('agentSession.release')).toHaveLength(1)
  })
})

describe('a structured chat whose hold is refused', () => {
  it('stays quiet when an older host has no hold method', async () => {
    rejectHoldWith(rpcError('method_not_found', 'Unknown method: agentSession.hold'))
    const { result } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )

    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.error).toBeNull()
  })

  it("exposes the host's refusal text", async () => {
    rejectHoldWith(rpcError('agent_session_operation_invalid', FOLDER_GONE))
    const { result } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )

    await waitFor(() => expect(result.current.error).toBe(FOLDER_GONE))
  })

  it('clears the refusal once a later hold succeeds', async () => {
    rejectHoldWith(rpcError('agent_session_operation_invalid', FOLDER_GONE))
    const view = renderHook(
      ({ visible }: { visible: boolean }) =>
        useStructuredAgentSessionHold({
          sessionId: 'session-alpha',
          target: LOCAL_TARGET,
          surface: 'desktop-chat',
          enabled: visible
        }),
      { initialProps: { visible: true } }
    )
    await waitFor(() => expect(view.result.current.error).toBe(FOLDER_GONE))

    // The user restores the folder and re-opens the chat.
    mocks.call.mockResolvedValue(undefined)
    view.rerender({ visible: false })
    view.rerender({ visible: true })

    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(2))
    await waitFor(() => expect(view.result.current.error).toBeNull())
  })

  it('does not show one session’s refusal on the next session', async () => {
    rejectHoldWith(rpcError('agent_session_operation_invalid', FOLDER_GONE))
    const view = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useStructuredAgentSessionHold({ sessionId, target: LOCAL_TARGET, surface: 'desktop-chat' }),
      { initialProps: { sessionId: 'session-alpha' } }
    )
    await waitFor(() => expect(view.result.current.error).toBe(FOLDER_GONE))

    mocks.call.mockImplementation(() => new Promise(() => {}))
    view.rerender({ sessionId: 'session-beta' })

    expect(view.result.current.error).toBeNull()
  })

  it('still releases after a refused hold', async () => {
    let refuseHold = (): void => {}
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.hold'
        ? new Promise<void>((_resolve, reject) => {
            refuseHold = () => reject(rpcError('agent_session_operation_invalid', FOLDER_GONE))
          })
        : Promise.resolve()
    )
    const { unmount } = renderHook(() =>
      useStructuredAgentSessionHold({
        sessionId: 'session-alpha',
        target: LOCAL_TARGET,
        surface: 'desktop-chat'
      })
    )
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))

    unmount()
    expect(callsTo('agentSession.release')).toHaveLength(0)
    refuseHold()

    await waitFor(() => expect(callsTo('agentSession.release')).toHaveLength(1))
  })
})
