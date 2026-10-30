import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_WIRE_REFUSAL_CODES } from './agent-session-wire'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'
import { isDefinitiveAgentSessionCreateRefusal } from './agent-session-definitive-refusal'

describe('definitive agent-session create refusals', () => {
  it('never treats an unproven outcome as definitive', () => {
    expect(isDefinitiveAgentSessionCreateRefusal('agent_session_operation_unknown')).toBe(false)
    expect(isDefinitiveAgentSessionCreateRefusal('agent_session_ownership_unknown')).toBe(false)
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
    // Settlement calls this pending-admission; reusing that classifier would wrongly prevent fallback.
    expect(agentSessionRefusalOperationState('structured_agent_session_unsupported')).toBe(
      'pending-admission'
    )
    expect(isDefinitiveAgentSessionCreateRefusal('structured_agent_session_unsupported')).toBe(true)
  })

  // Transport/client-minted codes cannot authorize fallback.
  it.each([
    'runtime_error',
    'timeout',
    '',
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'runtime_manually_disconnected',
    'runtime_rpc_queue_overloaded',
    'method_not_supported',
    'invalid_argument',
    null,
    undefined
  ])('does not count %s as definitive', (code) => {
    expect(isDefinitiveAgentSessionCreateRefusal(code)).toBe(false)
  })
})
