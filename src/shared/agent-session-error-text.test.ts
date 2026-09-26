import { describe, expect, it } from 'vitest'
import { agentSessionErrorText } from './agent-session-error-text'

describe('agentSessionErrorText', () => {
  it('reads a stream failure payload by its message, not as [object Object]', () => {
    expect(agentSessionErrorText({ code: 'runtime_error', message: 'journal unreadable' })).toBe(
      'journal unreadable'
    )
  })

  it('reads a thrown error by its message, without the class-name prefix', () => {
    expect(agentSessionErrorText(new Error('journal read failed'))).toBe('journal read failed')
  })

  it('falls back to the code, then to the caller fallback', () => {
    expect(agentSessionErrorText({ code: 'agent_session_ownership_unknown' })).toBe(
      'agent_session_ownership_unknown'
    )
    expect(agentSessionErrorText({}, 'Request was not sent')).toBe('Request was not sent')
    expect(agentSessionErrorText(undefined, 'Request was not sent')).toBe('Request was not sent')
    expect(agentSessionErrorText('plain text')).toBe('plain text')
  })
})
