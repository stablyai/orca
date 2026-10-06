// A message this client did not send — the host's own restart continuation, a phone's, an
// orchestration worker's first — whose start failed for good still shows in the chat, saying why:
// on the desktop as any rejection drawn in place, on the phone by this rule alone.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { reconcileStructuredAgentSessionOutbox } from '../../../../shared/structured-agent-session-outbox-reconcile'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const DESKTOP = { rejectedInPlace: true } as const
/** The phone draws no other rejection in place: it hands its own back to its composer. */
const PHONE = { rejectedInPlace: false, showsFailedStartsSentElsewhere: true } as const

/** The desktop's notices, on a host that queues a message no agent took again. */
function notices(
  submissions: readonly AgentJournalSubmission[],
  retry: (clientMessageId: string) => void,
  retriesInPlace = true
) {
  return structuredAgentSessionDeliveryNotices(
    [],
    'Codex',
    retry,
    submissions,
    [],
    new Set(),
    [],
    new Set(),
    [],
    retriesInPlace
  )
}

const ID = '1759312345678-0123456789abcdef0123456789abcdef'
const KEY = agentJournalSubmissionKey(ID)

function item(body: AgentJournalMessageItem): AgentJournalRenderItem {
  return { itemId: KEY, revision: 0, sequence: 5, observedAt: 5, body }
}
const TEXT = item({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue where you left off' }]
})

function rejected(fact: SubmissionRejectionFact): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' })
  }
}

describe('a message sent from elsewhere whose start failed for good', () => {
  it.each([
    [{ kind: 'providerStartFailed' }, 'Codex stopped before it finished starting.'],
    [{ kind: 'hostFault' }, "Orca ran into a problem, so this didn't go through."],
    [{ kind: 'notSignedIn' }, 'Codex is not signed in for the selected account. Sign in first.']
  ] as const)('shows as unsent, says why %j, and offers a Retry', (fact, why) => {
    const submissions = [rejected(fact)]
    const retry = vi.fn()

    for (const options of [DESKTOP, PHONE]) {
      expect(projectStructuredAgentSessionMessages([TEXT], [], submissions, options)).toEqual([
        expect.objectContaining({ id: KEY, unsent: true })
      ])
    }
    const notice = notices(submissions, retry).get(KEY)
    expect(notice?.text).toBe(why)
    notice?.onRetry?.()
    expect(retry).toHaveBeenCalledWith(ID)
  })

  // An older host cannot queue it again: the desktop shows it as any rejection, with no Retry, and
  // the phone leaves it hidden, as before.
  it('offers no Retry, and the phone hides it, where the host cannot queue it again', () => {
    const submissions = [rejected({ kind: 'providerStartFailed' })]
    expect(notices(submissions, vi.fn(), false).get(KEY)).not.toHaveProperty('onRetry')
    expect(
      projectStructuredAgentSessionMessages([TEXT], [], submissions, {
        rejectedInPlace: false,
        showsFailedStartsSentElsewhere: false
      })
    ).toEqual([])
  })

  // An older host's Retry sent this desktop's own message again as a new one, under a new id, and
  // that copy went through; the host then gained Retry in place. The same words already reached the
  // agent, so the original shows no more, and offers no Retry.
  describe('sent again since as the same words', () => {
    const COPY = '1759312345999-fedcba9876543210fedcba9876543210'
    const copy = (fields: Partial<AgentJournalSubmission>): AgentJournalSubmission => ({
      ...rejected({ kind: 'providerStartFailed' }),
      clientMessageId: COPY,
      submittedAt: 9,
      reason: null,
      rejection: undefined,
      ...fields
    })
    const shown = (submissions: AgentJournalSubmission[]) => ({
      rows: projectStructuredAgentSessionMessages([TEXT], [], submissions, DESKTOP).map(
        (row) => row.id
      ),
      notice: notices(submissions, vi.fn()).get(KEY)
    })

    it.each([
      ['delivered', { dispatchState: 'accepted' }],
      ['handed over', { dispatchState: 'pending', handedOverAt: 10 }],
      // The copy, sent once the rejection was known, is the one the chat shows as not sent.
      ['rejected', { dispatchState: 'rejected', reason: 'no' }]
    ] as const)('is hidden, with no Retry, once that copy was %s', (_how, fields) => {
      expect(shown([rejected({ kind: 'providerStartFailed' }), copy(fields)])).toEqual({
        rows: [],
        notice: undefined
      })
    })

    it('still shows on the phone beside a copy that did not go through', () => {
      const failedCopy = copy({ dispatchState: 'rejected', reason: 'no' })
      expect(
        projectStructuredAgentSessionMessages(
          [TEXT],
          [],
          [rejected({ kind: 'providerStartFailed' }), failedCopy],
          PHONE
        ).map((row) => row.id)
      ).toEqual([KEY])
    })

    it.each([
      [
        'other words that went through',
        copy({ dispatchState: 'accepted', payloadFingerprint: 'other' })
      ],
      ['the same words sent before it', copy({ dispatchState: 'accepted', submittedAt: 1 })]
    ])('still shows, with its Retry, beside %s', (_case, other) => {
      const { rows, notice } = shown([rejected({ kind: 'providerStartFailed' }), other])
      expect(rows).toContain(KEY)
      expect(notice?.onRetry).toBeDefined()
    })
  })

  // The phone draws rows in the order the projection gives them; only the desktop sorts.
  it('is placed where the journal recorded it, above what came after it', () => {
    const exchange = (id: string, sequence: number, role: 'user' | 'assistant') => ({
      itemId: role === 'user' ? agentJournalSubmissionKey(id) : `codex:${id}`,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'message' as const, role, blocks: [{ type: 'text' as const, text: id }] }
    })
    const accepted = (id: string): AgentJournalSubmission => ({
      ...rejected({ kind: 'providerStartFailed' }),
      clientMessageId: id,
      dispatchState: 'accepted',
      reason: null,
      rejection: undefined
    })
    const later = '1759312345999-0123456789abcdef0123456789abcdef'
    const items = [
      exchange('first', 1, 'user'),
      exchange('first-answer', 2, 'assistant'),
      TEXT,
      exchange(later, 6, 'user'),
      exchange('later-answer', 7, 'assistant')
    ]
    const submissions = [
      accepted('first'),
      rejected({ kind: 'providerStartFailed' }),
      accepted(later)
    ]

    expect(
      projectStructuredAgentSessionMessages(items, [], submissions, PHONE).map((row) => row.id)
    ).toEqual([
      agentJournalSubmissionKey('first'),
      'codex:first-answer',
      KEY,
      agentJournalSubmissionKey(later),
      'codex:later-answer'
    ])
  })

  it('stays hidden when it failed for anything but its start, as before', () => {
    expect(
      projectStructuredAgentSessionMessages([TEXT], [], [rejected({ kind: 'queueFull' })], PHONE)
    ).toEqual([])
  })

  // A queued card's message is the card's to show and to retry; drawn again it showed twice.
  it("is never drawn for a queued card's message, whose card shows it", () => {
    const card = { ...rejected({ kind: 'providerStartFailed' }), queuedMessageId: 'card-1' }

    for (const options of [DESKTOP, PHONE]) {
      expect(projectStructuredAgentSessionMessages([TEXT], [], [card], options)).toEqual([])
    }
  })

  it('is never drawn for one an agent already took', () => {
    const handedOver = { ...rejected({ kind: 'providerStartFailed' }), handedOverAt: 5 }
    expect(projectStructuredAgentSessionMessages([TEXT], [], [handedOver], PHONE)).toEqual([])
  })
})

// A Retry in place moves the same message from rejected back to pending. A client of any version
// reads that move as it reads any send: no second bubble, and its own outbox entry sends on.
describe('a message whose start failed for good, queued again by its Retry', () => {
  const requeued: AgentJournalSubmission = {
    ...rejected({ kind: 'providerStartFailed' }),
    dispatchState: 'pending',
    reason: null,
    rejection: undefined,
    resolvedAt: null
  }

  it('is drawn once, queued, wherever it was sent from', () => {
    for (const options of [DESKTOP, PHONE]) {
      expect(projectStructuredAgentSessionMessages([TEXT], [], [requeued], options)).toEqual([
        expect.objectContaining({ id: KEY, queued: true })
      ])
    }
  })

  it("moves this desktop's own rejected entry back to sending, with its failure gone", () => {
    const own = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: ID,
        sessionId: 's',
        text: 'Continue where you left off',
        attachments: [],
        queuedAt: 1
      }),
      state: 'rejected' as const,
      lastAttemptAt: 2,
      lastFailure: { kind: 'rejected' as const, reason: 'no' }
    }

    const [entry] = reconcileStructuredAgentSessionOutbox([own], [requeued], [TEXT])

    expect(entry).toMatchObject({ clientMessageId: ID, state: 'dispatching' })
    expect(entry).not.toHaveProperty('lastFailure')
    expect(projectStructuredAgentSessionMessages([TEXT], [entry!], [requeued], DESKTOP)).toEqual([
      expect.objectContaining({ id: KEY, queued: true })
    ])
  })
})
