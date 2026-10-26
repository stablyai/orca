import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CURSOR_MODELS_BUCKET_NAME,
  CURSOR_OTHER_MODELS_BUCKET_NAME
} from '../../../../shared/cursor-usage-buckets'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

function windowOf(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: 43_200, resetsAt: null, resetDescription: null }
}

function cursorLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    monthly: windowOf(92),
    buckets: [
      { name: CURSOR_MODELS_BUCKET_NAME, ...windowOf(45) },
      { name: CURSOR_OTHER_MODELS_BUCKET_NAME, ...windowOf(50) }
    ],
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('Cursor status-bar segment', () => {
  it('renders both plan pools instead of filtering them out as unknown buckets', async () => {
    // Cursor’s whole-meter pools must bypass Gemini’s experimental-model allowlist.
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment p={cursorLimits()} compact={false} display="used" mode="verbose" />
    )
    expect(markup).toContain(CURSOR_MODELS_BUCKET_NAME)
    expect(markup).toContain(CURSOR_OTHER_MODELS_BUCKET_NAME)
    expect(markup).toContain('45%')
    expect(markup).toContain('50%')
  })

  it('falls back to the plan total when no bucket is renderable', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    const markup = renderToStaticMarkup(
      <ProviderSegment
        p={cursorLimits({ buckets: [{ name: 'Unknown pool', ...windowOf(70) }] })}
        compact={false}
        display="used"
        mode="verbose"
      />
    )
    expect(markup).not.toContain('Unknown pool')
    expect(markup).toContain('92%')
  })
})

describe('getWindowSections for Cursor', () => {
  it('keeps the plan total beside the pools', async () => {
    // Cursor’s monthly plan total can be nearer the cap than individual buckets.
    const { getWindowSections } = await import('./tooltip')
    const sections = getWindowSections(cursorLimits())
    expect(sections.find((section) => section.label === 'Plan')?.window?.usedPercent).toBe(92)
    expect(sections.map((section) => section.label)).toContain(CURSOR_MODELS_BUCKET_NAME)
  })

  it('leaves other providers unchanged when they report no monthly window', async () => {
    const { getWindowSections } = await import('./tooltip')
    const sections = getWindowSections(cursorLimits({ monthly: null, provider: 'gemini' }))
    expect(sections.some((section) => section.label === 'Plan')).toBe(false)
  })
})
