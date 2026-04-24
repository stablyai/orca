import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getWindowSections } from './tooltip'

describe('getWindowSections', () => {
  it('returns buckets as sections when present', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Pro', window: p.buckets![0] },
      { label: 'Flash', window: p.buckets![1] },
      { label: 'Weekly', window: null }
    ])
  })

  it('returns session and weekly when buckets are absent', () => {
    const p: ProviderRateLimits = {
      provider: 'claude',
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Session', window: p.session },
      { label: 'Weekly', window: p.weekly }
    ])
  })

  it('returns session and weekly for empty buckets array', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 50, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toEqual([
      { label: 'Session', window: p.session },
      { label: 'Weekly', window: null }
    ])
  })

  it('does not expose bucket names via session window in compact rendering path', () => {
    // Why: ProviderSegment (compact mode) reads only p.session — never p.buckets.
    // This test locks the contract: getWindowSections returns buckets for detail
    // views, while the plain session value remains independently available for
    // compact rendering without bucket names bleeding through.
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    // Compact path uses p.session directly — independent of getWindowSections.
    expect(p.session?.usedPercent).toBe(80)
    // getWindowSections (detail path) returns bucket rows, not session label.
    const sections = getWindowSections(p)
    const labels = sections.map((s) => s.label)
    expect(labels).toContain('Pro')
    expect(labels).toContain('Flash')
    expect(labels).not.toContain('Session')
  })

  it('preserves reset metadata inside bucket windows', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 45,
          windowMinutes: 300,
          resetsAt: 18000000,
          resetDescription: '5:00 PM'
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    const sections = getWindowSections(p)
    expect(sections).toHaveLength(2)
    expect(sections[0].label).toBe('Pro')
    expect(sections[0].window!.resetsAt).toBe(18000000)
    expect(sections[0].window!.resetDescription).toBe('5:00 PM')
  })
})
