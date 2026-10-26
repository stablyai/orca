import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { normalizeAgentStatusEvent } from './normalize-agent-status-event'

describe('normalizeAgentStatusEvent usage', () => {
  const payload: AgentStatusIpcPayload = {
    paneKey: 'tab-1:1',
    state: 'done',
    prompt: 'p',
    agentType: 'jcode',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1
  }

  it('preserves last turn usage from the host', () => {
    const usage = {
      inputTokens: 616,
      outputTokens: 138,
      cacheReadTokens: 85906,
      cacheWriteTokens: 589,
      durationMs: 12632
    }
    expect(normalizeAgentStatusEvent({ ...payload, lastTurnUsage: usage })?.lastTurnUsage).toEqual(
      usage
    )
  })

  it('keeps old-shape payloads without a lastTurnUsage key', () => {
    const normalized = normalizeAgentStatusEvent(payload)
    expect(normalized).not.toBeNull()
    expect(normalized).not.toHaveProperty('lastTurnUsage')
  })
})
