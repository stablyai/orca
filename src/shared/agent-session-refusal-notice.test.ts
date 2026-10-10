import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'
import {
  agentSessionReadHistoryRefusalParts,
  agentSessionRefusalCauseParts,
  agentSessionRefusalNotice,
  agentSessionWriteFailureNotice,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from './agent-session-refusal-notice'
import { agentSessionRefusalReasonWords } from './agent-session-refusal-reason-words'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY,
  type AgentSessionWriteNoticeSentence
} from './agent-session-write-notice-copy'
import { AGENT_SESSION_REFUSAL_REASONS } from './agent-session-refusal-details'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  parseAgentSessionWriteFailure,
  agentSessionWriteKindForMethod,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import {
  DISPATCH_REJECTED_NOT_DELIVERED,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionRejectionParts } from './structured-agent-session-rejection-words'

const WRITES: AgentSessionWriteKind[] = [
  'read-history',
  'send',
  'composer-send',
  'stop',
  'stop-task',
  'stop-tasks',
  'answer',
  'option',
  'command',
  'clear',
  'compact',
  'goal'
]
const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'

// A cause is named only where every host emitter of the code means it; any other code says only
// what did not happen, because one code covers owner states or reasons the client cannot tell apart.
const CAUSES: Partial<Record<AgentSessionWireRefusalCode, AgentSessionWriteNoticeSentence>> = {
  // Only send preparation, when the owner it restarted for this send failed to start.
  agent_session_owner_restart_failed: 'restartFailed',
  // Only an older host's ledger, when a day's retained operation ids filled its quota.
  agent_session_operation_capacity: 'capacity',
  // A replayed operation with no recorded outcome, or a send behind a rewind whose outcome is
  // unrecorded: either way Orca cannot say what happened.
  agent_session_operation_unknown: 'outcomeUnknown',
  // Only the pending-prompt check.
  agent_session_item_revision_stale: 'questionChanged',
  agent_session_already_resolved: 'questionChanged',
  // Send preparation, for any failed open; the code names nothing else.
  agent_session_journal_unreadable: 'historyUnreadable',
  // With no reason: a method the host doesn't know, or a host from before reasons. Either way an
  // older Orca runs the chat.
  structured_agent_session_unsupported: 'unsupported'
}

function isCause(part: unknown): boolean {
  return typeof part === 'string' && !part.startsWith('notDone') && part !== 'tryAgainComposerSend'
}

// A newer host can send a code this client has never heard of.
const FUTURE_CODE: AgentSessionWriteFailure = JSON.parse(
  '{"kind":"refused","code":"agent_session_from_the_future"}'
)
const FAILURES: AgentSessionWriteFailure[] = [
  ...AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) => ({ kind: 'refused' as const, code })),
  { kind: 'failed' },
  { kind: 'unconfirmed' },
  FUTURE_CODE
]
const NOT_DONE: Record<AgentSessionWriteKind, AgentSessionWriteNoticeSentence> = {
  'read-history': 'notDoneReadHistory',
  send: 'notDoneSend',
  'composer-send': 'notDoneSend',
  stop: 'notDoneStop',
  'stop-task': 'notDoneStopTask',
  'stop-tasks': 'notDoneStopTasks',
  answer: 'notDoneAnswer',
  option: 'notDoneOption',
  command: 'notDoneCommand',
  clear: 'notDoneCommand',
  compact: 'notDoneCommand',
  goal: 'notDoneGoal'
}

function codeOf(failure: AgentSessionWriteFailure): string {
  return failure.kind === 'refused' ? failure.code : failure.kind
}

// The host may have run it: a thrown request, or a replayed id with no recorded outcome.
function mayHaveRun(failure: AgentSessionWriteFailure): boolean {
  return codeOf(failure) === 'unconfirmed' || codeOf(failure) === 'agent_session_operation_unknown'
}

// Where the cause sentence alone already says the write cannot take effect.
function causeSaysNotDone(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): boolean {
  const code = codeOf(failure)
  return (
    code === 'structured_agent_session_unsupported' ||
    (write === 'read-history' && code === 'agent_session_journal_unreadable') ||
    (write === 'answer' &&
      (code === 'agent_session_item_revision_stale' || code === 'agent_session_already_resolved'))
  )
}

// The phone resends under the same id. These record nothing under it (the lease refusals drop the
// row they admitted), so a resend can go through; every other code can be refused again.
const RESEND_CAN_WORK = new Set([
  'failed',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

// Every (failure x write) cell of the table, checked against the rules a notice must keep.
describe('the notice for every failure and write', () => {
  const cells = FAILURES.flatMap((failure) =>
    WRITES.map((write) => {
      const parts = agentSessionWriteNoticeParts(failure, write)
      return {
        failure,
        write,
        parts,
        english: agentSessionWriteNoticeEnglish(parts),
        cell: `${codeOf(failure)} x ${write}`
      }
    })
  )

  it('says the write did not happen, once and for that write, whenever that is certain', () => {
    for (const { failure, write, parts, cell } of cells.filter((c) => !mayHaveRun(c.failure))) {
      const notDone = parts.filter((part) => typeof part === 'string' && part.startsWith('notDone'))
      expect(notDone, cell).toEqual(causeSaysNotDone(failure, write) ? [] : [NOT_DONE[write]])
    }
  })

  it('never says a write did not happen when the host may have run it', () => {
    for (const { parts, cell } of cells.filter((c) => mayHaveRun(c.failure))) {
      expect(parts, cell).toEqual(['outcomeUnknown'])
    }
  })

  // The control that sent the write is how to try again; only the phone's composer has none.
  it('says how to try again only to update Orca, or on the phone where a resend can work', () => {
    for (const { failure, write, parts, english, cell } of cells) {
      const phoneResend = write === 'composer-send' && RESEND_CAN_WORK.has(codeOf(failure))
      expect(parts.includes('tryAgainComposerSend'), cell).toBe(phoneResend)
      expect(/again/i.test(english), cell).toBe(
        phoneResend ||
          codeOf(failure) === 'structured_agent_session_unsupported' ||
          codeOf(failure) === 'agent_session_operation_capacity'
      )
    }
    for (const reason of [null, DISPATCH_REJECTED_WRITE_FAILED, DISPATCH_REJECTED_QUEUE_FULL]) {
      expect(
        agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, 'send'))
      ).not.toMatch(/again/i)
    }
  })

  it('names a cause only for a code on the allowlist', () => {
    for (const { failure, parts, cell } of cells) {
      const cause =
        failure.kind === 'unconfirmed'
          ? 'outcomeUnknown'
          : failure.kind === 'refused'
            ? CAUSES[failure.code]
            : undefined
      expect(parts.filter(isCause), cell).toEqual(cause ? [cause] : [])
    }
  })

  // Census of host emitters, one per code, that write for a log or carry a marker. One is enough
  // to rule out showing the host's message for that code:
  // - every code a planned write settles: "Operation <id> was already refused: <code>."
  //   (structured-agent-session-replay-outcome.ts; the settlement stores no message)
  // - operation_conflict / _expired / _invalid / _capacity: "Operation <id> was refused: <code>."
  //   (agent-session-mutation-envelope.ts, the ledger)
  // - operation_invalid, operation_unknown: `agent_session_rewind:<reason>` (structured-rewind-refusal.ts)
  // - operation_unknown: "The outcome of operation <id> is unknown; it was not run again."
  // - checkpoint_stale, conflict, identity_required, execution_owner_reconciling, unsupported: the
  //   bare code thrown as the message (lease-release, reservation-admission, tab-table,
  //   claim-identity, lease-transitions, reveal)
  // - ownership_unknown: "The session attached without a provider child to write to." (agent-start)
  // - item_revision_stale / already_resolved: "Item <id> has moved on." (prompt-state)
  // - owner_restart_failed: "<agent> couldn't restart: <cause>.", where the cause is the resume's
  //   own refusal message, including the ledger's (dead-generation-settlement, agent-start)
  // - journal_unreadable: "The conversation could not be opened: <error>" (send preparation, before
  //   it named a reason)
  it('is never empty and never shows the host message', () => {
    for (const { failure, write, parts, cell } of cells) {
      expect(parts.length, cell).toBeGreaterThan(0)
      expect(
        parts.every((part) => typeof part === 'string'),
        cell
      ).toBe(true)
      if (failure.kind === 'refused') {
        expect(
          agentSessionRefusalNotice({ code: failure.code, message: HOST_TEXT }, write),
          cell
        ).not.toContain('fence')
      }
    }
  })
})

describe('structuredAgentSessionRejectionParts', () => {
  it('never shows the crash-recovery marker as the reason', () => {
    expect(structuredAgentSessionRejectionParts(DISPATCH_REJECTED_NOT_DELIVERED, 'send')).toEqual([
      'notDoneSend'
    ])
  })
})

describe('agentSessionRefusalNotice', () => {
  // The phone resends under the same operation id. Owner refusals and failed requests record
  // nothing under it, so a resend can go through; a conflicting or expired id is refused again.
  it.each([
    ['agent_session_checkpoint_stale', 'Your message was not sent. Send it again.'],
    ['execution_owner_reconciling', 'Your message was not sent. Send it again.'],
    ['agent_session_operation_expired', 'Your message was not sent.'],
    ['agent_session_operation_conflict', 'Your message was not sent.'],
    ['agent_session_operation_invalid', 'Your message was not sent.'],
    ['agent_session_owner_restart_failed', "The agent couldn't restart. Your message was not sent."]
  ] as const)('tells the phone to send it again only where that can work: %s', (code, expected) => {
    expect(agentSessionRefusalNotice({ code, message: HOST_TEXT }, 'composer-send')).toBe(expected)
  })

  it('says what did not happen for a failed request', () => {
    expect(agentSessionWriteFailureNotice('composer-send')).toBe(
      'Your message was not sent. Send it again.'
    )
    expect(agentSessionWriteFailureNotice('stop')).toBe("The agent wasn't stopped.")
  })

  // A request that may have run must not say it did not happen.
  it.each(['runtime_timeout', 'runtime_error', undefined])(
    'claims nothing about a request that threw with %s',
    (code) => {
      for (const write of WRITES) {
        expect(
          agentSessionWriteNoticeEnglish(
            agentSessionWriteNoticeParts(agentSessionRpcErrorFailure(code), write)
          )
        ).toBe("Orca couldn't confirm what happened. Check the chat.")
      }
    }
  )

  it('says what did not happen when the host turned the request away before running it', () => {
    expect(agentSessionRpcErrorFailure('invalid_argument')).toEqual({
      kind: 'refused',
      code: 'agent_session_operation_invalid'
    })
    expect(agentSessionRpcErrorFailure('method_not_found')).toEqual({
      kind: 'refused',
      code: 'structured_agent_session_unsupported'
    })
  })

  it('says an agent could not restart without promising a retry will work', () => {
    // The host words the cause into the chat's status row; some causes need a new chat.
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_owner_restart_failed',
          message:
            "Claude couldn't restart: Operation 1-a was refused: agent_session_operation_expired."
        },
        'send'
      )
    ).toBe("The agent couldn't restart. Your message was not sent.")
  })

  it('names a background-task stop as that, not as stopping the agent', () => {
    const stop = (fields: Record<string, unknown>): string =>
      agentSessionRefusalNotice(
        { code: 'agent_session_checkpoint_stale', message: HOST_TEXT },
        agentSessionWriteKindForMethod('agentSession.cancel', fields)
      )
    expect(stop({ turnId: 't1' })).toBe("The agent wasn't stopped.")
    expect(stop({ turnId: 'background-tasks', scope: 'background-tasks', taskId: 'b1' })).toBe(
      "The background task wasn't stopped."
    )
    expect(stop({ turnId: 'background-tasks', scope: 'background-tasks' })).toBe(
      "The background tasks weren't stopped."
    )
  })

  it('says a Stop refused over a moved-on prompt did not stop the agent', () => {
    const refusal = {
      code: 'agent_session_already_resolved' as const,
      message: 'Item q1 moved on.'
    }
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe(
      "This question was already answered or has changed. The agent wasn't stopped."
    )
    expect(agentSessionRefusalNotice(refusal, 'answer')).toBe(
      'This question was already answered or has changed.'
    )
  })

  it('says only what did not happen for a code from a newer host', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","message":"internal"}')
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe("The agent wasn't stopped.")
  })
})

// Every (code x reason) a host can name, as a write keeps it.
const REASONED: AgentSessionWriteRefusal[] = AGENT_SESSION_WIRE_REFUSAL_CODES.flatMap((code) =>
  AGENT_SESSION_REFUSAL_REASONS[code].map((reason) =>
    agentSessionRefusalFailure({ code, details: { reason } })
  )
)

function reasonOf(failure: AgentSessionWriteRefusal): string {
  return `${failure.code}/${failure.details?.reason}`
}

describe('the notice for every reason a host names', () => {
  const cells = REASONED.flatMap((failure) =>
    WRITES.map((write) => ({
      failure,
      write,
      parts: agentSessionWriteNoticeParts(failure, write),
      words: agentSessionRefusalReasonWords(failure),
      cell: `${reasonOf(failure)} x ${write}`
    }))
  )

  // An unsupported location or agent, or no chat host, is not fixed by updating Orca. Only an
  // agent or location the host can't run names its cause; a read otherwise asked for nothing
  // "this" could name, so it says only that the history didn't load.
  it('says an unsupported write never asks for an update when the host names why', () => {
    for (const { failure, write, parts, cell } of cells) {
      if (failure.code !== 'structured_agent_session_unsupported') {
        continue
      }
      if (failure.details?.reason === 'hostUnsupported') {
        expect(parts, cell).toEqual(['cannotRunHere', NOT_DONE[write]])
        continue
      }
      expect(parts, cell).toEqual(
        write === 'read-history' ? ['notDoneReadHistory'] : ['notAvailable']
      )
    }
  })

  it('has words for every reason', () => {
    for (const { words, cell } of cells) {
      expect(words, cell).toBeDefined()
    }
  })

  it('keeps the code words where the table says the reason means nothing more', () => {
    for (const { failure, write, parts, words, cell } of cells) {
      if (words && 'words' in words) {
        expect(parts, cell).toEqual(
          agentSessionWriteNoticeParts({ ...failure, details: undefined }, write)
        )
      }
    }
  })

  // A retry is the control that sent the write; only an open that can clear says to try again.
  it('names a step exactly where the person has one to take', () => {
    for (const { words, cell } of cells) {
      if (words && 'cause' in words) {
        const retryNow = words.action === 'retry' && words.step === 'tryAgain'
        expect(words.step !== undefined && !retryNow, cell).toBe(
          words.action === 'wait' ||
            words.action === 'actFirst' ||
            words.action === 'goElsewhere' ||
            words.action === 'updateOrca'
        )
        expect(retryNow, cell).toBe(words.cause === 'historyUnavailable')
      }
    }
  })

  // Beside a Retry, that Retry is the step for a reason whose action is to retry, and only for it.
  it('leaves out only a retry step when a Retry stands beside the words', () => {
    const beside = { agentName: 'Codex', retryControl: true }
    for (const { failure, write, parts, words, cell } of cells) {
      if (words && 'cause' in words) {
        const retried = words.action === 'retry' ? words.step : undefined
        expect(agentSessionWriteNoticeParts(failure, write, beside), cell).toEqual(
          parts.filter((part) => part !== retried)
        )
      }
    }
    const send = (failure: AgentSessionWriteRefusal) =>
      agentSessionWriteNoticeParts(failure, 'send', beside)
    expect(
      send({
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      })
    ).toEqual(['historyUnavailable', 'notDoneSend'])
    expect(
      agentSessionWriteNoticeEnglish(
        send({
          kind: 'refused',
          code: 'agent_session_operation_invalid',
          details: { reason: 'notSignedIn' }
        })
      )
    ).toBe("Your message was not sent. Codex isn't signed in. Run `codex login`.")
    expect(
      agentSessionWriteNoticeEnglish(
        send({
          kind: 'refused',
          code: 'agent_session_operation_invalid',
          details: { reason: 'providerStartFailed' }
        })
      )
    ).toBe('Your message was not sent. Codex stopped before it finished starting.')
  })

  it('says the write did not happen, once, and never shows the host message', () => {
    for (const { failure, write, parts, cell } of cells) {
      const english = agentSessionWriteNoticeEnglish(parts)
      expect(english.length, cell).toBeGreaterThan(0)
      expect(agentSessionRefusalNotice({ ...failure, message: HOST_TEXT }, write), cell).toBe(
        english
      )
      if (failure.code === 'agent_session_operation_unknown') {
        expect(parts, cell).toEqual(['outcomeUnknown'])
        continue
      }
      const notDone = parts.filter((part) => typeof part === 'string' && part.startsWith('notDone'))
      const answeredAway = write === 'answer' && parts.includes('questionChanged')
      const unsupported =
        failure.code === 'structured_agent_session_unsupported' &&
        failure.details?.reason !== 'hostUnsupported' &&
        write !== 'read-history'
      const saysNotDone =
        write === 'read-history' && failure.code === 'agent_session_journal_unreadable'
      // "Run /clear when it's done" already says the command has yet to happen.
      const clearWhileWorking = (
        [
          'runClearWhenDone',
          'clearAfterAnswer',
          'runCompactWhenDone',
          'compactAfterAnswer'
        ] as const
      ).some((sentence) => parts.includes(sentence))
      expect(notDone, cell).toEqual(
        answeredAway || unsupported || saysNotDone || clearWhileWorking ? [] : [NOT_DONE[write]]
      )
    }
  })

  it("uses the failure's own sentence for a start that failed, and only for a message", () => {
    const failure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { reason: 'notSignedIn' }
    })
    // The fact, not its English, so desktop words it in the reader's language.
    expect(agentSessionWriteNoticeParts(failure, 'send')).toEqual([
      'notDoneSend',
      { failure: { kind: 'notSignedIn' }, surface: 'rejection', context: {} }
    ])
    expect(agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts(failure, 'send'))).toBe(
      `Your message was not sent. ${agentSessionFailureSentence({ kind: 'notSignedIn' }, 'rejection')}`
    )
    // Its next step is to send the message again, which a Stop cannot do.
    expect(agentSessionWriteNoticeParts(failure, 'stop')).toEqual(['notDoneStop'])
  })

  it.each([
    [
      'agent_session_operation_invalid',
      'conversationCleared',
      'send',
      'This conversation has been cleared. Your message was not sent. Open the current conversation to continue.'
    ],
    [
      'agent_session_operation_invalid',
      'clearUnconfirmed',
      'send',
      "The last /clear didn't finish. Your message was not sent. Start a new chat to continue."
    ],
    [
      'agent_session_operation_invalid',
      'turnActive',
      'command',
      "The agent is still responding. The command didn't run. Wait for the agent to finish responding, or stop it."
    ],
    [
      'agent_session_conflict',
      'claimConflicted',
      'composer-send',
      'This chat is still open in a terminal agent. Your message was not sent. Quit that agent to continue the chat here.'
    ],
    [
      'agent_session_conflict',
      'chatStarting',
      'stop',
      "The agent is still starting. The agent wasn't stopped. Wait for the agent to finish starting."
    ],
    [
      'agent_session_operation_invalid',
      'promptGone',
      'answer',
      'This question was already answered or has changed.'
    ],
    [
      'agent_session_checkpoint_stale',
      'fenceStale',
      'composer-send',
      'Your message was not sent. Send it again.'
    ]
  ] as const)('%s / %s on %s', (code, reason, write, expected) => {
    expect(
      agentSessionRefusalNotice({ code, message: HOST_TEXT, details: { reason } }, write)
    ).toBe(expected)
  })
})

describe('a refusal from a host that names no reason this build knows', () => {
  it.each([
    ['an older host', undefined],
    ['a reason a newer host added', { reason: 'fromTheFuture' }],
    ['facts with no reason', { ownerVerdict: 'unverifiable' }]
  ])("reads as the code's row: %s", (_label, details) => {
    const refusal = JSON.parse(
      JSON.stringify({ code: 'agent_session_operation_invalid', message: HOST_TEXT, details })
    )
    expect(agentSessionRefusalNotice(refusal, 'command')).toBe("The command didn't run.")
  })
})

it('keeps a sentence the failure rows share word for word', () => {
  expect(agentSessionFailureSentence({ kind: 'historyTooLarge' }, 'row')).toContain(
    AGENT_SESSION_WRITE_NOTICE_COPY.startNewChat
  )
})

// A failed journal open says what happened to the history, not what was asked of it.
describe('a chat whose history the host could not open', () => {
  const notice = (details: unknown, write: AgentSessionWriteKind): string =>
    agentSessionRefusalNotice(
      JSON.parse(
        JSON.stringify({ code: 'agent_session_journal_unreadable', message: HOST_TEXT, details })
      ),
      write
    )

  it.each([
    ['journalCorrupt', 'read-history', 'Unable to load this chat.'],
    ['journalCorrupt', 'send', 'Unable to load this chat. Your message was not sent.'],
    [
      'journalUnavailable',
      'read-history',
      "Orca couldn't open this chat's history right now. Try again."
    ],
    [
      'journalUnavailable',
      'send',
      "Orca couldn't open this chat's history right now. Your message was not sent. Try again."
    ],
    // Only an update gets past it, so it never says to try again. A read meets it on one chat.
    [
      'journalWrittenByNewerOrca',
      'read-history',
      'This chat was saved by a newer Orca. Update Orca to open it.'
    ],
    [
      'journalWrittenByNewerOrca',
      'send',
      'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'
    ],
    [
      'journalWrittenByNewerOrca',
      'stop',
      "Chats were saved by a newer Orca. The agent wasn't stopped. Update Orca to keep using them."
    ],
    [
      'journalWrittenByNewerOrca',
      'answer',
      'Chats were saved by a newer Orca. Your answer was not sent. Update Orca to keep using them.'
    ]
  ] as const)('%s on %s', (reason, write, expected) => {
    expect(notice({ reason }, write)).toBe(expected)
  })

  // Damage can't be told apart from an open that can clear, so it never says to start over.
  it.each([
    ['an older host', undefined],
    ['a reason an unreleased build wrote', { reason: 'journalUnreadable' }]
  ])('promises nothing for a refusal that names no reason: %s', (_label, details) => {
    expect(notice(details, 'read-history')).toBe("Orca couldn't read this chat's saved history.")
    expect(notice(details, 'send')).toBe(
      "Orca couldn't read this chat's saved history. Your message was not sent."
    )
    expect(
      agentSessionReadHistoryRefusalParts('agent_session_journal_unreadable', details)
    ).toEqual(['historyUnreadable'])
  })

  it('says only that the history did not load for any other read refusal', () => {
    expect(agentSessionReadHistoryRefusalParts('agent_session_ownership_unknown')).toEqual([
      'notDoneReadHistory'
    ])
    expect(agentSessionReadHistoryRefusalParts('agent_session_from_the_future')).toEqual([
      'notDoneReadHistory'
    ])
  })
})

describe('a /clear or /compact refused while the agent works', () => {
  const refused = (reason: 'turnActive' | 'messagesUnsettled' | 'promptPending') =>
    ({ kind: 'refused', code: 'agent_session_operation_invalid', details: { reason } }) as const

  it('says one plain sentence of what the person sees and can do, whichever reason', () => {
    for (const reason of ['turnActive', 'messagesUnsettled'] as const) {
      expect(
        agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts(refused(reason), 'clear'))
      ).toBe("The agent is still working. Run /clear when it's done.")
    }
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(refused('promptPending'), 'clear')
      )
    ).toBe("Answer the agent's question or approval, then run /clear.")
  })

  it('says the same for a /compact, which a host without the queue still refuses', () => {
    for (const reason of ['turnActive', 'messagesUnsettled'] as const) {
      expect(
        agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts(refused(reason), 'compact'))
      ).toBe("The agent is still working. Run /compact when it's done.")
    }
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(refused('promptPending'), 'compact')
      )
    ).toBe("Answer the agent's question or approval, then run /compact.")
  })

  it('leaves a command this build does not know its own words', () => {
    expect(agentSessionWriteNoticeParts(refused('turnActive'), 'command')).toEqual([
      'turnActive',
      'notDoneCommand',
      'waitForTurn'
    ])
  })

  it('is the write a /clear or /compact is, and only those', () => {
    expect(
      agentSessionWriteKindForMethod('agentSession.conversationCommand', { command: 'clear' })
    ).toBe('clear')
    expect(
      agentSessionWriteKindForMethod('agentSession.conversationCommand', { command: 'compact' })
    ).toBe('compact')
    expect(
      agentSessionWriteKindForMethod('agentSession.conversationCommand', { command: 'rewind' })
    ).toBe('command')
  })
})

// For a line that already says what did not happen and shows its own Retry, such as a chat that
// could not start: the Retry is the step for retrying and for sending again, and only for those.
describe('agentSessionRefusalCauseParts', () => {
  it('keeps a step other than retrying, beside the cause', () => {
    expect(
      agentSessionRefusalCauseParts({
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'turnActive' }
      })
    ).toEqual(['turnActive', 'waitForTurn'])
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts({
          kind: 'refused',
          code: 'agent_session_operation_invalid',
          details: { reason: 'historyTooLarge' }
        })
      )
    ).toBe(
      "This conversation's history is too large to restore here. Start a new chat to continue."
    )
  })

  it('leaves out a step the Retry beside it takes', () => {
    expect(
      agentSessionRefusalCauseParts({
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      })
    ).toEqual(['historyUnavailable'])
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts(
          {
            kind: 'refused',
            code: 'agent_session_operation_invalid',
            details: { reason: 'notSignedIn' }
          },
          { agentName: 'Claude' }
        )
      )
    ).toBe(
      "Claude isn't signed in. Run `claude auth login`, or choose an account in Claude Accounts settings."
    )
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts({
          kind: 'refused',
          code: 'agent_session_operation_invalid',
          details: { reason: 'providerStartFailed' }
        })
      )
    ).toBe('The agent stopped before it finished starting.')
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts({
          kind: 'refused',
          code: 'agent_session_operation_invalid',
          details: { reason: 'managedAccountUnsupported' }
        })
      )
    ).toBe(
      'While a Claude account is added in WSL, Claude chats need a Windows Claude account. Choose or add one in Claude Accounts settings.'
    )
  })

  it.each(['managed', 'system'] as const)(
    'retains the %s account when saving a refused message',
    (account) => {
      const refusal = {
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn', account }
      } as const
      const saved = agentSessionRefusalFailure(refusal)
      expect(saved.details).toEqual(refusal.details)
      const parts = agentSessionRefusalCauseParts(saved, { agentName: 'Claude' })
      expect(agentSessionWriteNoticeEnglish(parts)).toBe(
        agentSessionFailureSentence({ kind: 'notSignedIn', account }, 'rejection', {
          agentName: 'Claude'
        })
      )
    }
  )

  it('writes the same sentences as before where no Retry stands beside them', () => {
    expect(agentSessionFailureSentence({ kind: 'notSignedIn' }, 'rejection')).toBe(
      'The agent is not signed in. Sign in, then send your message again.'
    )
  })

  it.each<[string, AgentSessionWriteFailure]>([
    ['a refusal with no reason', { kind: 'refused', code: 'agent_session_operation_invalid' }],
    [
      "a reason whose code's words stand",
      { kind: 'refused', code: 'agent_session_conflict', details: { reason: 'ownerAlive' } }
    ],
    ['a failed request', { kind: 'failed' }],
    ['an unconfirmed one', { kind: 'unconfirmed' }]
  ])('names nothing for %s', (_label, failure) => {
    expect(agentSessionRefusalCauseParts(failure)).toEqual([])
  })
})

describe('saved Arguments refusals', () => {
  it('keeps generic launch copy when an older reader drops the new detail', () => {
    const wire = JSON.parse(
      JSON.stringify({
        code: 'agent_session_operation_invalid',
        details: {
          reason: 'attachFailed',
          argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
        }
      })
    )
    // The prior reader kept only its known reason and facts from details.
    const older = agentSessionRefusalFailure({
      code: wire.code,
      details: { reason: wire.details.reason }
    })
    expect(agentSessionRefusalCauseParts(older)).toEqual([])
    expect(agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts(older, 'send'))).toBe(
      'Your message was not sent.'
    )
  })

  it('keeps the validated cause after durable parsing and names the correction beside Retry', () => {
    const refused = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
      }
    })
    const parsed = parseAgentSessionWriteFailure(JSON.parse(JSON.stringify(refused)))
    if (!parsed) {
      throw new Error('saved refusal was not read')
    }
    expect(agentSessionWriteNoticeEnglish(agentSessionRefusalCauseParts(parsed))).toBe(
      "Codex couldn't start. Saved Arguments contain an unsupported option (--remote). Edit them in Settings > Agents > Arguments."
    )
  })

  it.each([
    { agent: 'Codex', option: '--remote', problem: 'futureProblem' },
    { agent: 'Codex', option: '--remote=private', problem: 'unsupportedOption' }
  ])('ignores an unrecognized or unsafe argument detail', (argumentProblem) => {
    const refused = parseAgentSessionWriteFailure({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed', argumentProblem }
    })
    expect(refused).toEqual({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed' }
    })
    if (!refused) {
      throw new Error('refusal was not read')
    }
    expect(agentSessionRefusalCauseParts(refused)).toEqual([])
  })
})
