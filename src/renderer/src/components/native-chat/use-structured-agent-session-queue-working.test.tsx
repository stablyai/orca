// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
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
      hasOlder: false,
      nextQueuedMessageId: 'queued-1',
      queuedMessages: [
        {
          messageId: 'queued-1',
          position: 1,
          state: 'waiting',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
        }
      ]
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionSendsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  mocks.call.mockReset()
})

it('keeps the draft when queued work is starting and the host cannot steer', () => {
  setLocalRuntimeCapabilitiesForTests([])
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'queue-starting',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true,
      queueFollowUps: false
    })
  )
  expect(result.current.isWorking).toBe(true)
  expect(result.current.queueSendsNext).toBe(true)
  act(() => expect(result.current.send('keep this draft')).toBe(false))
  expect(result.current.pending).toEqual([])
  expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.send')).toBe(false)
})
