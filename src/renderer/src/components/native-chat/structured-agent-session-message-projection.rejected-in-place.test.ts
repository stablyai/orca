// A message the host accepted and then rejected stays in the desktop's chat where it was sent,
// marked not sent, from the host's own history: a crash can lose the outbox, never the host's row.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../../shared/structured-agent-session-dispatch-rejection'
import {
  projectStructuredAgentSessionMessages as projectShared,
  structuredAgentSessionCommandItemIds
} from '../../../../shared/structured-agent-session-message-projection'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

function optimisticMessage(args: {
  clientMessageId: string
  sessionId?: string
  text: string
  attachments: readonly { path: string; previewUri: string }[]
  queuedAt: number
}): StructuredAgentSessionOptimisticMessage {
  return {
    clientMessageId: args.clientMessageId,
    body: structuredAgentSessionSendBody(args.text, args.attachments),
    queuedAt: args.queuedAt
  }
}

function deliveryNotices(
  submissions: readonly AgentJournalSubmission[],
  startFailures: { kind: 'notSignedIn' }[] = [],
  commandItemIds?: ReadonlySet<string>
) {
  return structuredAgentSessionDeliveryNotices({
    pending: [],
    submissions,
    agentName: 'Claude',
    startFailures,
    ...(commandItemIds ? { commandItemIds } : {})
  })
}

function body(text: string) {
  return {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
}

// Same text, same fingerprint, as the host's body-only hash gives.
function fingerprint(text: string): string {
  return `body:${text}`
}

function userItem(id: string, sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: body(text)
  }
}

function answer(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `answer-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

function submission(
  id: string,
  text: string,
  submittedAt: number,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: fingerprint(text),
    dispatchState: 'accepted',
    providerItemId: `provider-${id}`,
    reason: null,
    submittedAt,
    resolvedAt: submittedAt,
    ...patch
  }
}

/** Rejected on the next open after a crash, before the agent ever got it. */
function restartRejected(id: string, text: string, submittedAt: number): AgentJournalSubmission {
  return submission(id, text, submittedAt, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_HOST_RESTARTED,
    rejection: { kind: 'hostRestarted' }
  })
}

function withdrawn(id: string, text: string, submittedAt: number): AgentJournalSubmission {
  return submission(id, text, submittedAt, {
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' }
  })
}

function rows(messages: ReturnType<typeof projectStructuredAgentSessionMessages>) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      id: message.id,
      text: message.blocks[0]?.type === 'text' ? message.blocks[0].text : null,
      unsent: message.unsent ?? false
    }))
}

const SEED = submission('seed', 'seed', 1)
// The one row drawn after a send a Stop took back before the agent started it.
const STOPPED_ROW = `stopped-before-start:${agentJournalSubmissionKey('stopped')}`

/** The stopped send's own row comes right after it. */
function expectStopRowRightAfterStopped(messages: readonly { id: string }[]): void {
  const ids = messages.map((message) => message.id)
  expect(ids.indexOf(STOPPED_ROW)).toBe(ids.indexOf(agentJournalSubmissionKey('stopped')) + 1)
}
const SEED_ROWS = [userItem('seed', 1, 'seed'), answer(2)]

describe('a message the host accepted and then rejected, on the desktop', () => {
  it('stays where it was sent, as not sent, with no outbox entry left after a crash', () => {
    const items = [...SEED_ROWS, userItem('lost', 3, 'fix the parser')]
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      [SEED, restartRejected('lost', 'fix the parser', 3)]
    )

    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('lost'), text: 'fix the parser', unsent: true }
    ])
    // Its place is the host's: the row keeps the journal position it was recorded at.
    expect(
      messages.find((message) => message.id === agentJournalSubmissionKey('lost'))
    ).toMatchObject({ journalPosition: { sequence: 3, index: 0 }, source: 'transcript' })
  })

  // An older host never moves it to its rejection: it stays at its submission, still drawn.
  it('keeps the position an older host gave it, however far back', () => {
    const later = Array.from({ length: 300 }, (_, index) => answer(4 + index))
    const items = [...SEED_ROWS, userItem('waited', 3, 'fix the parser'), ...later]
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      [SEED, restartRejected('waited', 'fix the parser', 3)]
    )

    expect(
      messages.find((message) => message.id === agentJournalSubmissionKey('waited'))
    ).toMatchObject({
      unsent: true,
      journalPosition: { sequence: 3, index: 0 }
    })
  })

  it('says why from the host fact, with no Retry', () => {
    const notices = deliveryNotices([SEED, restartRejected('lost', 'fix the parser', 3)])

    const notice = notices.get(agentJournalSubmissionKey('lost'))
    expect(notice?.text).toBe('Orca restarted before this message was sent.')
    expect(notice?.onDismiss).toBeUndefined()
    expect([...notices.keys()]).toEqual([agentJournalSubmissionKey('lost')])
  })

  it("says only that it was not sent when the failed start's row already says why", () => {
    const failedStart = submission('first', 'hello', 3, {
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'Claude is not signed in.',
      rejection: { kind: 'notSignedIn' }
    })
    const notices = deliveryNotices([failedStart], [{ kind: 'notSignedIn' }])

    expect(notices.get(agentJournalSubmissionKey('first'))).toEqual({
      text: 'Your message was not sent.'
    })
  })

  it('is hidden by a copy of the same body sent once its rejection was known', () => {
    // An earlier build's Retry resent it under a new id, and that copy was delivered.
    const items = [...SEED_ROWS, userItem('old', 3, 'retry me'), userItem('resent', 4, 'retry me')]
    const submissions = [
      SEED,
      restartRejected('old', 'retry me', 3),
      submission('resent', 'retry me', 4)
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('resent'), text: 'retry me', unsent: false }
    ])
  })

  it('stays when the same text was sent again before it was rejected', () => {
    // "continue", sent twice on purpose; a restart rejected the first only after the second went.
    const items = [...SEED_ROWS, userItem('first', 3, 'continue'), userItem('again', 4, 'continue')]
    const submissions = [
      SEED,
      { ...restartRejected('first', 'continue', 3), resolvedAt: 5 },
      submission('again', 'continue', 4)
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('again'), text: 'continue', unsent: false },
      // Listed after the delivered rows; its journal position keeps its place.
      { id: agentJournalSubmissionKey('first'), text: 'continue', unsent: true }
    ])
  })

  // The host re-delivers its own message under new ids; however close their times, one row stays.
  it('keeps the last of several copies rejected in the same instant', () => {
    const items = [...SEED_ROWS, userItem('a', 3, 'pointer'), userItem('b', 4, 'pointer')]
    const submissions = [
      SEED,
      restartRejected('a', 'pointer', 5),
      restartRejected('b', 'pointer', 5)
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('b'), text: 'pointer', unsent: true }
    ])
  })

  it('stays when the same body was only sent before it, or by a copy a Stop withdrew', () => {
    const items = [
      ...SEED_ROWS,
      userItem('first', 3, 'again'),
      userItem('failed', 4, 'again'),
      userItem('stopped', 5, 'again')
    ]
    const submissions = [
      SEED,
      submission('first', 'again', 3),
      restartRejected('failed', 'again', 4),
      withdrawn('stopped', 'again', 5)
    ]

    const messages = projectStructuredAgentSessionMessages(items, [], submissions)
    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('first'), text: 'again', unsent: false },
      { id: agentJournalSubmissionKey('stopped'), text: 'again', unsent: false },
      { id: agentJournalSubmissionKey('failed'), text: 'again', unsent: true }
    ])
    expectStopRowRightAfterStopped(messages)
  })

  // Its own reply reports the rejection, in the composer, as a command's.
  it('is not drawn when it was a command such as /compact', () => {
    const compact = {
      ...userItem('compact', 3, '/compact'),
      body: { ...body('/compact'), command: { name: 'compact' } }
    }
    const submissions = [SEED, restartRejected('compact', '/compact', 3)]

    expect(
      rows(projectStructuredAgentSessionMessages([...SEED_ROWS, compact], [], submissions))
    ).toEqual([{ id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }])
    // One rule decides for the rows and the notices.
    expect(
      deliveryNotices(
        submissions,
        [],
        structuredAgentSessionCommandItemIds([...SEED_ROWS, compact])
      ).size
    ).toBe(0)
  })

  it('draws a message a Stop withdrew, with its stop row, and no delivery notice', () => {
    const items = [...SEED_ROWS, userItem('stopped', 3, 'never mind')]
    const submissions = [SEED, withdrawn('stopped', 'never mind', 3)]

    const messages = projectStructuredAgentSessionMessages(items, [], submissions)
    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('stopped'), text: 'never mind', unsent: false }
    ])
    expectStopRowRightAfterStopped(messages)
    expect(deliveryNotices(submissions).size).toBe(0)
  })
})

describe("one row per rejected message, the host's", () => {
  it('drops the bubble of a send the host has rejected, for its own row', () => {
    const items = [...SEED_ROWS, userItem('held', 3, 'host copy')]
    const sent = optimisticMessage({
      clientMessageId: 'held',
      text: 'sent copy',
      attachments: [],
      queuedAt: 50
    })
    const messages = projectStructuredAgentSessionMessages(
      items,
      [sent],
      [SEED, restartRejected('held', 'host copy', 3)]
    )
    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('held'), text: 'host copy', unsent: true }
    ])
  })
})

describe('a rejected message the queue holds', () => {
  const seedRow = { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }

  // A hand-off the host rejected sends its draft back to the card list, which shows the text.
  it('is not drawn when it was a queued draft handed off', () => {
    const items = [...SEED_ROWS, userItem('handoff', 3, 'queued text')]
    const submissions = [
      SEED,
      { ...restartRejected('handoff', 'queued text', 3), queuedMessageId: 'card-1' }
    ]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([seedRow])
    expect(deliveryNotices(submissions).size).toBe(0)
  })

  // A send kept across a restart comes back as a paused card; the send itself records that card.
  // The card's Edit and Delete remove it, so nothing but that record may hide the send.
  it('is never drawn once kept as a card, with the card there, deleted, or edited and sent', () => {
    const items = [...SEED_ROWS, userItem('kept', 3, 'kept text')]
    const kept = { ...restartRejected('kept', 'kept text', 3), keptAsQueuedMessageId: 'kept' }
    const submissions = [SEED, kept]

    // The card is there, or Delete took it: the transcript reads only the send.
    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([seedRow])
    expect(deliveryNotices(submissions).size).toBe(0)
    // Edit put the text in the composer and the person sent it as a new message.
    const edited = submission('edited', 'kept text, edited', 5)
    expect(
      rows(
        projectStructuredAgentSessionMessages(
          [...items, userItem('edited', 5, 'kept text, edited')],
          [],
          [...submissions, edited]
        )
      )
    ).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('edited'), text: 'kept text, edited', unsent: false }
    ])
  })

  it('is drawn as not sent when it was rejected without being kept', () => {
    const items = [...SEED_ROWS, userItem('lost', 3, 'lost text')]
    const submissions = [SEED, restartRejected('lost', 'lost text', 3)]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions))).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('lost'), text: 'lost text', unsent: true }
    ])
  })
})

describe('the phone', () => {
  it('still hides a message the host failed to deliver, but draws one a Stop withdrew', () => {
    const items = [
      ...SEED_ROWS,
      userItem('lost', 3, 'fix the parser'),
      userItem('stopped', 4, 'never mind')
    ]
    const submissions = [
      SEED,
      restartRejected('lost', 'fix the parser', 3),
      withdrawn('stopped', 'never mind', 4)
    ]

    const messages = projectShared(items, [], submissions, { rejectedInPlace: false })
    expect(rows(messages)).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('stopped'), text: 'never mind', unsent: false }
    ])
    expectStopRowRightAfterStopped(messages)
  })
})
