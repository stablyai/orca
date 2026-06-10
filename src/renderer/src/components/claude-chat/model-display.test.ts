import { describe, it, expect } from 'vitest'
import { describeModel } from './model-display'

describe('describeModel', () => {
  it('handles claude-fable-5[1m]', () => {
    const result = describeModel('claude-fable-5[1m]')
    expect(result.name).toBe('Fable 5')
    expect(result.description).toBe(
      'Most capable for your hardest and longest-running tasks · 1M context'
    )
  })

  it('handles claude-opus-4-8[1m]', () => {
    const result = describeModel('claude-opus-4-8[1m]')
    expect(result.name).toBe('Opus 4.8')
    expect(result.description).toBe('Most capable for complex tasks · 1M context')
  })

  it('handles claude-haiku-4-5-20251001', () => {
    const result = describeModel('claude-haiku-4-5-20251001')
    expect(result.name).toBe('Haiku 4.5')
    expect(result.description).toBe('Fastest for quick answers')
  })

  it('handles claude-sonnet-4-6', () => {
    const result = describeModel('claude-sonnet-4-6')
    expect(result.name).toBe('Sonnet 4.6')
    expect(result.description).toBe('Efficient for routine tasks')
  })

  it('falls back to raw id for unknown family', () => {
    const result = describeModel('some-unknown-model-1')
    expect(result.name).toBe('Some Unknown Model 1')
    expect(result.description).toBe('some-unknown-model-1')
  })
})
