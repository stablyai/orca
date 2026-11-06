import { describe, expect, it } from 'vitest'
import { agentSessionFailureSentence } from '../failures/agent-session-failure-words'

describe('agent-specific sign-in guidance', () => {
  it('keeps diagnostic text literal and keeps log-only detail off the visible sentence', () => {
    const detail = 'No API key found for {{agent}} $t(fake.key)'
    expect(
      agentSessionFailureSentence(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'person' } },
        'rejection',
        { agentName: 'Pi' }
      )
    ).toContain(detail)
    expect(
      agentSessionFailureSentence(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'log' } },
        'row',
        { agentName: 'Pi' }
      )
    ).not.toContain(detail)
  })
})
