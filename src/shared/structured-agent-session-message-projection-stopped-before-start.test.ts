// A send a Stop took back before the agent started it stays where it was sent, with one row after
// it saying so, on every client: the journal already holds the send and why it was refused.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION,
  NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
} from './native-chat-stopped-before-start'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let sequence = 0

function entry(itemId: string, body: AgentJournalItemBody): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    turnScope: { kind: 'thread' }
  }
}

const sent = (id: string, text: string) =>
  entry(agentJournalSubmissionKey(id), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...overrides
  }
}

const stopped = (id: string, overrides: Partial<AgentJournalSubmission> = {}) =>
  submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED, ...overrides })

/** Each row as id, role and whether it reads as stopped before it started. */
function rows(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  return projectStructuredAgentSessionMessages(items, [], submissions).map((message) => ({
    id: message.id,
    role: message.role,
    ...(message.stoppedBeforeStart ? { stoppedBeforeStart: true } : {})
  }))
}

const stopRow = (id: string) => ({
  id: `stopped-before-start:${agentJournalSubmissionKey(id)}`,
  role: 'system',
  stoppedBeforeStart: true
})

describe('a send a Stop took back before the agent started it', () => {
  it('stays where it was sent, with one row after it', () => {
    const items = [sent('warm-up', 'warm up'), sent('never-ran', 'look around')]

    expect(rows(items, [submission('warm-up'), stopped('never-ran')])).toEqual([
      { id: agentJournalSubmissionKey('warm-up'), role: 'user' },
      { id: agentJournalSubmissionKey('never-ran'), role: 'user', stoppedBeforeStart: true },
      stopRow('never-ran')
    ])
    const [, , row] = projectStructuredAgentSessionMessages(items, [], [stopped('never-ran')])
    expect(row?.blocks).toEqual([
      {
        type: 'text',
        text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
        presentation: NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
      }
    ])
    expect(row?.journalPosition).toEqual(
      projectStructuredAgentSessionMessages(items, [], [stopped('never-ran')])[1]?.journalPosition
    )
  })

  it('reads the same from the typed fact as from the older marker', () => {
    const items = [sent('never-ran', 'look around')]
    const typed = stopped('never-ran', {
      reason: 'This message was withdrawn before the agent started it.',
      rejection: { kind: 'cancelled' }
    })

    expect(rows(items, [typed])).toEqual(rows(items, [stopped('never-ran')]))
  })

  it('shares one row with the sends taken back right before it', () => {
    const items = [sent('first', 'one'), sent('second', 'two')]

    expect(rows(items, [stopped('first'), stopped('second')])).toEqual([
      { id: agentJournalSubmissionKey('first'), role: 'user', stoppedBeforeStart: true },
      { id: agentJournalSubmissionKey('second'), role: 'user', stoppedBeforeStart: true },
      stopRow('second')
    ])
  })

  it('stays in the turn that opened for it, whose end already says it was stopped', () => {
    const items = [
      sent('opened', 'look around'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: agentJournalSubmissionKey('opened')
      })
    ]

    expect(rows(items, [stopped('opened')])).toEqual([
      { id: agentJournalSubmissionKey('opened'), role: 'user' }
    ])
  })

  it('leaves a queued card to hold its own text', () => {
    const items = [sent('card-send', 'from a card')]

    expect(rows(items, [stopped('card-send', { queuedMessageId: 'card-1' })])).toEqual([])
  })

  it('keeps any other refused send out of the conversation', () => {
    const items = [sent('refused', 'hello')]

    expect(
      rows(items, [
        submission('refused', { dispatchState: 'rejected', reason: DISPATCH_REJECTED_WRITE_FAILED })
      ])
    ).toEqual([])
  })
})
