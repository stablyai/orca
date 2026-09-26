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
  it('never shows the host diagnostic for any code the host words for itself', () => {
    for (const code of AGENT_SESSION_WIRE_REFUSAL_CODES) {
      if (code === 'agent_session_owner_restart_failed') {
        continue
      }
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
        { code: 'agent_session_operation_capacity', message: HOST_TEXT },
        'composer-send'
      )
    ).toBe(
      'Orca is handling too many requests for this chat. Your message was not sent. Send it again.'
    )
    expect(agentSessionWriteFailureNotice('composer-send')).toBe(
      "Orca couldn't reach the agent. Send it again."
    )
  })

  it("keeps the host's own words for an agent that could not restart", () => {
    const message = "Claude couldn't restart: not logged in. Start a new chat to continue."
    expect(
      agentSessionRefusalNotice({ code: 'agent_session_owner_restart_failed', message }, 'send')
    ).toBe(message)
    expect(
      agentSessionRefusalNotice(
        { code: 'agent_session_owner_restart_failed', message: ' ' },
        'send'
      )
    ).toBe('Your message was not sent. Retry to send it again.')
  })

  it('says only what did not happen for a code from a newer host', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","message":"internal"}')
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe("The agent wasn't stopped.")
  })
})

describe('parseAgentSessionWriteFailure', () => {
  it('reads back what was saved, and keeps host words only for a failed restart', () => {
    expect(
      parseAgentSessionWriteFailure(
        JSON.parse(JSON.stringify({ kind: 'refused', code: 'agent_session_conflict' }))
      )
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
    expect(parseAgentSessionWriteFailure({ kind: 'unreachable' })).toEqual({ kind: 'unreachable' })
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_owner_restart_failed',
        hostMessage: "Claude couldn't restart."
      })
    ).toEqual({
      kind: 'refused',
      code: 'agent_session_owner_restart_failed',
      hostMessage: "Claude couldn't restart."
    })
    expect(
      parseAgentSessionWriteFailure({
        kind: 'refused',
        code: 'agent_session_conflict',
        hostMessage: HOST_TEXT
      })
    ).toEqual({ kind: 'refused', code: 'agent_session_conflict' })
  })

  it.each([
    null,
    'The agent was restarting.',
    { kind: 'refused' },
    { kind: 'refused', code: 'agent_session_from_the_future' },
    { kind: 'refused', code: 'agent_session_owner_restart_failed', hostMessage: 3 },
    { kind: 'something-else' }
  ])('drops %j instead of guessing', (value) => {
    expect(parseAgentSessionWriteFailure(value)).toBeUndefined()
  })
})
