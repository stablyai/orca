// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { useStructuredAgentSession } from './use-structured-agent-session'

const items: AgentJournalRenderItem[] = [
  {
    itemId: 'turn-1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
  },
  {
    itemId: 'question-1',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'question',
      question: 'Which approach?',
      options: [{ id: 'focused', label: 'Focused' }],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
]

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn().mockResolvedValue(null)
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
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

it('keeps a prompted provider turn working and cancellable beneath presentation policy', () => {
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )

  expect(result.current.isWorking).toBe(true)
  expect(result.current.turnId).toBe('provider-turn')
  expect(result.current.prompts).toHaveLength(1)
})
