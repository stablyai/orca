import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusEvent } from './normalize-agent-status-event'

describe('normalizeAgentStatusEvent', () => {
  it('preserves tool-output provenance for native chat gating', () => {
    const normalized = normalizeAgentStatusEvent({
      paneKey: 'tab-1:1',
      state: 'working',
      prompt: 'inspect the failure',
      agentType: 'claude',
      lastAssistantMessage: 'Exit code 1\nraw output',
      lastAssistantMessageIsToolOutput: true,
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1
    })

    expect(normalized?.lastAssistantMessageIsToolOutput).toBe(true)
  })
})
