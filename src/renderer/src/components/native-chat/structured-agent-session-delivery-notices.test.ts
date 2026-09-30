import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'

function entry(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

function texts(
  outbox: StructuredAgentSessionOutboxEntry[],
  blocked: string | null = null,
  submissions: readonly AgentJournalSubmission[] = [],
  startFailures: readonly AgentSessionFailureFact[] = []
): Record<string, string> {
  const notices = structuredAgentSessionDeliveryNotices(
    outbox,
    blocked,
    'Claude',
    () => {},
    submissions,
    startFailures
  )
  return Object.fromEntries([...notices].map(([id, notice]) => [id, notice.text]))
}

describe('the notice on each message that did not go through', () => {
  it('gives two failed messages each their own reason and their own Retry', () => {
    const retry = vi.fn()
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('first', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason: 'Claude messages support at most 20 images' }
        }),
        entry('second', {
          state: 'rejected',
          lastFailure: {
            kind: 'rejected',
            reason: 'Claude never finished starting, so Orca stopped it.',
            rejection: { kind: 'hostStopped' }
          }
        })
      ],
      null,
      'Claude',
      retry,
      [],
      []
    )

    expect([...notices.keys()]).toEqual([
      agentJournalSubmissionKey('first'),
      agentJournalSubmissionKey('second')
    ])
    expect(notices.get(agentJournalSubmissionKey('first'))?.text).toBe(
      'Claude messages support at most 20 images'
    )
    expect(notices.get(agentJournalSubmissionKey('second'))?.text).toBe(
      'Claude never finished starting, so Orca stopped it.'
    )
    notices.get(agentJournalSubmissionKey('second'))?.onRetry?.()
    expect(retry).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('chooses the words from the saved refusal on the message the queue stopped on', () => {
    expect(
      texts(
        [
          entry('held', {
            lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
          })
        ],
        'held'
      )
    ).toEqual({
      [agentJournalSubmissionKey('held')]: "The agent couldn't restart. Your message was not sent."
    })
  })

  // The same rule as a rejected row's: its own Retry is the resend step, and any other step stays.
  it('leaves a retry step to the Retry beside the message the queue stopped on', () => {
    const held = (lastFailure: StructuredAgentSessionOutboxEntry['lastFailure']) =>
      texts([entry('held', { lastFailure })], 'held')
    expect(
      held({
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      })
    ).toEqual({
      [agentJournalSubmissionKey('held')]:
        "Orca couldn't open this chat's history right now. Your message was not sent."
    })
    expect(
      held({
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn' }
      })
    ).toEqual({
      [agentJournalSubmissionKey('held')]:
        'Your message was not sent. Claude is not signed in for the selected account. Sign in first.'
    })
  })

  it('says a message is unconfirmed, and only that it was not sent when nothing more is known', () => {
    expect(texts([entry('doubt', { state: 'unconfirmed' })])).toEqual({
      [agentJournalSubmissionKey('doubt')]: 'Message delivery is unconfirmed.'
    })
    expect(texts([entry('bare')], 'bare')).toEqual({
      [agentJournalSubmissionKey('bare')]: 'Message was not sent.'
    })
  })

  it('never says a send attempted before a Stop was not sent: the host may hold it', () => {
    const interrupted = entry('stopped', { state: 'queued', lastAttemptAt: 5, outlivedStop: true })
    expect(texts([interrupted], 'stopped')).toEqual({
      [agentJournalSubmissionKey('stopped')]: 'Message delivery is unconfirmed.'
    })
    const neverSent = entry('unsent', { state: 'queued', outlivedStop: true })
    expect(texts([neverSent], 'unsent')).toEqual({
      [agentJournalSubmissionKey('unsent')]: 'Message was not sent.'
    })
  })

  // The drain's own rule: a message behind the one the queue stopped on is only waiting, so it says
  // nothing. A rejected message holds nothing up and keeps its words.
  it('says why on the message the queue stopped on and on every rejected one', () => {
    expect(
      texts([
        entry('sent', { state: 'dispatching' }),
        entry('rejected', { state: 'rejected' }),
        entry('stuck', { state: 'unconfirmed' }),
        entry('behind', { state: 'unconfirmed' }),
        entry('queued')
      ])
    ).toEqual({
      [agentJournalSubmissionKey('rejected')]: 'Message was not sent.',
      [agentJournalSubmissionKey('stuck')]: 'Message delivery is unconfirmed.'
    })
  })

  // Its Retry would put it back in the queue to wait unseen behind the stopped message.
  it('keeps a rejected message its words but not its Retry while the queue is stopped', () => {
    const retry = vi.fn()
    for (const [outbox, blocked] of [
      [[entry('stuck', { state: 'unconfirmed' }), entry('rejected', { state: 'rejected' })], null],
      [[entry('rejected', { state: 'rejected' }), entry('held')], 'held']
    ] as const) {
      const notices = structuredAgentSessionDeliveryNotices(
        [...outbox],
        blocked,
        'Claude',
        retry,
        [],
        []
      )
      expect(notices.get(agentJournalSubmissionKey('rejected'))).toEqual({
        text: 'Message was not sent.'
      })
    }
  })

  // Beside its own Retry the resend step is the button; without one the words keep it.
  it('leaves out sending again only where the message has its own Retry', () => {
    const startFailed = (clientMessageId: string): StructuredAgentSessionOutboxEntry =>
      entry(clientMessageId, {
        state: 'rejected',
        lastFailure: {
          kind: 'rejected',
          reason: 'Claude stopped before it finished starting. Send your message to try again.',
          rejection: { kind: 'providerStartFailed' }
        }
      })
    expect(texts([startFailed('first'), startFailed('second')])).toEqual({
      [agentJournalSubmissionKey('first')]: 'Claude stopped before it finished starting.',
      [agentJournalSubmissionKey('second')]: 'Claude stopped before it finished starting.'
    })
    expect(texts([startFailed('rejected'), entry('held')], 'held')).toMatchObject({
      [agentJournalSubmissionKey('rejected')]:
        'Claude stopped before it finished starting. Send your message to try again.'
    })
  })

  it.each([
    [
      'notDelivered',
      'This message was not delivered. Send it again to continue.',
      'This message was not delivered.'
    ],
    [
      'hostFault',
      "Orca ran into a problem, so this didn't go through. Try again.",
      "Orca ran into a problem, so this didn't go through."
    ]
  ] as const)('leaves the step to the Retry beside a %s message', (kind, reason, shown) => {
    expect(
      texts([
        entry('rejected', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason, rejection: { kind } }
        })
      ])
    ).toEqual({ [agentJournalSubmissionKey('rejected')]: shown })
  })

  // The journal holds the whole fact; the message's own copy keeps only its kind and attachment.
  it("words a recorded rejection from the journal's fact, whatever reason the host wrote", () => {
    const rejected = (id: string): StructuredAgentSessionOutboxEntry =>
      entry(id, {
        state: 'rejected',
        // An older host's words, and not the pane's agent name: never compared, never shown.
        lastFailure: {
          kind: 'rejected',
          reason: "The agent couldn't be started.",
          rejection: { kind: 'startFailed' }
        }
      })
    const recorded = (id: string, rejection: AgentSessionFailureFact): AgentJournalSubmission => ({
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'rejected',
      providerItemId: null,
      reason: "The agent couldn't be started.",
      rejection,
      submittedAt: 1,
      resolvedAt: 1
    })
    const facts: [string, AgentSessionFailureFact, string][] = [
      [
        'gone',
        {
          kind: 'startFailed',
          refusal: {
            code: 'agent_session_identity_required',
            details: { reason: 'recordMissing' }
          }
        },
        "Claude couldn't start. Start a new chat to continue."
      ],
      [
        'claimed',
        {
          kind: 'startFailed',
          refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
        },
        "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
      ],
      [
        'resumable',
        { kind: 'startFailed', refusal: { code: 'agent_session_ownership_unknown' } },
        "Claude couldn't start."
      ],
      [
        'provider',
        { kind: 'providerRejected', detail: { text: 'Image type .bmp', audience: 'person' } },
        'The provider did not accept this message: Image type .bmp.'
      ],
      [
        'logged',
        { kind: 'providerRejected', detail: { text: 'HTTP 400 at /v1', audience: 'log' } },
        'The provider did not accept this message.'
      ]
    ]
    expect(
      texts(
        facts.map(([id]) => rejected(id)),
        null,
        facts.map(([id, fact]) => recorded(id, fact))
      )
    ).toEqual(
      Object.fromEntries(facts.map(([id, , shown]) => [agentJournalSubmissionKey(id), shown]))
    )
    // Not loaded (older than the loaded page): the message's copy has no refusal or detail, so the
    // host's sentence, which holds them, is shown for those kinds; the table words the rest.
    expect(
      texts([
        rejected('gone'),
        entry('provider', {
          state: 'rejected',
          lastFailure: {
            kind: 'rejected',
            reason: 'The provider did not accept this message: Image type .bmp.',
            rejection: { kind: 'providerRejected' }
          }
        }),
        entry('stopped', {
          state: 'rejected',
          lastFailure: {
            kind: 'rejected',
            reason: 'The agent stopped before this message was sent.',
            rejection: { kind: 'providerExited' }
          }
        })
      ])
    ).toEqual({
      [agentJournalSubmissionKey('gone')]: "The agent couldn't be started.",
      [agentJournalSubmissionKey('provider')]:
        'The provider did not accept this message: Image type .bmp.',
      [agentJournalSubmissionKey('stopped')]: 'Claude stopped before this message was sent.'
    })
  })

  it('says nothing on a message that is only waiting its turn or on its way', () => {
    expect(texts([entry('queued'), entry('sending', { state: 'dispatching' })])).toEqual({})
  })

  // Matched on the typed fact of a row found by its identity, never on either sentence.
  describe('a message rejected by a start whose row already says why', () => {
    const startFailed: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
    }
    const rejected = (id: string, fact: AgentSessionFailureFact) =>
      entry(id, {
        state: 'rejected',
        lastFailure: {
          kind: 'rejected',
          reason: 'Written by the host.',
          rejection: { kind: fact.kind }
        }
      })
    const recorded = (id: string, fact: AgentSessionFailureFact): AgentJournalSubmission => ({
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'Written by the host.',
      rejection: fact,
      submittedAt: 1,
      resolvedAt: 1
    })
    const statusRow = (itemId: string, fact: AgentSessionFailureFact): AgentJournalRenderItem => ({
      itemId,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
      }
    })
    const startRowKey = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen'))

    it('reads only the start-failure rows', () => {
      expect(
        structuredAgentSessionStartFailureFacts([
          statusRow(startRowKey, startFailed),
          statusRow(agentJournalSubmissionKey('exit-row'), { kind: 'providerExited' })
        ])
      ).toEqual([startFailed])
    })

    it('says only that each was not sent, and words any other rejection in full', () => {
      const otherRefusal: AgentSessionFailureFact = {
        kind: 'startFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
      }
      const facts = structuredAgentSessionStartFailureFacts([statusRow(startRowKey, startFailed)])
      expect(
        texts(
          [
            rejected('first', startFailed),
            rejected('second', startFailed),
            rejected('other', otherRefusal)
          ],
          null,
          [
            recorded('first', startFailed),
            recorded('second', startFailed),
            recorded('other', otherRefusal)
          ],
          facts
        )
      ).toEqual({
        [agentJournalSubmissionKey('first')]: 'Your message was not sent.',
        [agentJournalSubmissionKey('second')]: 'Your message was not sent.',
        [agentJournalSubmissionKey('other')]:
          "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
      })
    })

    it('keeps the full notice when the rejection is not loaded, or no start row states it', () => {
      const shown = "Claude couldn't start. Start a new chat to continue."
      expect(texts([rejected('first', startFailed)], null, [], [startFailed])).toEqual({
        [agentJournalSubmissionKey('first')]: 'Written by the host.'
      })
      expect(
        texts([rejected('first', startFailed)], null, [recorded('first', startFailed)], [])
      ).toEqual({ [agentJournalSubmissionKey('first')]: shown })
    })
  })
})
