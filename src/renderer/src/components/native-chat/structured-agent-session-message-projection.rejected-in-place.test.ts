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
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const NO_CARDS: readonly string[] = []

const SESSION = 'session-1'

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

function outboxEntry(
  id: string,
  text: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: id,
      sessionId: SESSION,
      text,
      attachments: [],
      queuedAt: 50
    }),
    ...patch
  }
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
const SEED_ROWS = [userItem('seed', 1, 'seed'), answer(2)]

describe('a message the host accepted and then rejected, on the desktop', () => {
  it('stays where it was sent, as not sent, with no outbox entry left after a crash', () => {
    const items = [...SEED_ROWS, userItem('lost', 3, 'fix the parser')]
    const messages = projectStructuredAgentSessionMessages(
      items,
      [],
      [SEED, restartRejected('lost', 'fix the parser', 3)],
      NO_CARDS
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
      [SEED, restartRejected('waited', 'fix the parser', 3)],
      NO_CARDS
    )

    expect(
      messages.find((message) => message.id === agentJournalSubmissionKey('waited'))
    ).toMatchObject({
      unsent: true,
      journalPosition: { sequence: 3, index: 0 }
    })
  })

  it('says why from the host fact, with no Retry', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Claude',
      () => {},
      [SEED, restartRejected('lost', 'fix the parser', 3)],
      [],
      new Set()
    )

    const notice = notices.get(agentJournalSubmissionKey('lost'))
    expect(notice?.text).toBe('Orca restarted before this message was sent.')
    expect(notice?.onRetry).toBeUndefined()
    expect([...notices.keys()]).toEqual([agentJournalSubmissionKey('lost')])
  })

  it("says only that it was not sent when the failed start's row already says why", () => {
    const failedStart = submission('first', 'hello', 3, {
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'Claude is not signed in.',
      rejection: { kind: 'notSignedIn' }
    })
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Claude',
      () => {},
      [failedStart],
      [{ kind: 'notSignedIn' }],
      new Set()
    )

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

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
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

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
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

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
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

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false },
      { id: agentJournalSubmissionKey('first'), text: 'again', unsent: false },
      { id: agentJournalSubmissionKey('failed'), text: 'again', unsent: true }
    ])
  })

  // Its own reply reports the rejection, in the composer, as a command's.
  it('is not drawn when it was a command such as /compact', () => {
    const compact = {
      ...userItem('compact', 3, '/compact'),
      body: { ...body('/compact'), command: { name: 'compact' } }
    }
    const submissions = [SEED, restartRejected('compact', '/compact', 3)]

    expect(
      rows(
        projectStructuredAgentSessionMessages([...SEED_ROWS, compact], [], submissions, NO_CARDS)
      )
    ).toEqual([{ id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }])
    // One rule decides for the rows and the notices.
    expect(
      structuredAgentSessionDeliveryNotices(
        [],
        'Claude',
        () => {},
        submissions,
        [],
        new Set(),
        NO_CARDS,
        structuredAgentSessionCommandItemIds([...SEED_ROWS, compact])
      ).size
    ).toBe(0)
  })

  it('keeps a message a Stop withdrew hidden: it went back to its sender', () => {
    const items = [...SEED_ROWS, userItem('stopped', 3, 'never mind')]
    const submissions = [SEED, withdrawn('stopped', 'never mind', 3)]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }
    ])
    expect(
      structuredAgentSessionDeliveryNotices([], 'Claude', () => {}, submissions, [], new Set()).size
    ).toBe(0)
  })
})

describe("one row per rejected message, the host's once it records the rejection", () => {
  const items = [...SEED_ROWS, userItem('held', 3, 'host copy')]
  // Fingerprinted from the host's own copy, so only the shared id ties the two rows together.
  const rejected = restartRejected('held', 'host copy', 3)
  const held = outboxEntry('held', 'outbox copy', {
    state: 'rejected',
    lastFailure: {
      kind: 'rejected',
      reason: DISPATCH_REJECTED_HOST_RESTARTED,
      rejection: { kind: 'hostRestarted' }
    }
  })
  const heldRow = { id: agentJournalSubmissionKey('held'), text: 'outbox copy', unsent: true }
  const hostRow = { id: agentJournalSubmissionKey('held'), text: 'host copy', unsent: true }
  const seedRow = { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }

  it('the reply first: the outbox draws it, saying why, with no Retry', () => {
    const messages = projectStructuredAgentSessionMessages(SEED_ROWS, [held], [SEED], NO_CARDS)
    expect(rows(messages)).toEqual([seedRow, heldRow])
    const notice = structuredAgentSessionDeliveryNotices(
      [held],
      'Claude',
      () => {},
      [SEED],
      [],
      new Set(['held'])
    ).get(heldRow.id)
    expect(notice?.text).toBe('Orca restarted before this message was sent.')
    expect(notice?.onRetry).toBeUndefined()
  })

  it("the journal first, or next: the host's row replaces the outbox copy at once", () => {
    const dispatching = { ...held, state: 'dispatching' as const, lastFailure: undefined }
    expect(
      rows(projectStructuredAgentSessionMessages(SEED_ROWS, [dispatching], [SEED], NO_CARDS))
    ).toEqual([seedRow, { ...heldRow, unsent: false }])
    for (const entry of [dispatching, held]) {
      // Before the reconcile drops the entry, the host's row is already the one row.
      const messages = projectStructuredAgentSessionMessages(
        items,
        [entry],
        [SEED, rejected],
        NO_CARDS
      )
      expect(rows(messages)).toEqual([seedRow, hostRow])
      expect(messages.at(-1)?.journalPosition).toEqual({ sequence: 3, index: 0 })
      const notices = structuredAgentSessionDeliveryNotices(
        [entry],
        'Claude',
        () => {},
        [SEED, rejected],
        [],
        new Set()
      )
      // In the host's words, with no control.
      expect([...notices]).toEqual([
        [hostRow.id, { text: 'Orca restarted before this message was sent.' }]
      ])
    }
  })

  it("keeps the old row beside an earlier build's resend until the host records the resend", () => {
    const hostItems = [...SEED_ROWS, userItem('held', 3, 'outbox copy')]
    const resent = restartRejected('held', 'outbox copy', 3)
    const resend = outboxEntry('resend', 'outbox copy')
    expect(
      rows(projectStructuredAgentSessionMessages(hostItems, [resend], [SEED, resent], NO_CARDS))
    ).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('held'), text: 'outbox copy', unsent: true },
      { id: agentJournalSubmissionKey('resend'), text: 'outbox copy', unsent: false }
    ])

    const recorded = submission('resend', 'outbox copy', 60, {
      dispatchState: 'pending',
      providerItemId: null,
      resolvedAt: null
    })
    expect(
      rows(
        projectStructuredAgentSessionMessages(
          [...hostItems, userItem('resend', 4, 'outbox copy')],
          [resend],
          [SEED, resent, recorded],
          NO_CARDS
        )
      )
    ).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('resend'), text: 'outbox copy', unsent: false }
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

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, NO_CARDS))).toEqual([
      seedRow
    ])
    expect(
      structuredAgentSessionDeliveryNotices([], 'Claude', () => {}, submissions, [], new Set()).size
    ).toBe(0)
  })

  // A send kept across a restart comes back as a paused card under its own id.
  it('is not drawn while a card holds it under its id, and is drawn once that card is gone', () => {
    const items = [...SEED_ROWS, userItem('kept', 3, 'kept text')]
    const submissions = [SEED, restartRejected('kept', 'kept text', 3)]

    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, ['kept']))).toEqual([
      seedRow
    ])
    expect(
      structuredAgentSessionDeliveryNotices([], 'Claude', () => {}, submissions, [], new Set(), [
        'kept'
      ]).size
    ).toBe(0)
    expect(rows(projectStructuredAgentSessionMessages(items, [], submissions, []))).toEqual([
      seedRow,
      { id: agentJournalSubmissionKey('kept'), text: 'kept text', unsent: true }
    ])
  })
})

describe('the phone', () => {
  it('still hides every accepted-then-rejected message: it gives the text back to its composer', () => {
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

    expect(rows(projectShared(items, [], submissions, { rejectedInPlace: false }))).toEqual([
      { id: agentJournalSubmissionKey('seed'), text: 'seed', unsent: false }
    ])
  })
})
