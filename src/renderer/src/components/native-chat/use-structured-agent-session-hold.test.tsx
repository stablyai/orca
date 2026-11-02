// @vitest-environment happy-dom

// Closing a terminal-tab chat only unmounts its view; main needs that signal to retire older hosts’ provider processes.

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn()
}))

import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'

const LOCAL_TARGET = { kind: 'local' } as const

function callsTo(method: string): unknown[] {
  return mocks.call.mock.calls.filter((call) => call[1] === method).map((call) => call[2])
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(undefined)
})

describe('a mounted structured chat', () => {
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
