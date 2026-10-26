import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusPayload } from './agent-status-types'
import { parseAgentStatusIpcPayloadCopy } from './agent-status-store-status-codec'

describe('status codec usage compatibility', () => {
  const base = {
    state: 'done',
    prompt: 'p',
    agentType: 'jcode',
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 900
  }
  const usage = {
    inputTokens: 616,
    outputTokens: 138,
    cacheReadTokens: 85906,
    cacheWriteTokens: 589,
    durationMs: 12632
  }

  it('round-trips old-shape status without usage', () => {
    const parsed = parseAgentStatusIpcPayloadCopy(base)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('lastTurnUsage')
    expect(parseAgentStatusIpcPayloadCopy(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  it('keeps new-shape usage and adds nothing else', () => {
    const oldShape = parseAgentStatusIpcPayloadCopy(base)
    expect(oldShape).not.toBeNull()
    expect(
      parseAgentStatusIpcPayloadCopy({ ...base, lastTurnUsage: { ...usage, extra: 1 } })
    ).toEqual({ ...oldShape, lastTurnUsage: usage })
  })

  it('drops a bad optional field alone and strips unknown keys', () => {
    const parsed = normalizeAgentStatusPayload({
      state: 'done',
      prompt: '',
      lastTurnUsage: {
        inputTokens: 616,
        outputTokens: 138,
        cacheReadTokens: 'x',
        durationMs: -5,
        promptTokens: 87111,
        extra: 1
      }
    })
    expect(parsed?.lastTurnUsage).toEqual({ inputTokens: 616, outputTokens: 138 })
  })
})
