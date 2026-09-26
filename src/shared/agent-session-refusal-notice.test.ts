import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from './agent-session-wire-refusals'
import {
  agentSessionRefusalNotice,
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

  it('says what did not happen and how to try again for the idle-restart refusal', () => {
    expect(
      agentSessionRefusalNotice(
        { code: 'agent_session_checkpoint_stale', message: HOST_TEXT },
        'send'
      )
    ).toBe('The agent was restarting. Your message was not sent. Retry to send it again.')
    expect(
      agentSessionRefusalNotice(
        { code: 'agent_session_checkpoint_stale', message: HOST_TEXT },
        'stop'
      )
    ).toBe("The agent was restarting. The agent wasn't stopped. Press Stop again.")
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
  it('still says something for a code from a newer host', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","message":"internal"}')
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe(
      "The agent wasn't stopped. Press Stop again."
    )
  })
})
