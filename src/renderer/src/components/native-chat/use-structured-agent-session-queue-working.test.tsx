// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))
vi.mock('./session/structured/read/use-structured-agent-session-read', () => ({
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

import { useStructuredAgentSession } from './session/structured/use-structured-agent-session'
import { resetStructuredAgentSessionSendsForTests } from './session/structured/delivery/structured-agent-session-message-sender'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionSendsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  mocks.call.mockReset()
})

it('shows queued work as busy and preserves legacy sends without steer support', async () => {
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
  act(() => expect(result.current.send('send this draft')).toBe(true))
  await waitFor(() =>
    expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.send')).toBe(true)
  )
  const sent = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.send')?.[2]
  expect(sent).not.toHaveProperty('steer')
  expect(sent).not.toHaveProperty('delivery')
})
