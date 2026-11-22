import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from '../rate-limits/rate-limit-types'
import { getUsageWindowSections } from './usage-provider-windows'

function window(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function sectionNames(sections: ReturnType<typeof getUsageWindowSections>): string[] {
  return sections.map((s) => (s.kind === 'bucket' ? s.name : s.kind))
}

describe('getUsageWindowSections', () => {
  it('omits the weekly rollup when buckets already report weekly windows', () => {
    const sections = getUsageWindowSections({
      provider: 'antigravity',
      session: window(5, 300),
      weekly: window(42, 10_080),
      buckets: [
        { ...window(42, 10_080), name: 'Gemini Models · Weekly' },
        { ...window(5, 300), name: 'Gemini Models · Five Hour' }
      ]
    })

    expect(sectionNames(sections)).toEqual(['Gemini Models · Weekly', 'Gemini Models · Five Hour'])
  })

  it('keeps the weekly rollup when no weekly bucket repeats it', () => {
    const sections = getUsageWindowSections({
      provider: 'antigravity',
      session: window(5, 300),
      weekly: window(42, 10_080),
      buckets: [
        { ...window(30, 10_080), name: 'Gemini Models · Weekly' },
        { ...window(5, 300), name: 'Gemini Models · Five Hour' }
      ]
    })

    expect(sectionNames(sections)).toEqual([
      'Gemini Models · Weekly',
      'Gemini Models · Five Hour',
      'weekly'
    ])
  })
})
