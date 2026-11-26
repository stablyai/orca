import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentMessageSource } from '../journal/agent-session-message-source'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage
} from '../requests/agent-session-queued-message-wire'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from '../requests/structured-agent-session-dispatch-rejection'
import { agentMessageWaitingQueuedId } from './messages/agent-message-presentation'
import {
  projectStructuredAgentSessionMessages,
  type StructuredAgentSessionOptimisticMessage
} from './structured-agent-session-message-projection'
import {
  projectQueuedMessageCards,
  queuedMessagesQueuePause
} from './structured-agent-session-queued-cards'
import {
  composerQueuedCards,
  createWaitingAgentMailRows
} from './structured-agent-session-waiting-agent-mail'

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_w', terminalHandle: 'term_w', orcaSessionId: null },
      name: 'Worker',
      agent: 'claude'
    }
  ],
  orchestration: null
}

function card(
  id: string,
  position: number,
  overrides: Partial<AgentSessionQueuedMessage> = {},
  from: AgentMessageSource | null = FROM
): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `text of ${id}` }],
      ...(from ? { from } : {})
    },
    state: 'waiting',
    ...overrides
  }
}

const personCard = (id: string, position: number) => card(id, position, {}, null)

/** The host's record of a card it took off the queue to hand over. */
function handOff(
  queuedMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: `${queuedMessageId}-send`,
    fence: 1,
    payloadFingerprint: 'body',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true,
    queuedMessageId,
    ...overrides
  }
}

const rejectedAs = (reason: string): Partial<AgentJournalSubmission> => ({
  dispatchState: 'rejected',
  reason,
  resolvedAt: 2
})

/** The hand-off's own transcript row, which the host writes as it takes the card. */
function sentRow(queuedMessageId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: `orca:${queuedMessageId}-send`,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `text of ${queuedMessageId}` }],
      from: FROM
    },
    turnScope: { kind: 'thread' }
  }
}

/** What a chat draws for the host's published state: the transcript's rows, then the waiting mail
 *  drawn after its live activity, and the composer's cards. */
function drawn(host: {
  queued?: AgentSessionQueuedMessage[]
  submissions?: AgentJournalSubmission[]
  items?: AgentJournalRenderItem[]
  sends?: StructuredAgentSessionOptimisticMessage[]
  queuePaused?: boolean
  editing?: string
}) {
  const { queued = [], submissions = [], items = [], sends = [] } = host
  const mail = createWaitingAgentMailRows()(queued, submissions)
  const { cards, agentMail } = composerQueuedCards(
    projectQueuedMessageCards(queued, submissions, {
      agentWorking: true,
      queuePaused: host.queuePaused === true
    }),
    mail,
    host.editing
  )
  return {
    rows: [...projectStructuredAgentSessionMessages(items, sends, submissions), ...agentMail].map(
      (row) => ({
        id: row.id,
        by: row.from ? 'agent' : 'person',
        waiting: row.queued === true,
        actsOn: agentMessageWaitingQueuedId(row)
      })
    ),
    cards: cards.map((each) => each.messageId)
  }
}

const waitingRow = (id: string) => ({
  id: `orca:${id}`,
  by: 'agent',
  waiting: true,
  actsOn: id
})

describe("another agent's message while the chat is busy", () => {
  it('waits at the transcript end, never in the composer queue', () => {
    expect(drawn({ queued: [card('mail', 1)] })).toEqual({
      rows: [waitingRow('mail')],
      cards: []
    })
  })

  it('several at once wait in arrival order, each once', () => {
    expect(drawn({ queued: [card('c', 3), card('a', 1), card('b', 2)] })).toEqual({
      rows: [waitingRow('a'), waitingRow('b'), waitingRow('c')],
      cards: []
    })
  })

  it("a follow-up the person queues after it keeps the composer's queue", () => {
    expect(drawn({ queued: [card('mail', 1), personCard('follow-up', 2)] })).toEqual({
      rows: [waitingRow('mail')],
      cards: ['follow-up']
    })
  })

  it("follows the person's message that still says Sending…", () => {
    const sending: StructuredAgentSessionOptimisticMessage = {
      clientMessageId: 'typed',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      queuedAt: 1,
      phase: 'sending'
    }
    expect(drawn({ sends: [sending], queued: [card('mail', 1)] }).rows).toEqual([
      { id: 'orca:typed', by: 'person', waiting: false, actsOn: null },
      waitingRow('mail')
    ])
  })

  it('goes solid in place once the host takes it, with no Steer or Delete left', () => {
    expect(
      drawn({
        queued: [card('mail', 1)],
        submissions: [handOff('mail')],
        items: [sentRow('mail', 5)]
      })
    ).toEqual({
      rows: [{ id: 'orca:mail-send', by: 'agent', waiting: false, actsOn: null }],
      cards: []
    })
  })

  it('Stop before the agent takes it keeps it waiting, with Steer and Delete', () => {
    expect(drawn({ queued: [card('mail', 1)], queuePaused: true })).toEqual({
      rows: [waitingRow('mail')],
      cards: []
    })
  })

  it('Stop after the host took it puts the one row back, never two', () => {
    expect(
      drawn({
        queued: [card('mail', 1)],
        submissions: [handOff('mail', rejectedAs(DISPATCH_REJECTED_CANCELLED))],
        items: [sentRow('mail', 5)],
        queuePaused: true
      })
    ).toEqual({ rows: [waitingRow('mail')], cards: [] })
  })

  it('after a restart, a close or the agent exiting it waits again in the same row', () => {
    for (const reason of [DISPATCH_REJECTED_HOST_RESTARTED, DISPATCH_REJECTED_PROVIDER_CLOSED]) {
      expect(
        drawn({
          queued: [card('mail', 1)],
          submissions: [handOff('mail', rejectedAs(reason))],
          items: [sentRow('mail', 5)]
        })
      ).toEqual({ rows: [waitingRow('mail')], cards: [] })
    }
  })

  it('a send that failed or came back is a card again, where its caption says why', () => {
    expect(
      drawn({
        queued: [
          card('failed', 1, { paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }),
          card('returned', 2, { state: 'returned', returnedReason: 'The agent exited' })
        ]
      })
    ).toEqual({ rows: [], cards: ['failed', 'returned'] })
  })

  it('Steer while the turn runs keeps it in its row until the turn takes it', () => {
    expect(drawn({ queued: [card('mail', 1, { steers: true })] })).toEqual({
      rows: [waitingRow('mail')],
      cards: []
    })
  })
})

describe("worker mail, which the host delivers past a Stop and ahead of the person's queue", () => {
  const mailNotice: AgentMessageSource = {
    ...FROM,
    orchestration: {
      message: 'mail-notice',
      mailbox: 'orca_session_id:chat',
      dispatchId: null,
      messages: [{ messageId: 'msg_1', runId: '', from: 'orca_session_id:worker' }]
    }
  }

  it('derives a readable subject from an existing queued envelope', () => {
    const subject = `${'Re: '.repeat(42)}re:build notes`
    const body = 'Re: Re: Body text'
    const text = `${subject}\n${body}`
    const queued = card('mail', 1, { paused: true })
    queued.body.blocks = [{ type: 'text', text }]
    queued.body.from = {
      ...mailNotice,
      orchestration: {
        message: 'mail-notice',
        mailbox: 'orca_session_id:chat',
        dispatchId: null,
        messages: [
          {
            messageId: 'msg_1',
            runId: '',
            from: 'orca_session_id:worker',
            content: { subject: [0, subject.length], body: [subject.length + 1, text.length] }
          }
        ]
      }
    }
    const [projected] = projectQueuedMessageCards([queued], [], { queuePaused: true })
    expect(projected).toMatchObject({
      text,
      displayText: `Re: re:build notes\n\n${body}`
    })
  })

  it("after Stop goes solid as the host sends it, while the person's held follow-up keeps its card", () => {
    const queued = [personCard('follow-up', 1), card('mail', 2, {}, mailNotice)]
    expect(drawn({ queued, queuePaused: true })).toEqual({
      rows: [waitingRow('mail')],
      cards: ['follow-up']
    })
    expect(
      drawn({
        queued,
        submissions: [handOff('mail', { handedOverAt: 3 })],
        items: [sentRow('mail', 5)],
        queuePaused: true
      })
    ).toEqual({
      rows: [{ id: 'orca:mail-send', by: 'agent', waiting: false, actsOn: null }],
      cards: ['follow-up']
    })
  })

  it("steered into the running turn ahead of the person's earlier follow-up, it leaves that card waiting", () => {
    expect(
      drawn({
        queued: [personCard('follow-up', 1), card('mail', 2, {}, mailNotice)],
        submissions: [handOff('mail')],
        items: [sentRow('mail', 5)]
      })
    ).toEqual({
      rows: [{ id: 'orca:mail-send', by: 'agent', waiting: false, actsOn: null }],
      cards: ['follow-up']
    })
  })
})

it('keeps the same rows across a queue change that leaves the waiting mail alone', () => {
  const rowsOf = createWaitingAgentMailRows()
  const before = rowsOf([card('mail', 1), personCard('a', 2), personCard('b', 3)], [])
  // A fresh publication of the same mail, after the person reorders their own follow-ups.
  const after = rowsOf([card('mail', 1), personCard('b', 2), personCard('a', 3)], [])
  expect(after).toBe(before)
  expect(rowsOf([card('mail', 1), card('more', 2)], []).length).toBe(2)
})

it('Edit opens a waiting message in the queue editor, and its row steps aside meanwhile', () => {
  expect(drawn({ queued: [card('mail', 1), card('other', 2)], editing: 'mail' })).toEqual({
    rows: [waitingRow('other')],
    cards: ['mail']
  })
})

it('keeps Resume while a paused queue holds only agent mail the transcript draws', () => {
  const pause = { reason: 'failed' as const }
  expect(queuedMessagesQueuePause([], pause, true)).toBe(pause)
  expect(queuedMessagesQueuePause([], pause)).toBeNull()
})

it("the steer shortcut presses waiting mail at the queue's head, not the follow-up behind it", () => {
  const queued = [card('mail', 1), personCard('follow-up', 2)]
  const cards = projectQueuedMessageCards(queued, [], { agentWorking: true, queuePaused: false })
  const mail = createWaitingAgentMailRows()(queued, [])
  expect(composerQueuedCards(cards, mail, undefined).mailLeads).toBe(true)
  expect(composerQueuedCards(cards, mail, 'mail').mailLeads).toBe(false)
  expect(composerQueuedCards(cards.toReversed(), mail, undefined).mailLeads).toBe(false)
})
