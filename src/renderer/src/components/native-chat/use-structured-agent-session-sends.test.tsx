// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'

const QUEUEING = {
  capability: 'supported',
  followUpsQueue: true,
  isWorking: true,
  stopping: false,
  session: { queuedMessages: [] },
  prompts: []
} as const

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
})

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
