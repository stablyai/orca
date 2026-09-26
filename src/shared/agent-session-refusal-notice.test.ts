import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from './agent-session-wire-refusals'
import {
  agentSessionRefusalNotice,
  agentSessionWriteFailureNotice,
  parseAgentSessionWriteFailure,
  type AgentSessionWriteKind
} from './agent-session-refusal-notice'

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

  it('does not claim a restart for a chat whose owner is unsettled', () => {
    for (const code of [
      'agent_session_checkpoint_stale',
      'agent_session_conflict',
      'agent_session_ownership_unknown',
      'execution_owner_reconciling'
    ] as const) {
      expect(agentSessionRefusalNotice({ code, message: HOST_TEXT }, 'send')).toBe(
        "Orca couldn't confirm which agent process owns this chat. Your message was not sent. Retry to send it again."
      )
    }
    expect(
      agentSessionRefusalNotice({ code: 'agent_session_conflict', message: HOST_TEXT }, 'stop')
    ).toBe(
      "Orca couldn't confirm which agent process owns this chat. The agent wasn't stopped. Press Stop again."
    )
  })

  // The code alone does not say why (a cleared conversation, a pending question, a provider's
  // own rejection), and trying again can repeat the refusal.
  it.each([
    ['send', 'Your message was not sent.'],
    ['composer-send', 'Your message was not sent.'],
    ['command', "The command didn't run."],
    ['goal', "The goal wasn't changed."],
    ['answer', 'Your answer was not sent.'],
    ['option', "The setting wasn't changed."]
  ] as const)('offers no next step for an invalid %s', (write, expected) => {
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_operation_invalid',
          message: 'This conversation has been cleared. Use the current conversation.'
        },
        write
      )
    ).toBe(expected)
  })

  it('tells the phone to send a refused message again rather than press Retry', () => {
    expect(
      agentSessionRefusalNotice(
        { code: 'agent_session_checkpoint_stale', message: HOST_TEXT },
        'composer-send'
      )
    ).toBe(
      "Orca couldn't confirm which agent process owns this chat. Your message was not sent. Send it again."
    )
    expect(agentSessionWriteFailureNotice('composer-send')).toBe(
      "Orca couldn't reach the agent. Send it again."
    )
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
    expect(parseAgentSessionWriteFailure({ kind: 'unreachable' })).toEqual({ kind: 'unreachable' })
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
