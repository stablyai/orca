// @vitest-environment happy-dom

// A structured chat is a view on a terminal tab, so closing the tab is an unmount and nothing else.
// If that unmount does not reach main, the codex app-server behind the chat has no other way to
// learn the chat is gone.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), supportsCapability: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'env-1' } as const

function callsTo(method: string): unknown[] {
  return mocks.call.mock.calls.filter((call) => call[1] === method).map((call) => call[2])
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(undefined)
  mocks.supportsCapability.mockReset()
  mocks.supportsCapability.mockResolvedValue(true)
})

function rejectMethod(method: string, error: unknown): void {
  mocks.call.mockImplementation((_target: unknown, called: string) =>
    called === method ? Promise.reject(error) : Promise.resolve()
  )
}

function mountHold(target: typeof LOCAL_TARGET | typeof PAIRED_TARGET) {
  return renderHook(() =>
    useStructuredAgentSessionHold({ sessionId: 'session-alpha', target, surface: 'desktop-chat' })
  )
}

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

// A host that answers and has no hold method, and a host that never answered, are different
// situations with different recoveries. Swallowing both made them the same silence.
describe('a hold that did not land', () => {
  it('names the lease refusal the host sent, and releases nothing', async () => {
    // The shape a paired transport actually delivers: the token is re-wrapped into the message.
    rejectMethod(
      'agentSession.hold',
      new Error("Error invoking remote method 'runtime:call': Error: agent_session_conflict")
    )
    const view = mountHold(LOCAL_TARGET)

    await waitFor(() =>
      expect(view.result.current.state).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
    )

    view.unmount()
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))
    expect(callsTo('agentSession.release')).toHaveLength(0)
  })

  it('reports a release the host refused instead of dropping it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rejectMethod('agentSession.release', new Error('execution_owner_reconciling'))
    const view = mountHold(LOCAL_TARGET)
    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'held' }))

    view.unmount()

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(String(warn.mock.calls[0])).toContain('execution_owner_reconciling')
    warn.mockRestore()
  })

  it('leaves an unmounted pane alone when the hold rejects afterwards', async () => {
    let failHold = (_error: unknown): void => {}
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.hold'
        ? new Promise<void>((_resolve, reject) => {
            failHold = reject
          })
        : Promise.resolve()
    )
    const view = mountHold(LOCAL_TARGET)
    await waitFor(() => expect(callsTo('agentSession.hold')).toHaveLength(1))

    view.unmount()
    await act(async () => {
      failHold(new Error('agent_session_ownership_unknown'))
      await Promise.resolve()
    })

    // Nothing landed, so there is nothing to undo — and no state left to write into.
    expect(callsTo('agentSession.release')).toHaveLength(0)
    expect(view.result.current.state).toEqual({ kind: 'pending' })
  })

  it('reads a host with no hold method as an update prompt, and never asks it', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    const view = mountHold(PAIRED_TARGET)

    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'unsupported' }))
    expect(callsTo('agentSession.hold')).toHaveLength(0)
    view.unmount()
    expect(callsTo('agentSession.release')).toHaveLength(0)
  })

  it('reads a host that never answered as unreachable, and never asks it', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('runtime environment is not connected'))
    const view = mountHold(PAIRED_TARGET)

    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'unreachable' }))
    expect(callsTo('agentSession.hold')).toHaveLength(0)
  })

  it('takes the hold on a re-paired host when the user retries', async () => {
    mocks.supportsCapability.mockRejectedValueOnce(
      new Error('runtime environment is not connected')
    )
    const view = mountHold(PAIRED_TARGET)
    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'unreachable' }))

    act(() => view.result.current.retry())

    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'held' }))
    expect(callsTo('agentSession.hold')).toHaveLength(1)
  })

  it('holds a paired host that advertises the method', async () => {
    const view = mountHold(PAIRED_TARGET)

    await waitFor(() => expect(view.result.current.state).toEqual({ kind: 'held' }))
    expect(callsTo('agentSession.hold')).toHaveLength(1)
  })
})
