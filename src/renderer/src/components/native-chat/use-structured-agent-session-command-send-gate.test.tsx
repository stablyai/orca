// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outboxSend: vi.fn()
}))
let items: AgentJournalRenderItem[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
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

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: mocks.outboxSend,
    retry: vi.fn()
  })
}))

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { useStructuredAgentSession } from './use-structured-agent-session'

function answer(text: string, scoped: boolean): AgentJournalRenderItem {
  return {
    itemId: text,
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    ...(scoped ? { turnScope: { kind: 'thread' as const } } : {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.outboxSend.mockReturnValue(true)
})

/** Starts `/compact` and leaves its reply outstanding, then sends a message. */
function sendDuringCommand(): boolean {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' ? new Promise(() => {}) : Promise.resolve(null)
  )
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )
  act(() => {
    void result.current.runConversationCommand('compact')
  })
  return result.current.send('typed during the command')
}

it('still refuses a message locally while an older host runs a command', () => {
  items = [answer('from an older host', false)]

  expect(sendDuringCommand()).toBe(false)
  expect(mocks.outboxSend).not.toHaveBeenCalled()
})

it('queues a message typed during a command on a host that runs it as a turn', () => {
  items = [answer('from this host', true)]

  expect(sendDuringCommand()).toBe(true)
  expect(mocks.outboxSend).toHaveBeenCalledOnce()
})
