import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

function makeWindow(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: null,
    resetDescription: null
  }
}

function makeLimits(
  provider: ProviderRateLimits['provider'],
  windows: Partial<Pick<ProviderRateLimits, 'session' | 'weekly' | 'monthly'>>
): ProviderRateLimits {
  return {
    provider,
    session: windows.session ?? null,
    weekly: windows.weekly ?? null,
    ...(windows.monthly ? { monthly: windows.monthly } : {}),
    updatedAt: 1795100000000,
    error: null,
    status: 'ok'
  }
}

describe('getStatusBarUsageSections', () => {
  it('shows both session and monthly in verbose mode when a provider has no weekly window', () => {
    const kimi = makeLimits('kimi', {
      session: makeWindow(10, 300),
      monthly: makeWindow(42, 43200)
    })

    const sections = getStatusBarUsageSections(kimi, 'verbose')

    expect(sections.map((section) => [section.key, section.label])).toEqual([
      ['session', '5h'],
      ['monthly', '30d']
    ])
  })

  it('keeps monthly out of verbose mode when the provider already shows a weekly window', () => {
    const opencodeGo = makeLimits('opencode-go', {
      session: makeWindow(10, 300),
      weekly: makeWindow(25, 10080),
      monthly: makeWindow(42, 43200)
    })

    const sections = getStatusBarUsageSections(opencodeGo, 'verbose')

    expect(sections.map((section) => section.key)).toEqual(['session', 'weekly'])
  })

  it('keeps scoped ZCode monthly MCP quota out of verbose mode even without a weekly window', () => {
    const zcode = makeLimits('zcode', {
      session: makeWindow(10, 300),
      monthly: makeWindow(55, 43200)
    })

    const sections = getStatusBarUsageSections(zcode, 'verbose')

    expect(sections.map((section) => section.key)).toEqual(['session'])
  })
})
