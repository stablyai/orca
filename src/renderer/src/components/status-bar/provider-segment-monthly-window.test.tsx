import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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

vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { usagePercentageDisplay: 'used' | 'remaining' }) => unknown) =>
    selector({ usagePercentageDisplay: 'used' })
}))

function windowOf(
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null = null
): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

describe('undefined provider window safety (crash d2c1da69 / bb74236c)', () => {
  // A partial/rehydrated provider can carry an undefined (not null) window even
  // though the type declares `session`/`weekly` as `RateLimitWindow | null`. The
  // old `s.window !== null` filter let the undefined-window section through, so
  // getTightestUsageSection's reduce read `.usedPercent` of undefined and crashed
  // the status-bar overlay (TypeError in ProviderSegment).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberately omit session to reproduce malformed persisted provider data.
  const partialProvider = {
    provider: 'codex',
    weekly: windowOf(42, 10080),
    updatedAt: 0,
    error: null,
    status: 'ok'
  } as unknown as ProviderRateLimits // `session` omitted -> undefined at runtime

  it('ProviderSegment renders without crashing when a provider window is undefined', async () => {
    const { ProviderSegment } = await import('./StatusBar')
    expect(() =>
      renderToStaticMarkup(
        <ProviderSegment p={partialProvider} compact={false} display="used" mode="compact" />
      )
    ).not.toThrow()
  })
})
