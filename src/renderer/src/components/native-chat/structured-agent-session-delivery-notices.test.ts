import { describe, expect, it, vi } from 'vitest'
import {
  isSubmissionRejectionFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from '../../../../shared/agent-session-wire-refusals'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
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
  structuredAgentSessionStartFailureFacts,
  type StatedStartFailure
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

const NOT_FAILED_HERE: ReadonlySet<string> = new Set()

function texts(
  outbox: StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[] = [],
  startFailures: readonly StatedStartFailure[] = []
): Record<string, string> {
  // Every failure seen while the chat was open, so each words its whole cause.
  const notices = structuredAgentSessionDeliveryNotices(
    outbox,
    'Claude',
    () => {},
    submissions,
    startFailures,
    new Set(outbox.map((candidate) => candidate.clientMessageId))
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
      'Claude',
      retry,
      [],
      [],
      NOT_FAILED_HERE
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
    expect(texts([entry('doubt', { state: 'unconfirmed' })])).toEqual({
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
  // nothing. A rejected or refused message holds nothing up and keeps its words.
  it('says why on the message the queue stopped on and on every rejected or refused one', () => {
    expect(
      texts([
        entry('sent', { state: 'dispatching' }),
        entry('rejected', { state: 'rejected' }),
        entry('failed', { lastFailure: { kind: 'failed' } }),
        entry('stuck', { state: 'unconfirmed' }),
        entry('behind', { state: 'unconfirmed' }),
        entry('queued')
      ])
    ).toEqual({
      [agentJournalSubmissionKey('rejected')]: 'Message was not sent.',
      [agentJournalSubmissionKey('failed')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('stuck')]: 'Message delivery is unconfirmed.'
    })
  })

  // Its Retry would put it back in the queue to wait unseen behind the stopped message.
  it('keeps a rejected message behind the stopped one its words but not its Retry', () => {
    const retry = vi.fn()
    for (const outbox of [
      [entry('stuck', { state: 'unconfirmed' }), entry('rejected', { state: 'rejected' })],
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
    ['in doubt', { state: 'unconfirmed' as const }],
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
    expect(texts([entry('held', { outlivedStop: true }), startFailed('rejected')])).toMatchObject({
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
            payloadFingerprint: 'fingerprint',
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

describe('the notice on a message whose agent start failed', () => {
  function queued(
    id: string,
    startRetry?: AgentJournalSubmission['startRetry']
  ): AgentJournalSubmission {
    return {
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null,
      handoverRecorded: true,
      ...(startRetry ? { startRetry } : {})
    }
  }
  const transient = { kind: 'accountSwitchInProgress' } as const

  it('says why and that Orca tries again, with no Retry, whoever sent it', () => {
    const notices = structuredAgentSessionDeliveryNotices(
      [entry('mine', { state: 'dispatching' })],
      'Claude',
      () => {},
      [
        queued('mine', {
          attempts: 1,
          reason: 'Written by the host.',
          rejection: transient,
          failedAt: 1,
          nextAttemptAt: 15_001
        }),
        queued('orca', {
          attempts: 2,
          reason: 'Written by the host.',
          rejection: transient,
          failedAt: 1,
          nextAttemptAt: 60_001
        }),
        queued('waiting')
      ],
      [],
      NOT_FAILED_HERE
    )

    const said = 'A Claude account switch is in progress. Orca will try again shortly.'
    expect(Object.fromEntries(notices)).toEqual({
      [agentJournalSubmissionKey('mine')]: { text: said },
      [agentJournalSubmissionKey('orca')]: { text: said }
    })
  })

  function retrying(id: string, rejection: AgentSessionFailureFact): AgentJournalSubmission {
    return queued(id, {
      attempts: 1,
      reason: 'Written by the host.',
      rejection,
      failedAt: 1,
      nextAttemptAt: 15_001
    })
  }

  it.each([
    [{ kind: 'accountSwitchInProgress' }, 'A Claude account switch is in progress.'],
    [
      { kind: 'restartFailed', refusal: { code: 'execution_owner_reconciling' } },
      "Claude couldn't restart."
    ],
    [
      { kind: 'startFailed', refusal: { code: 'agent_session_operation_conflict' } },
      "Claude couldn't start."
    ],
    [
      {
        kind: 'restartFailed',
        refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
      },
      "Claude couldn't restart. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    ]
  ] as const)(
    'says why %j and that Orca tries again, and leaves trying again to Orca',
    (rejection, why) => {
      expect(texts([], [retrying('mine', rejection)])).toEqual({
        [agentJournalSubmissionKey('mine')]: `${why} Orca will try again shortly.`
      })
    }
  )

  // Orca tries again any start refused before spawn whose refusing site did not say only the person
  // can clear it: the account switch, or a start or restart refused with any code.
  it('never tells the person to try again while Orca will, for any start Orca tries again', () => {
    const facts = [
      { kind: 'accountSwitchInProgress' } satisfies AgentSessionFailureFact,
      ...(['startFailed', 'restartFailed'] as const).flatMap((kind) =>
        AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) =>
          readWholeAgentSessionFailureFact({ kind, refusal: { code } })
        )
      )
    ].filter(
      (fact): fact is AgentSessionFailureFact =>
        fact !== undefined && isSubmissionRejectionFact(fact)
    )
    expect(facts.length).toBe(1 + 2 * AGENT_SESSION_WIRE_REFUSAL_CODES.length)
    for (const fact of facts) {
      const [text] = Object.values(texts([], [retrying('mine', fact)]))
      expect(text?.endsWith(' Orca will try again shortly.')).toBe(true)
      expect(text?.replace(' Orca will try again shortly.', '')).not.toMatch(/again|retry/i)
    }
  })

  it('keeps when to try again beside the Retry once the tries run out', () => {
    const words = agentSessionFailureWords(
      { kind: 'accountSwitchInProgress' },
      { surface: 'rejection', agentName: 'Claude' }
    )
    expect(
      texts(
        [
          entry('mine', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure(words)
          })
        ],
        [{ ...queued('mine'), dispatchState: 'rejected', ...words }]
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]:
        'A Claude account switch is in progress. Try again after it finishes.'
    })
  })

  it("keeps the host's sentence for a failure this build cannot read whole", () => {
    expect(
      texts(
        [],
        [
          queued('mine', {
            attempts: 1,
            reason: 'Written by a newer host.',
            rejection: { kind: 'aNewerKind' },
            failedAt: 1,
            nextAttemptAt: 15_001
          })
        ]
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]: 'Written by a newer host. Orca will try again shortly.'
    })
  })

  it('offers Retry, and sign-in as the step, once a signed-out start is rejected', () => {
    const signedOut = { kind: 'notSignedIn' } as const
    const words = agentSessionFailureWords(signedOut, { surface: 'rejection', agentName: 'Claude' })
    expect(
      texts(
        [
          entry('mine', {
            state: 'rejected',
            lastFailure: structuredAgentSessionRejectedFailure(words)
          })
        ],
        [{ ...queued('mine'), dispatchState: 'rejected', ...words }]
      )
    ).toEqual({
      [agentJournalSubmissionKey('mine')]:
        'Claude is not signed in for the selected account. Sign in first.'
    })
  })
})
