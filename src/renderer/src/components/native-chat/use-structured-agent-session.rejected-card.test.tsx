// @vitest-environment happy-dom

// The session controller hands the queue's live cards to the transcript: a rejected message one of
// them holds under its own id is drawn as that card, never also as a not-sent row.

import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../shared/structured-agent-session-dispatch-rejection'

let queuedMessages: AgentSessionQueuedMessage[] = []

const KEPT_BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'kept text' }]
}

const KEPT_ITEM: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey('kept'),
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: KEPT_BODY
}

const KEPT_SUBMISSION: AgentJournalSubmission = {
  clientMessageId: 'kept',
  fence: 3,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: DISPATCH_REJECTED_HOST_RESTARTED,
  rejection: { kind: 'hostRestarted' },
  submittedAt: 1,
  resolvedAt: 2
}

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => null),
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: [KEPT_ITEM],
      submissions: [KEPT_SUBMISSION],
      status: 'ready',
      error: null,
      hasOlder: false,
      queuedMessages
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    error: null,
    send: vi.fn(),
    retry: vi.fn(),
    withdrawUnsent: vi.fn()
  })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

function card(messageId: string): AgentSessionQueuedMessage {
  return {
    messageId,
    position: 1,
    body: KEPT_BODY,
    state: 'waiting'
  }
}

function keptRows(): { id: string; unsent?: true }[] {
  const { result, unmount } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'claude',
      target: { kind: 'local' },
      isVisible: true,
      composerScopeKey: 'scope-1'
    })
  )
  const rows = result.current.messages
    .filter((message) => message.id === KEPT_ITEM.itemId)
    .map(({ id, unsent }) => ({ id, ...(unsent ? { unsent } : {}) }))
  unmount()
  return rows
}

beforeEach(() => {
  queuedMessages = []
})

it('draws no row for a rejected message while a card holds it under its id', () => {
  queuedMessages = [card('kept')]
  expect(keptRows()).toEqual([])
})

it('draws it as not sent once no card holds it', () => {
  expect(keptRows()).toEqual([{ id: KEPT_ITEM.itemId, unsent: true }])
})
