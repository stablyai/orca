// @vitest-environment happy-dom

// A send whose own reply says the host recorded it and then rejected it is shown once, in the chat
// where it was sent; its text never also goes back to the composer.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_NOT_DELIVERED } from '../../../../shared/structured-agent-session-dispatch-rejection'

type SendParams = { envelope: { clientOperationId: string; payloadFingerprint: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: SendParams) => Promise<unknown>>()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const NO_JOURNAL_ITEMS: readonly AgentJournalRenderItem[] = []

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

it('draws a send its reply rejected in place once, and leaves the composer empty', async () => {
  const reply: { submission: AgentJournalSubmission | null } = { submission: null }
  mocks.call.mockImplementationOnce(async (_target, _method, { envelope }) => {
    const rejected: AgentJournalSubmission = {
      clientMessageId: envelope.clientOperationId,
      fence: 1,
      payloadFingerprint: envelope.payloadFingerprint,
      dispatchState: 'rejected',
      providerItemId: null,
      reason: DISPATCH_REJECTED_NOT_DELIVERED,
      rejection: { kind: 'notDelivered' },
      submittedAt: 10,
      resolvedAt: 11
    }
    reply.submission = rejected
    return {
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 10 },
      value: { clientMessageId: envelope.clientOperationId, submission: rejected }
    }
  })
  const { result } = renderHook(() =>
    useStructuredAgentSessionOutbox({
      journalItems: NO_JOURNAL_ITEMS,
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      composerScopeKey: 'pane-1'
    })
  )

  act(() => expect(result.current.send('steer this way')).toBe(true))
  await waitFor(() => expect(result.current.outbox[0]?.state).toBe('rejected'))
  expect(readNativeChatDraftCache('pane-1')).toBe('')

  const submission = reply.submission
  if (!submission) {
    throw new Error('the send was never answered')
  }
  const hostItem: AgentJournalRenderItem = {
    itemId: agentJournalSubmissionKey(submission.clientMessageId),
    revision: 1,
    sequence: 10,
    observedAt: 10,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'steer this way' }] }
  }
  const users = (outbox: typeof result.current.outbox) =>
    projectStructuredAgentSessionMessages([hostItem], outbox, [submission])
      .filter((message) => message.role === 'user')
      .map((message) => ({ id: message.id, unsent: message.unsent }))

  expect(users(result.current.outbox)).toEqual([{ id: hostItem.itemId, unsent: true }])
  // After a crash takes the outbox, the host's row is still the one row.
  expect(users([])).toEqual([{ id: hostItem.itemId, unsent: true }])
  expect(readNativeChatDraftCache('pane-1')).toBe('')
})
