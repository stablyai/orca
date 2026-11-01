import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce((text, [k, v]) => text.replace(`{{${k}}}`, v), fallback)
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

const { ProviderSegment } = await import('./StatusBarProviderSegment')
const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
})

function lapsedClaude(ageMs: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: NOW - ageMs,
    error: 'Claude usage updates the next time Claude runs.',
    status: 'error',
    usageMetadata: { failureKind: 'stale-token' }
  }
}

it.each([
  ['stays calm over recent kept bars', 5 * 60_000, false],
  ['warns once kept bars are older than 30 minutes', 2 * 60 * 60_000, true]
])('Claude lapsed-token chip %s', (_, ageMs, warns) => {
  const markup = renderToStaticMarkup(
    <ProviderSegment p={lapsedClaude(ageMs)} compact={false} display="used" mode="compact" />
  )
  expect(markup).toContain('40%')
  expect(/triangle/i.test(markup)).toBe(warns)
})
