import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'
import {
  agentSessionRefusalNotice,
  agentSessionWriteFailureNotice,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts,
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteNoticeSentence
} from './agent-session-refusal-notice'
import {
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionRejectionParts } from './structured-agent-session-send-disposition'

const WRITES: AgentSessionWriteKind[] = [
  'send',
  'composer-send',
  'stop',
  'answer',
  'option',
  'command',
  'goal'
]
const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'
const FAILURES: AgentSessionWriteFailure[] = [
  ...AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) => ({ kind: 'refused' as const, code })),
  { kind: 'failed' }
]

// A cause is named only where every host emitter of the code means it; any other code says only
// what did not happen, because one code covers owner states or reasons the client cannot tell apart.
const CAUSES: Partial<Record<AgentSessionWireRefusalCode, AgentSessionWriteNoticeSentence>> = {
  // Only send preparation, when the owner it restarted for this send failed to start.
  agent_session_owner_restart_failed: 'restartFailed',
  // Only the ledger, when a day's retained operation ids fill a client's or the host's quota.
  agent_session_operation_capacity: 'capacity',
  // A replayed operation with no recorded outcome, or a send behind a rewind whose outcome is
  // unrecorded: either way Orca cannot say what happened.
  agent_session_operation_unknown: 'outcomeUnknown',
  // Only the pending-prompt check.
  agent_session_item_revision_stale: 'questionChanged',
  agent_session_already_resolved: 'questionChanged',
  // No emitter on this host; the code names nothing else.
  agent_session_journal_unreadable: 'historyUnreadable',
  // On these writes, only an older host, or the phone reading an unknown method.
  structured_agent_session_unsupported: 'unsupported'
}

function isCause(part: unknown): boolean {
  return typeof part === 'string' && !part.startsWith('notDone') && part !== 'tryAgainComposerSend'
}

describe('agentSessionRefusalNotice', () => {
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
  // - ownership_unknown: "The session attached without a provider child to write to." (holds)
  // - item_revision_stale / already_resolved: "Item <id> has moved on." (prompt-state)
  // - owner_restart_failed: "<agent> couldn't restart: <cause>.", where the cause is the resume's
  //   own refusal message, including the ledger's (send-preparation, hold-resume)
  // - journal_unreadable: no emitter on this host; an older or newer one may send it.
  it('never shows the host message, for any code or write', () => {
    for (const code of AGENT_SESSION_WIRE_REFUSAL_CODES) {
      for (const write of WRITES) {
        const notice = agentSessionRefusalNotice({ code, message: HOST_TEXT }, write)
        expect(notice).not.toContain('fence')
        expect(notice.length).toBeGreaterThan(0)
      }
    }
  })

  it('names a cause only for a code on the allowlist', () => {
    for (const code of AGENT_SESSION_WIRE_REFUSAL_CODES) {
      for (const write of WRITES) {
        const causes = agentSessionWriteNoticeParts({ kind: 'refused', code }, write).filter(
          isCause
        )
        expect(causes).toEqual(CAUSES[code] ? [CAUSES[code]] : [])
      }
    }
    for (const write of WRITES) {
      expect(agentSessionWriteNoticeParts({ kind: 'failed' }, write).filter(isCause)).toEqual([])
    }
  })

  // The control that sent the write is how to try again; only the phone's composer has none.
  it('says how to try again only on the phone, or to update Orca', () => {
    for (const failure of FAILURES) {
      for (const write of WRITES) {
        const notice = agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts(failure, write))
        const allowed =
          write === 'composer-send' ||
          (failure.kind === 'refused' && failure.code === 'structured_agent_session_unsupported')
        if (!allowed) {
          expect(notice).not.toMatch(/again/i)
        }
      }
    }
    for (const reason of [null, DISPATCH_REJECTED_WRITE_FAILED, DISPATCH_REJECTED_QUEUE_FULL]) {
      expect(
        agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, 'send'))
      ).not.toMatch(/again/i)
    }
  })

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

  it('says only what did not happen for a code from a newer host', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","message":"internal"}')
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe("The agent wasn't stopped.")
  })
})

describe('parseAgentSessionWriteFailure', () => {
  it('reads back what was saved, and nothing but the code', () => {
    expect(
      parseAgentSessionWriteFailure(
        JSON.parse(JSON.stringify({ kind: 'refused', code: 'agent_session_conflict' }))
      )
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
    expect(parseAgentSessionWriteFailure({ kind: 'failed' })).toEqual({ kind: 'failed' })
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_conflict',
        message: HOST_TEXT
      })
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
  })

  it.each([
    null,
    'The agent was restarting.',
    { kind: 'refused' },
    { kind: 'refused', code: 'agent_session_from_the_future' },
    { kind: 'something-else' }
  ])('drops %j instead of guessing', (value) => {
    expect(parseAgentSessionWriteFailure(value)).toBeUndefined()
  })
})
