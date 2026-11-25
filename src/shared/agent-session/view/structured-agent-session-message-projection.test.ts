// A send the host kept as a card is drawn only as that card: the rule rides on the submission's
// own fact, never on the card still being there.

import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../failures/agent-session-failure'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const KEPT_ID = 'client-kept'

function rejected(fields: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: KEPT_ID,
    fence: 1,
    payloadFingerprint: 'fingerprint-kept',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'Orca restarted before this message was sent.',
    rejection: { kind: 'hostRestarted' },
    submittedAt: 1,
    resolvedAt: 2,
    ...fields
  }
}

function userItem(id: string, text: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

it('a row retry becomes one sent message, while a separate composer send keeps the unsent row', () => {
  const a = rejected({
    rejection: agentSessionFailureFact('startFailed', {
      instructionRecovery: 'timeout',
      neverReachedAgent: true
    })
  })
  const b = rejected({
    clientMessageId: 'explicit-retry',
    submittedAt: 3,
    resolvedAt: 4,
    dispatchState: 'accepted',
    rejection: undefined,
    retryOfClientMessageId: KEPT_ID
  })
  const items = [
    userItem(KEPT_ID, 'the kept words', 1),
    userItem('explicit-retry', 'the kept words', 3)
  ]
  expect(projectStructuredAgentSessionMessages(items, [], [a, b])).toEqual([
    expect.objectContaining({ id: agentJournalSubmissionKey('explicit-retry'), timestamp: 3 })
  ])
  expect(
    projectStructuredAgentSessionMessages(
      items,
      [],
      [a, { ...b, retryOfClientMessageId: undefined }]
    )
  ).toEqual([
    expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true }),
    expect.objectContaining({ id: agentJournalSubmissionKey('explicit-retry'), timestamp: 3 })
  ])
})

it('a refused retry keeps one copy of the retained task', () => {
  const a = rejected({
    rejection: agentSessionFailureFact('startFailed', {
      instructionRecovery: 'timeout',
      neverReachedAgent: true
    })
  })
  const b = rejected({
    clientMessageId: 'explicit-retry',
    submittedAt: 3,
    resolvedAt: 4,
    retryOfClientMessageId: KEPT_ID,
    rejection: agentSessionFailureFact('startFailed', {
      instructionRecovery: 'pending',
      neverReachedAgent: true
    })
  })
  expect(
    projectStructuredAgentSessionMessages(
      [userItem(KEPT_ID, 'the kept words', 1), userItem('explicit-retry', 'the kept words', 3)],
      [],
      [a, b]
    )
  ).toEqual([expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true })])
})

it('keeps only the current off-page retry and retires it when another sibling accepts', () => {
  const failure = agentSessionFailureFact('startFailed', {
    instructionRecovery: 'timeout',
    neverReachedAgent: true
  })
  const a = rejected({ rejection: failure })
  const b = rejected({
    clientMessageId: 'retry-b',
    retryOfClientMessageId: KEPT_ID,
    rejection: failure,
    submittedAt: 3
  })
  const c = rejected({
    clientMessageId: 'retry-c',
    retryOfClientMessageId: KEPT_ID,
    rejection: failure,
    submittedAt: 4
  })
  const bRow = userItem('retry-b', 'the kept words', 3)
  const cRow = userItem('retry-c', 'the kept words', 4)
  const ids = (items: AgentJournalRenderItem[], sends: AgentJournalSubmission[]) =>
    projectStructuredAgentSessionMessages(items, [], sends).map(({ id }) => id)
  expect(ids([bRow, cRow], [b, c])).toEqual([cRow.itemId])
  expect(ids([bRow], [{ ...b, submittedAt: c.submittedAt, retryLineage: c }])).toEqual([])
  const aRow = userItem(KEPT_ID, 'the kept words', 1)
  expect(ids([aRow, bRow, cRow], [a, b, c])).toEqual([aRow.itemId])
  const accepted = { ...c, dispatchState: 'accepted' as const, rejection: undefined }
  expect(ids([bRow, cRow], [b, accepted])).toEqual([cRow.itemId])
  expect(ids([bRow], [{ ...b, retryLineage: accepted }])).toEqual([])
  expect(ids([aRow], [{ ...a, retryLineage: accepted }])).toEqual([])
  const pending = { ...c, dispatchState: 'pending' as const, rejection: undefined }
  expect(ids([bRow, cRow], [b, pending])).toEqual([cRow.itemId])
  const independent = { ...accepted, retryOfClientMessageId: undefined }
  expect(ids([bRow, cRow], [b, independent])).toEqual([bRow.itemId, cRow.itemId])
})

it('keeps an uncertain retry visible without calling that attempt unsent', () => {
  const a = rejected({
    rejection: agentSessionFailureFact('startFailed', {
      instructionRecovery: 'timeout',
      neverReachedAgent: true
    })
  })
  const b = rejected({
    clientMessageId: 'uncertain-b',
    dispatchState: 'unknown',
    retryOfClientMessageId: KEPT_ID,
    rejection: undefined
  })
  expect(
    projectStructuredAgentSessionMessages(
      [userItem(KEPT_ID, 'the kept words', 1), userItem('uncertain-b', 'the kept words', 3)],
      [],
      [a, b]
    )
  ).toEqual([
    expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true }),
    expect.objectContaining({
      id: agentJournalSubmissionKey('uncertain-b'),
      deliveryState: 'unknown'
    })
  ])
})
