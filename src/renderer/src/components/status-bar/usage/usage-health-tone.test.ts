import { describe, expect, it } from 'vitest'
import { getUsageHealthTone } from './usage-health-tone'

describe('getUsageHealthTone', () => {
  it('is green below 80% used, yellow from 80%, red from 90%', () => {
    expect(getUsageHealthTone(0)).toBe('healthy')
    expect(getUsageHealthTone(79)).toBe('healthy')
    expect(getUsageHealthTone(80)).toBe('warning')
    expect(getUsageHealthTone(89)).toBe('warning')
    expect(getUsageHealthTone(90)).toBe('urgent')
    expect(getUsageHealthTone(100)).toBe('urgent')
  })

  it('rounds like the displayed number so color and digits agree', () => {
    expect(getUsageHealthTone(79.4)).toBe('healthy')
    expect(getUsageHealthTone(79.5)).toBe('warning')
    expect(getUsageHealthTone(89.5)).toBe('urgent')
  })
})
