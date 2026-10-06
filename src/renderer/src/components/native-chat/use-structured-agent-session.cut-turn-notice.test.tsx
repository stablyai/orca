// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const SCOPE = { kind: 'turn' as const, turnItemId: 'turn-1' }
const items: AgentJournalRenderItem[] = [
  {
    itemId: 'user-1',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] }
  },
  {
    itemId: 'turn-1',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      userItemId: 'user-1',
      state: 'interrupted',
      startedAt: 2,
      completedAt: 9
    }
  },
  {
    itemId: 'reply-1',
    revision: 0,
    sequence: 3,
    observedAt: 3,
    turnScope: SCOPE,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'half' }] }
  }
]

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => null),
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
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
  structuredSessionOperationId: vi.fn(),
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

describe('useStructuredAgentSession transcript', () => {
  it('shows a cut turn no row explains with its one notice, placed in that turn', () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true
      })
    )

    expect(result.current.messages.at(-1)).toMatchObject({
      role: 'system',
      blocks: [
        {
          text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
          tone: 'error'
        }
      ]
    })
    // The list places rows by the same items, so the notice joins the cut turn.
    expect(result.current.journalItems.at(-1)).toMatchObject({ turnScope: SCOPE })
  })
})
