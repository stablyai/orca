import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from './agent-session-wire'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'
import { isDefinitiveAgentSessionCreateRefusal } from './agent-session-definitive-refusal'

describe('definitive agent-session create refusals', () => {
  it('treats an unsupported structured session as definitive', () => {
    expect(isDefinitiveAgentSessionCreateRefusal('structured_agent_session_unsupported')).toBe(true)
  })

  it('never treats an unproven outcome as definitive', () => {
    expect(isDefinitiveAgentSessionCreateRefusal('agent_session_operation_unknown')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('agent_session_ownership_unknown')).toBe(false)
  })

  it('leaves transport failures, timeouts and a missing code unknown', () => {
    expect(isDefinitiveAgentSessionCreateRefusal('runtime_error')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('remote_runtime_unavailable')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('timeout')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('runtime_timeout')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal(undefined)).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal(null)).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('')).toBe(false)
  })

  it('counts a method an old host never registered as definitive', () => {
    expect(isDefinitiveAgentSessionCreateRefusal('method_not_found')).toBe(true)
  })

  it('is an allowlist: every other wire refusal code is unknown', () => {
    const definitive = AGENT_SESSION_WIRE_REFUSAL_CODES.filter((code) =>
      isDefinitiveAgentSessionCreateRefusal(code)
    )
    expect(definitive).toEqual(['structured_agent_session_unsupported'])
  })

  it('does not answer the durable-settlement question, which disagrees on the one code that matters', () => {
    // Guards the reuse this allowlist exists to avoid: settlement state calls the definitive
    // refusal pending-admission, which would rule out the fallback it is meant to allow.
    expect(
      agentSessionRefusalOperationState(
        'agentSession.create',
        'structured_agent_session_unsupported'
      )
    ).toBe('pending-admission')
    expect(isDefinitiveAgentSessionCreateRefusal('structured_agent_session_unsupported')).toBe(true)
  })
})
