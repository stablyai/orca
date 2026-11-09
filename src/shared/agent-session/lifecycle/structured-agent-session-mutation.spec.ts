import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from './agent-session-mutation-envelope'

describe('structured agent session client mutations', () => {
  it('matches host code-unit ordering for mixed-case and non-ASCII keys', () => {
    const input = {
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { a: 1, A: 2, é: 3, 中: 4 }
    }

    expect(structuredAgentSessionPayloadFingerprint(input)).toBe(
      computeAgentSessionPayloadFingerprint(input)
    )
  })
})
