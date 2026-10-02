// @vitest-environment happy-dom

// A message queued on a session's outbox from outside its chat (review notes, annotations) is the
// same entry the composer would add, drained by the open chat.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { appendStructuredAgentSessionOutboxMessage } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

it('delivers a message queued from outside the chat through the open outbox', async () => {
  mocks.call.mockImplementation(async (_target, _method, params) => {
    const clientMessageId = (params as { envelope: { clientOperationId: string } }).envelope
      .clientOperationId
    return {
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId,
        submission: { clientMessageId, fence: 1, dispatchState: 'accepted', submittedAt: 1 }
      }
    }
  })
  const { result } = renderHook(() =>
    useStructuredAgentSessionOutbox({
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: []
    })
  )

  act(() => {
    appendStructuredAgentSessionOutboxMessage('session-1', 'review notes')
  })

  expect(result.current.outbox[0]?.body.blocks).toEqual([{ type: 'text', text: 'review notes' }])
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.call.mock.calls[0]?.[1]).toBe('agentSession.send')
  expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
    envelope: { sessionId: 'session-1', expectedRuntimeFence: 1 },
    body: { blocks: [{ type: 'text', text: 'review notes' }] }
  })
})
