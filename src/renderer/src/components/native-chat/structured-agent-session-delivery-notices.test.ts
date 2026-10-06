import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionRejectedFailure,
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
import {
  entry,
  NOT_FAILED_HERE,
  SENDING,
  texts
} from './structured-agent-session-delivery-notices-test-fixtures'

describe('the notice on each message that did not go through', () => {
  // Recorded by the host, so sending one again is a new message: no Retry.
  it('gives two messages the host rejected each their own reason and no Retry', () => {
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
      'Claude',
      retry,
      [],
      [],
      new Set(['first', 'second'])
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
    expect(notices.get(agentJournalSubmissionKey('first'))?.onRetry).toBeUndefined()
    expect(notices.get(agentJournalSubmissionKey('second'))?.onRetry).toBeUndefined()
  })

  // However this chat learned of it: the host recorded it, so it has no control at all.
  it('gives a message the host rejected before this chat opened no Retry and no Dismiss', () => {
    const retry = vi.fn()
    const notice = structuredAgentSessionDeliveryNotices(
      [
        entry('earlier', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason: 'Claude messages support at most 20 images' }
        })
      ],
      'Claude',
      retry,
      [],
      [],
      NOT_FAILED_HERE
    ).get(agentJournalSubmissionKey('earlier'))
    expect(notice).toEqual({ text: 'Claude messages support at most 20 images' })
    expect(retry).not.toHaveBeenCalled()
  })

  // Refused before the host recorded it: only its Retry sends it, so it keeps one.
  it('keeps the Retry on a message refused before the host recorded it', () => {
    const notice = structuredAgentSessionDeliveryNotices(
      [
        entry('refused', {
          state: 'rejected',
          lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
        })
      ],
      'Claude',
      () => {},
      [],
      [],
      NOT_FAILED_HERE
    ).get(agentJournalSubmissionKey('refused'))
    expect(notice?.onRetry).toBeDefined()
    expect(notice?.onDismiss).toBeUndefined()
  })

  it('chooses the words from the saved refusal on a refused message', () => {
    expect(
      texts([
        entry('held', {
          lastFailure: { kind: 'refused', code: 'agent_session_owner_restart_failed' }
        })
      ])
    ).toEqual({
      [agentJournalSubmissionKey('held')]: "The agent couldn't restart. Your message was not sent."
    })
  })

  // The same rule as a rejected row's: its own Retry is the resend step, and any other step stays.
  it('leaves a retry step to the Retry beside a refused message', () => {
    const held = (lastFailure: StructuredAgentSessionOutboxEntry['lastFailure']) =>
      texts([entry('held', { lastFailure })])
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
    expect(
      texts([entry('doubt', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 })])
    ).toEqual({
      [agentJournalSubmissionKey('doubt')]: 'Message delivery is unconfirmed.'
    })
    expect(texts([entry('bare', { state: 'rejected' })])).toEqual({
      [agentJournalSubmissionKey('bare')]: 'Message was not sent.'
    })
  })

  it('never says a send attempted before a Stop was not sent: the host may hold it', () => {
    const interrupted = entry('stopped', { state: 'queued', lastAttemptAt: 5, outlivedStop: true })
    expect(texts([interrupted])).toEqual({
      [agentJournalSubmissionKey('stopped')]: 'Message delivery is unconfirmed.'
    })
    const neverSent = entry('unsent', { state: 'queued', outlivedStop: true })
    expect(texts([neverSent])).toEqual({
      [agentJournalSubmissionKey('unsent')]: 'Message was not sent.'
    })
  })

  // The drain's own rule: a message behind the one the queue stopped on is only waiting, so it says
  // only that it is still sending. A rejected or refused message holds nothing up and keeps its words.
  it('says why on the message the queue stopped on and on every rejected or refused one', () => {
    expect(
      texts([
        entry('sent', { state: 'dispatching' }),
        entry('rejected', { state: 'rejected' }),
        entry('failed', { lastFailure: { kind: 'failed' } }),
        entry('stuck', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }),
        entry('behind', { state: 'unconfirmed' }),
        entry('queued')
      ])
    ).toEqual({
      [agentJournalSubmissionKey('sent')]: SENDING,
      [agentJournalSubmissionKey('rejected')]: 'Message was not sent.',
      [agentJournalSubmissionKey('failed')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('stuck')]: 'Message delivery is unconfirmed.',
      [agentJournalSubmissionKey('behind')]: SENDING,
      [agentJournalSubmissionKey('queued')]: SENDING
    })
  })

  // Its Retry would put it back in the queue to wait unseen behind the stopped message.
  it('keeps a rejected message behind the stopped one its words but not its Retry', () => {
    const retry = vi.fn()
    for (const outbox of [
      [
        entry('stuck', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 }),
        entry('rejected', { state: 'rejected' })
      ],
      [entry('held', { outlivedStop: true }), entry('rejected', { state: 'rejected' })]
    ]) {
      const notices = structuredAgentSessionDeliveryNotices(
        outbox,
        'Claude',
        retry,
        [],
        [],
        NOT_FAILED_HERE
      )
      expect(notices.get(agentJournalSubmissionKey('rejected'))).toEqual({
        text: 'Message was not sent.'
      })
    }
  })

  // Ahead of the stopped message, its Retry sends it at once, so the row offers it.
  it.each([
    ['in doubt', { state: 'unconfirmed' as const, retryAfterUnknownSubmittedAt: -1 }],
    ['outlived by a Stop', { outlivedStop: true as const }]
  ])('gives a failed message ahead of one %s its Retry', (_label, patch) => {
    const retry = vi.fn()
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('refused', {
          lastAttemptAt: 1,
          lastFailure: {
            kind: 'refused',
            code: 'agent_session_journal_unreadable',
            details: { reason: 'journalWrittenByNewerOrca' }
          }
        }),
        entry('rejected', { state: 'rejected' }),
        entry('stuck', { lastAttemptAt: 2, ...patch })
      ],
      'Claude',
      retry,
      [],
      [],
      NOT_FAILED_HERE
    )
    for (const id of ['refused', 'rejected', 'stuck']) {
      notices.get(agentJournalSubmissionKey(id))?.onRetry?.()
    }
    expect(retry.mock.calls).toEqual([['refused'], ['rejected'], ['stuck']])
  })

  // With no Retry beside it, the words keep the resend step.
  it.each([
    [
      'providerStartFailed',
      'Claude stopped before it finished starting. Send your message to try again.'
    ],
    ['notDelivered', 'This message was not delivered. Send it again to continue.'],
    ['hostFault', "Orca ran into a problem, so this didn't go through. Try again."]
  ] as const)('keeps the step in the words of a %s message the host rejected', (kind, reason) => {
    expect(
      texts([
        entry('rejected', {
          state: 'rejected',
          lastFailure: { kind: 'rejected', reason, rejection: { kind } }
        })
      ])
    ).toEqual({ [agentJournalSubmissionKey('rejected')]: reason })
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
      payloadFingerprint: id,
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
        // No Retry beside it, so the words keep the step.
        "Claude couldn't start. Send your message to try again."
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

  it("shows the host's sentence when this build cannot read all of a rejection's fact", () => {
    const reason = "Claude couldn't start. Start a new chat to continue."
    const copiedReason = 'An image on this message uses a newer check.'
    // As a newer host sends them: a known code with a new reason, and a new attachment reason.
    const newerStart = JSON.parse(
      '{ "kind": "startFailed", "refusal": { "code": "agent_session_conflict", "details": { "reason": "newerReason" } } }'
    )
    const newerAttachment = JSON.parse(
      '{ "kind": "attachmentInvalid", "attachment": { "reason": "newerReason" } }'
    )
    expect(
      texts(
        [
          entry('recorded', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure({ reason, rejection: newerStart })
          }),
          entry('copied', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure({
              reason: copiedReason,
              rejection: newerAttachment
            })
          })
        ],
        [
          {
            clientMessageId: 'recorded',
            fence: 1,
            payloadFingerprint: 'recorded',
            dispatchState: 'rejected',
            providerItemId: null,
            reason,
            rejection: newerStart,
            submittedAt: 1,
            resolvedAt: 1
          }
        ]
      )
    ).toEqual({
      [agentJournalSubmissionKey('recorded')]: reason,
      [agentJournalSubmissionKey('copied')]: copiedReason
    })
  })

  // An earlier attempt under the id may have landed, so the row never says it was not sent.
  it('words a kept message whose id expired as an outcome Orca cannot confirm', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [
        entry('expired', {
          lastAttemptAt: 1,
          lastFailure: { kind: 'refused', code: 'agent_session_operation_expired' }
        }),
        entry('fresh', {
          state: 'rejected',
          lastFailure: { kind: 'refused', code: 'agent_session_operation_expired' }
        })
      ],
      'Claude',
      vi.fn(),
      [],
      [],
      NOT_FAILED_HERE
    )
    expect(notices.get(agentJournalSubmissionKey('expired'))).toMatchObject({
      text: "Orca couldn't confirm what happened. Check the chat."
    })
    expect(notices.get(agentJournalSubmissionKey('expired'))?.onRetry).toBeDefined()
    // A first attempt's id was replaced when it was refused, so nothing can have landed.
    expect(notices.get(agentJournalSubmissionKey('fresh'))?.text).toBe('Your message was not sent.')
  })

  // A cause read back from storage may have cleared; a Retry it still stops brings it back.
  it('words a held cause only where its failure was seen while the chat was open', () => {
    const held = entry('held', {
      lastAttemptAt: 1,
      lastFailure: {
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalWrittenByNewerOrca' }
      }
    })
    const words = (failedHere: ReadonlySet<string>) =>
      structuredAgentSessionDeliveryNotices([held], 'Claude', vi.fn(), [], [], failedHere).get(
        agentJournalSubmissionKey('held')
      )
    expect(words(NOT_FAILED_HERE)).toMatchObject({ text: 'Your message was not sent.' })
    expect(words(NOT_FAILED_HERE)?.onRetry).toBeDefined()
    expect(words(new Set(['held']))?.text).toBe(
      'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'
    )
  })

  it('says only that a message waiting its turn or on its way is still sending', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [entry('queued'), entry('sending', { state: 'dispatching' })],
      'Claude',
      vi.fn(),
      [],
      [],
      NOT_FAILED_HERE
    )
    expect([...notices.values()]).toEqual([{ sending: true }, { sending: true }])
  })

  // Any row the host holds for it is the answer, whatever its state; the row itself then shows it.
  it.each(['pending', 'accepted'] as const)(
    'stops saying a message is sending once the journal holds a %s row for it',
    (dispatchState) => {
      const answer = (clientMessageId: string): AgentJournalSubmission => ({
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      })
      const resent = entry('resent', { state: 'unconfirmed', lastAttemptAt: 1 })
      const outbox = [entry('queued'), entry('sending', { state: 'dispatching' }), resent]
      expect(texts(outbox)).toEqual({
        [agentJournalSubmissionKey('queued')]: SENDING,
        [agentJournalSubmissionKey('sending')]: SENDING,
        [agentJournalSubmissionKey('resent')]: SENDING
      })
      expect(texts(outbox, [answer('queued'), answer('sending'), answer('resent')])).toEqual({})
      // Read as the outbox will commit it, so the resent one never says it failed on the way.
      expect(texts([resent], [answer('resent')])).toEqual({})
    }
  )

  // Only a row that has the message ends it; one in doubt leaves it looking sent.
  describe('a message whose journal row does not have it yet', () => {
    const row = (
      clientMessageId: string,
      dispatchState: AgentJournalSubmission['dispatchState'],
      patch: Partial<AgentJournalSubmission> = {}
    ): AgentJournalSubmission => ({
      clientMessageId,
      fence: 1,
      payloadFingerprint: 'fp',
      dispatchState,
      providerItemId: null,
      reason: null,
      submittedAt: 7,
      resolvedAt: null,
      ...patch
    })
    const stuck = entry('stuck', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: -1 })

    it.each([
      ['queued', { state: 'queued' as const }, {}],
      ['in flight', { state: 'dispatching' as const, lastAttemptAt: 2 }, {}],
      [
        'in flight, after a host restart',
        { state: 'dispatching' as const, lastAttemptAt: 2 },
        { recovered: true as const }
      ]
    ])('says it is sending while your Retry is %s', (_label, patch, rowPatch) => {
      const doubt = row('m', 'unknown', rowPatch)
      expect(texts([entry('m', { state: 'unconfirmed', lastAttemptAt: 1 })], [doubt])).toEqual({
        [agentJournalSubmissionKey('m')]: 'Message delivery is unconfirmed.'
      })
      const retried = entry('m', { lastAttemptAt: 1, retryAfterUnknownSubmittedAt: 7, ...patch })
      expect(texts([retried], [doubt])).toEqual({ [agentJournalSubmissionKey('m')]: SENDING })
    })

    it.each([
      ['a live unknown', {}],
      ['a recovered unknown', { recovered: true as const }]
    ])('says the second of two in doubt is sending when each row holds %s', (_label, patch) => {
      const a = entry('a', { state: 'unconfirmed' })
      const b = entry('b', { state: 'unconfirmed' })
      expect(texts([a, b], [row('a', 'unknown', patch), row('b', 'unknown', patch)])).toEqual({
        [agentJournalSubmissionKey('a')]: 'Message delivery is unconfirmed.',
        [agentJournalSubmissionKey('b')]: SENDING
      })
    })

    // The rejection makes it the host's: not sent, in the host's words, whether its outbox copy or
    // its loaded row draws it.
    it('says a requeued message whose row was rejected was not sent, never sending', () => {
      const requeued = entry('q', { state: 'queued', lastAttemptAt: 1 })
      const rejected = row('q', 'rejected', { reason: 'provider said no', resolvedAt: 8 })
      const notSent = { [agentJournalSubmissionKey('q')]: 'provider said no' }
      expect(texts([requeued], [rejected])).toEqual(notSent)
      expect(texts([stuck, requeued], [rejected])).toEqual({
        [agentJournalSubmissionKey('stuck')]: 'Message delivery is unconfirmed.',
        ...notSent
      })
      const loadedRow: AgentJournalRenderItem = {
        itemId: agentJournalSubmissionKey('q'),
        revision: 1,
        sequence: 1,
        observedAt: 8,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'q' }] }
      }
      const loaded = structuredAgentSessionDeliveryNotices(
        [requeued],
        'Claude',
        vi.fn(),
        [rejected],
        [],
        NOT_FAILED_HERE,
        [],
        new Set(),
        [loadedRow]
      )
      expect([...loaded]).toEqual([[agentJournalSubmissionKey('q'), { text: 'provider said no' }]])
    })
  })

  // One state, one surface: a row that says it did not go through never also says it is sending.
  it.each([
    ['rejected', entry('m', { state: 'rejected' }), []],
    ['held for its Retry', entry('m', { lastFailure: { kind: 'failed' } }), []],
    [
      'in doubt with a row the host holds',
      entry('m', { state: 'unconfirmed', lastAttemptAt: 1 }),
      [
        {
          clientMessageId: 'm',
          fence: 1,
          payloadFingerprint: 'fp',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        } satisfies AgentJournalSubmission
      ]
    ],
    [
      'retried by the user',
      entry('m', { state: 'unconfirmed', retryAfterUnknownSubmittedAt: 1 }),
      []
    ],
    ['outlived by a Stop', entry('m', { state: 'unconfirmed', outlivedStop: true }), []]
  ])('says only why on a message %s, never that it is sending', (_label, failed, rows) => {
    const notice = structuredAgentSessionDeliveryNotices(
      [failed],
      'Claude',
      vi.fn(),
      rows,
      [],
      NOT_FAILED_HERE
    ).get(agentJournalSubmissionKey('m'))
    expect(notice?.sending).toBeUndefined()
    expect(notice?.text).toMatch(/not sent|unconfirmed/)
    expect(notice?.onRetry).toBeDefined()
  })

  // The unconfirmed probe resends it under its own id until the journal answers, so the row says
  // it is still sending, with no Retry, until a row lands.
  describe('a message in doubt that Orca resends on its own', () => {
    const doubt = (patch: Partial<StructuredAgentSessionOutboxEntry> = {}) =>
      entry('doubt', { state: 'unconfirmed', lastAttemptAt: 1, ...patch })
    const row = (patch: Partial<AgentJournalSubmission>): AgentJournalSubmission => ({
      clientMessageId: 'doubt',
      fence: 1,
      payloadFingerprint: 'fp',
      dispatchState: 'unknown',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null,
      ...patch
    })
    const UNCONFIRMED = { [agentJournalSubmissionKey('doubt')]: 'Message delivery is unconfirmed.' }

    it('says only that it is still sending while the journal holds no row for it', () => {
      const notices = structuredAgentSessionDeliveryNotices(
        [doubt(), entry('behind')],
        'Claude',
        vi.fn(),
        [],
        [],
        NOT_FAILED_HERE
      )
      expect(notices.get(agentJournalSubmissionKey('doubt'))).toEqual({ sending: true })
      expect(notices.get(agentJournalSubmissionKey('behind'))).toEqual({ sending: true })
      // Another message's row is not its answer.
      expect(
        texts([doubt()], [row({ clientMessageId: 'other', dispatchState: 'accepted' })])
      ).toEqual({ [agentJournalSubmissionKey('doubt')]: SENDING })
    })

    it.each([
      ['a live unknown', row({})],
      ['a recovered unknown', row({ recovered: true })],
      [
        "an older host's recovered unknown",
        row({ reason: 'host_restarted_before_acknowledgement' })
      ]
    ])('says it is unconfirmed, with its Retry, once the journal holds %s', (_label, answer) => {
      const retry = vi.fn()
      const notices = structuredAgentSessionDeliveryNotices(
        [doubt()],
        'Claude',
        retry,
        [answer],
        [],
        NOT_FAILED_HERE
      )
      expect(Object.fromEntries([...notices].map(([id, notice]) => [id, notice.text]))).toEqual(
        UNCONFIRMED
      )
      notices.get(agentJournalSubmissionKey('doubt'))?.onRetry?.()
      expect(retry).toHaveBeenCalledExactlyOnceWith('doubt')
    })

    it.each([
      ['the user already retried', { retryAfterUnknownSubmittedAt: 1 }],
      ['a Stop outlived', { outlivedStop: true as const }]
    ])('says it is unconfirmed when %s it, as nothing resends it', (_label, patch) => {
      expect(texts([doubt(patch)])).toEqual(UNCONFIRMED)
    })
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
      ).toEqual([{ itemId: startRowKey, fact: startFailed, observedAt: 1 }])
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
      const stated = { itemId: startRowKey, fact: startFailed, observedAt: 1 }
      expect(texts([rejected('first', startFailed)], [], [stated])).toEqual({
        [agentJournalSubmissionKey('first')]: 'Written by the host.'
      })
      expect(texts([rejected('first', startFailed)], [recorded('first', startFailed)], [])).toEqual(
        { [agentJournalSubmissionKey('first')]: shown }
      )
    })

    it("words in full a later failure equal to an older start's row: that row is another start's", () => {
      const facts = structuredAgentSessionStartFailureFacts([statusRow(startRowKey, startFailed)])
      const later = { ...recorded('later', startFailed), submittedAt: 5, resolvedAt: 6 }
      expect(texts([rejected('later', startFailed)], [later], facts)).toEqual({
        [agentJournalSubmissionKey('later')]: "Claude couldn't start. Start a new chat to continue."
      })
    })
  })
})
