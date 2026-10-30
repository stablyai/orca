// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import UsageDashboardQuotaStrip from './UsageDashboardQuotaStrip'

vi.mock('../status-bar/icons', () => ({
  ClaudeIcon: () => null,
  GeminiIcon: () => null,
  MiniMaxIcon: () => null,
  OpenAIIcon: () => null,
  OpenCodeGoIcon: () => null
}))

function provider(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('UsageDashboardQuotaStrip', () => {
  it('renders one row per provider with its windows and reset countdown', () => {
    // Fake the clock so the countdown label is derived from a fixed "now" instead of the wall clock.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))
    const resetsAt = Date.now() + 2 * 60 * 60 * 1000
    const view = render(
      <UsageDashboardQuotaStrip
        display="used"
        providers={[
          provider({
            provider: 'claude',
            planType: 'max_5x',
            session: { usedPercent: 42, windowMinutes: 300, resetsAt, resetDescription: null },
            weekly: {
              usedPercent: 12,
              windowMinutes: 10_080,
              resetsAt: null,
              resetDescription: null
            }
          }),
          provider({
            provider: 'codex',
            monthly: {
              usedPercent: 80,
              windowMinutes: 43_200,
              resetsAt: null,
              resetDescription: null
            }
          })
        ]}
      />
    )

    expect(view.container.querySelectorAll('[data-quota-provider]')).toHaveLength(2)
    expect(
      view.container.querySelector('[data-quota-provider="claude"] [data-usage-window="Session"]')
    ).not.toBeNull()
    expect(
      view.container.querySelector('[data-quota-provider="claude"] [data-usage-window="Weekly"]')
    ).not.toBeNull()
    expect(
      view.container.querySelector('[data-quota-provider="codex"] [data-usage-window="Monthly"]')
    ).not.toBeNull()
    expect(screen.getByText(/Max 5x/)).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('12%')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText(/^Resets in /)).toBeInTheDocument()
  })

  it('shows remaining capacity when the display preference asks for it', () => {
    render(
      <UsageDashboardQuotaStrip
        display="remaining"
        providers={[
          provider({
            session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null }
          })
        ]}
      />
    )

    expect(screen.getByText('80%')).toBeInTheDocument()
  })

  it('renders the empty placeholder when no provider reports a subscription window', () => {
    const view = render(<UsageDashboardQuotaStrip display="used" providers={[provider({})]} />)

    expect(view.container.querySelectorAll('[data-quota-provider]')).toHaveLength(0)
    expect(screen.getByText('No subscription quotas reported yet.')).toBeInTheDocument()
  })
})
