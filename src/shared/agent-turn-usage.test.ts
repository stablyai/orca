import { describe, expect, it } from 'vitest'
import {
  agentTurnUsageEqual,
  agentTurnUsagePromptTokens,
  normalizeAgentTurnUsage
} from './agent-turn-usage'

describe('agent turn usage', () => {
  const usage = {
    inputTokens: 616,
    outputTokens: 138,
    cacheReadTokens: 85906,
    cacheWriteTokens: 589,
    durationMs: 12632
  }

  it('compares every usage field structurally, including absence and zero', () => {
    expect(agentTurnUsageEqual(undefined, undefined)).toBe(true)
    expect(agentTurnUsageEqual(usage, { ...usage })).toBe(true)
    expect(agentTurnUsageEqual(usage, undefined)).toBe(false)
    expect(agentTurnUsageEqual(undefined, usage)).toBe(false)
    for (const key of Object.keys(usage)) {
      expect(agentTurnUsageEqual(usage, { ...usage, [key]: 0 })).toBe(false)
    }
    expect(
      agentTurnUsageEqual(
        { inputTokens: 0, outputTokens: 0 },
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0
        }
      )
    ).toBe(false)
  })

  it('sums uncached and cached prompt tokens with absent counts treated as zero', () => {
    expect(agentTurnUsagePromptTokens(usage)).toBe(87111)
    expect(agentTurnUsagePromptTokens({ inputTokens: 0, outputTokens: 138 })).toBe(0)
    expect(normalizeAgentTurnUsage(null)).toBeUndefined()
    expect(normalizeAgentTurnUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0
    })
  })
})
