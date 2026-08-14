import { describe, expect, it } from 'vitest'
import {
  showStructuredAgentSessionChoice,
  structuredAgentSessionPayloadFingerprint
} from './structured-agent-session-mutation'

describe('structured agent session client mutations', () => {
  it('keeps the chat choice invisible without both capability and workspace support', () => {
    expect(
      showStructuredAgentSessionChoice({
        hostCapability: false,
        workspaceSupport: true,
        agent: 'codex'
      })
    ).toBe(false)
    expect(
      showStructuredAgentSessionChoice({
        hostCapability: true,
        workspaceSupport: false,
        agent: 'codex'
      })
    ).toBe(false)
    expect(
      showStructuredAgentSessionChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'claude'
      })
    ).toBe(false)
    expect(
      showStructuredAgentSessionChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'codex'
      })
    ).toBe(true)
  })

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
})
