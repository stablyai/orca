import { describe, expect, it } from 'vitest'
import {
  estimateAntigravityUsageUsd,
  readAntigravityTranscriptUsage
} from './antigravity-transcript-usage'

const usage = {
  step: 1,
  model: 'explicit-model',
  createdAt: '2026-11-16T00:00:00Z',
  inputTokens: 1_000_000,
  cacheReadTokens: 2_000_000,
  outputTokens: 500_000,
  totalTokens: 3_500_000
}
const prices = { inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 10 }

describe('Antigravity API-equivalent estimation', () => {
  it('prices separate cached reads without subtracting them from fresh input', () => {
    expect(estimateAntigravityUsageUsd(usage, prices)).toBe(7.4)
  })

  it('keeps missing models, missing rates and invalid prices unknown', () => {
    expect(estimateAntigravityUsageUsd({ ...usage, model: null }, prices)).toBeNull()
    expect(estimateAntigravityUsageUsd(usage, undefined)).toBeNull()
    expect(estimateAntigravityUsageUsd(usage, { ...prices, inputUsdPerMillion: -1 })).toBeNull()
    expect(
      estimateAntigravityUsageUsd(usage, { ...prices, outputUsdPerMillion: Infinity })
    ).toBeNull()
  })

  it('rejects overflowing and stringified token counts at the transcript boundary', () => {
    const record = {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      step_index: 0,
      input_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_tokens: 1,
      output_tokens: 0
    }
    expect(readAntigravityTranscriptUsage(record)).toBeNull()
    expect(readAntigravityTranscriptUsage({ ...record, input_tokens: '100' })).toBeNull()
  })
})
