import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from './agent-session-mutation-envelope'

describe('structured agent session client mutations', () => {
  it('canonicalizes payload fields before hashing', () => {
    const first = structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { body: { role: 'user', kind: 'message' }, omitted: undefined }
    })
    const second = structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { body: { kind: 'message', role: 'user' } }
    })

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

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
