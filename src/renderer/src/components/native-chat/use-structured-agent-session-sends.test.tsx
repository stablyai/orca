// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'

const QUEUEING = { capability: 'supported', enabled: true } as const

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
})

// The composer moves the reader only for a message the transcript draws as a bubble.
it.each([
  ['a text follow-up while the agent works', QUEUEING, true, [], 'queued'],
  ['the same follow-up when the agent is idle', QUEUEING, false, [], true],
  ['with the queue setting off', { capability: 'supported', enabled: false }, true, [], true],
  ['an image, which never queues', QUEUEING, true, [{ path: '/a.png', previewUri: '/a.png' }], true]
] as const)(
  'answers whether %s waits as a queued card',
  (_case, queue, isWorking, images, admission) => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() =>
      useStructuredAgentSessionSends({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        queuedMessageIds: [],
        queue,
        historyLoaded: false,
        isWorking
      })
    )
    let sent: boolean | 'queued' = false
    act(() => {
      sent = result.current.send('follow up', images)
    })
    expect(sent).toBe(admission)
  }
)

it('takes no second send while the first is out', () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: QUEUEING,
      historyLoaded: false,
      isWorking: true
    })
  )
  let first: boolean | 'queued' = false
  let second: boolean | 'queued' = true
  act(() => {
    first = result.current.send('one')
    second = result.current.send('two')
  })
  expect(first).toBe('queued')
  expect(second).toBe(false)
})
