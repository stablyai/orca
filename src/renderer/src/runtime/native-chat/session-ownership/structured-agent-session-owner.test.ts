import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTargetForHost } from './structured-agent-session-owner'

describe('structuredAgentSessionTargetForHost', () => {
  // A non-string host id reached render and threw `e?.trim is not a function` (crash d1e50ca3).
  it('serves no runtime for a non-string host id instead of throwing', () => {
    expect(structuredAgentSessionTargetForHost(42)).toBeNull()
    expect(structuredAgentSessionTargetForHost({ id: 'local' })).toBeNull()
  })
})
